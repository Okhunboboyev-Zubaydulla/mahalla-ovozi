import React, { useState, useRef, useEffect, useContext } from 'react';
import { Button, Grid } from 'antd';
import {
  LeftOutlined,
  RightOutlined,
  FileTextOutlined,
  CrownOutlined,
  HomeOutlined,
  AppstoreOutlined,
  EnvironmentOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { HokimTopicStatisticsResponse, TopicStatisticCard1Comparison } from '@mahalla-ovozi/api-contracts';
import { TopicStatisticCard } from './TopicStatisticCard.js';
import { LANE_LABELS } from './TopicCard.js';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion.js';
import { LiveAnnouncerContext } from '../../hooks/useLiveAnnouncer.js';

const { useBreakpoint } = Grid;

interface CardDescriptor {
  id: string;
  title: string;
  value: string | number;
  subtitle: string;
  icon: React.ReactNode;
  iconBgColor: string;
  iconColor?: string;
  comparison?: TopicStatisticCard1Comparison;
  hasComparisonSlot?: boolean;
}

export interface TopicStatisticsStripProps {
  statistics?: HokimTopicStatisticsResponse;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  isRetrying?: boolean;
  isStale?: boolean;
}

export const TopicStatisticsStrip: React.FC<TopicStatisticsStripProps> = ({
  statistics,
  isLoading = false,
  isError = false,
  onRetry,
  isRetrying = false,
  isStale = false,
}) => {
  const screens = useBreakpoint();
  const prefersReducedMotion = usePrefersReducedMotion();
  const liveAnnouncer = useContext(LiveAnnouncerContext);

  // Desktop view when viewport >= 1024px
  const isDesktop = screens.lg ?? false;

  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isProgrammaticScrollRef = useRef<boolean>(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | number | null>(null);
  const lastAnnouncedIndexRef = useRef<number>(0);

  // Build card descriptors
  const card1: CardDescriptor = {
    id: 'statistic-card-1',
    title: 'Жами мавзулар',
    value: statistics?.totalUniqueTopics ?? 0,
    subtitle: 'танланган фильтр бўйича',
    icon: <FileTextOutlined />,
    iconBgColor: '#FEE2E2',
    iconColor: '#DC2626',
    comparison: statistics?.card1Comparison,
    hasComparisonSlot: true,
  };

  const card2 = {
    id: 'statistic-card-2',
    title: 'Ҳокимга оид',
    value: statistics?.hokimRelatedTopics ?? 0,
    subtitle: `${statistics?.hokimEvidenceCount ?? 0} та далил`,
    icon: <CrownOutlined />,
    iconBgColor: '#FCE7F3',
    iconColor: '#DB2777',
  };

  const card3 = {
    id: 'statistic-card-3',
    title: 'Фаол маҳаллалар',
    value: statistics?.activeMahallasCount ?? 0,
    subtitle: `${statistics?.totalAcceptedEvidenceCount ?? 0} та далил`,
    icon: <HomeOutlined />,
    iconBgColor: '#DBEAFE',
    iconColor: '#1D4ED8',
  };

  // Card 4: Most active service lane or multi-lane fallback
  let card4Title = 'Энг фаол соҳа';
  let card4Value: string | number = '—';
  let card4Subtitle = 'мавзулар йўқ';

  if (statistics?.card4) {
    if (statistics.card4.mode === 'multi_lane_topics') {
      card4Title = 'Кўп йўналишли';
      card4Value = statistics.card4.multiLaneTopicCount;
      card4Subtitle = 'мавзулар';
    } else {
      card4Title = 'Энг фаол соҳа';
      if (statistics.card4.isZero) {
        card4Value = '—';
        card4Subtitle = 'мавзулар йўқ';
      } else if (statistics.card4.isTie) {
        card4Value = `Тенг: ${statistics.card4.tiedCount} та йўналиш`;
        card4Subtitle = `${statistics.card4.leaderTopicCount} тадан мавзу`;
      } else {
        card4Value = statistics.card4.leaderLane ? LANE_LABELS[statistics.card4.leaderLane] : '—';
        card4Subtitle = `${statistics.card4.leaderTopicCount} та мавзу`;
      }
    }
  }

  const card4 = {
    id: 'statistic-card-4',
    title: card4Title,
    value: card4Value,
    subtitle: card4Subtitle,
    icon: <AppstoreOutlined />,
    iconBgColor: '#F3E8FF',
    iconColor: '#7C3AED',
  };

  // Card 5: Most active Mahalla or multi-evidence fallback
  let card5Title = 'Энг фаол маҳалла';
  let card5Value: string | number = '—';
  let card5Subtitle = 'мавзулар йўқ';

  if (statistics?.card5) {
    if (statistics.card5.mode === 'multi_evidence_topics') {
      card5Title = 'Кўп далилли';
      card5Value = statistics.card5.multiEvidenceTopicCount;
      card5Subtitle = 'мавзулар';
    } else {
      card5Title = 'Энг фаол маҳалла';
      if (statistics.card5.isZero) {
        card5Value = '—';
        card5Subtitle = 'мавзулар йўқ';
      } else if (statistics.card5.isTie) {
        card5Value = `Тенг: ${statistics.card5.tiedCount} та маҳалла`;
        card5Subtitle = `${statistics.card5.leaderTopicCount} тадан мавзу`;
      } else {
        card5Value = statistics.card5.leaderMahalla || '—';
        card5Subtitle = `${statistics.card5.leaderTopicCount} та мавзу`;
      }
    }
  }

  const card5 = {
    id: 'statistic-card-5',
    title: card5Title,
    value: card5Value,
    subtitle: card5Subtitle,
    icon: <EnvironmentOutlined />,
    iconBgColor: '#D1FAE5',
    iconColor: '#059669',
  };

  const cards: CardDescriptor[] = [card1, card2, card3, card4, card5];

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  const handleScroll = () => {
    if (isProgrammaticScrollRef.current) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const firstCard = cardRefs.current[0];
    const cardWidth = firstCard?.offsetWidth || container.clientWidth * 0.85;
    const gap = 16;
    const stride = cardWidth + gap;
    if (stride <= 0) return;

    const rawIndex = Math.round(container.scrollLeft / stride);
    const nextIndex = Math.max(0, Math.min(cards.length - 1, rawIndex));

    if (nextIndex !== currentIndex) {
      setCurrentIndex(nextIndex);
    }

    // Debounce announcement until scrolling settles (150ms)
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(() => {
      if (lastAnnouncedIndexRef.current !== nextIndex) {
        lastAnnouncedIndexRef.current = nextIndex;
        const announcedTitle = cards[nextIndex]?.title;
        if (liveAnnouncer?.announce && announcedTitle) {
          liveAnnouncer.announce(`Кўрсаткич ${nextIndex + 1} / 5: ${announcedTitle}`);
        }
      }
    }, 150);
  };

  const scrollToCard = (targetIndex: number) => {
    isProgrammaticScrollRef.current = true;
    setCurrentIndex(targetIndex);
    lastAnnouncedIndexRef.current = targetIndex;

    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    const announcedTitle = cards[targetIndex]?.title;
    if (liveAnnouncer?.announce && announcedTitle) {
      liveAnnouncer.announce(`Кўрсаткич ${targetIndex + 1} / 5: ${announcedTitle}`);
    }

    const targetCard = cardRefs.current[targetIndex];
    if (targetCard && typeof targetCard.scrollIntoView === 'function') {
      targetCard.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        inline: 'start',
        block: 'nearest',
      });
    }

    // Release programmatic scroll lock after smooth scrolling animation completes
    scrollTimeoutRef.current = setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 450);
  };

  const handlePrev = () => {
    const prevIndex = Math.max(0, currentIndex - 1);
    if (prevIndex !== currentIndex) {
      scrollToCard(prevIndex);
    }
  };

  const handleNext = () => {
    const nextIndex = Math.min(cards.length - 1, currentIndex + 1);
    if (nextIndex !== currentIndex) {
      scrollToCard(nextIndex);
    }
  };

  return (
    <section
      role="region"
      aria-label="Муҳим кўрсаткичлар"
      data-stale={isStale ? 'true' : undefined}
      style={{
        backgroundColor: '#F8FAFC',
        padding: isDesktop ? '8px 20px' : '8px 16px',
        borderBottom: '1px solid #E2E8F0',
        flexShrink: 0,
      }}
    >
      {/* Mobile Overflow Navigation Header (< 1024px) */}
      {!isDesktop && (!isError || Boolean(statistics)) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#475569',
            }}
            aria-live="polite"
          >
            Кўрсаткич {currentIndex + 1} / 5: {cards[currentIndex]?.title ?? ''}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              type="default"
              size="small"
              icon={<LeftOutlined />}
              onClick={handlePrev}
              disabled={currentIndex === 0}
              aria-label="Олдинги кўрсаткич"
              style={{
                minWidth: 44,
                minHeight: 44,
                width: 44,
                height: 44,
                borderRadius: 8,
                boxShadow: 'none',
                borderColor: '#CBD5E1',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            />
            <Button
              type="default"
              size="small"
              icon={<RightOutlined />}
              onClick={handleNext}
              disabled={currentIndex === cards.length - 1}
              aria-label="Кейинги кўрсаткич"
              style={{
                minWidth: 44,
                minHeight: 44,
                width: 44,
                height: 44,
                borderRadius: 8,
                boxShadow: 'none',
                borderColor: '#CBD5E1',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            />
          </div>
        </div>
      )}

      {/* Scoped Cold Error Alert Container (AC 4, AC 7) */}
      {isError && !statistics ? (
        <div
          role="alert"
          aria-live="polite"
          style={{
            backgroundColor: '#FEF2F2',
            border: '1px solid #FECACA',
            borderRadius: 8,
            padding: isDesktop ? '10px 20px' : '12px 16px',
            minHeight: 76,
            display: 'flex',
            flexDirection: isDesktop ? 'row' : 'column',
            alignItems: isDesktop ? 'center' : 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <WarningOutlined style={{ color: '#EF4444', fontSize: 20 }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: '#991B1B' }}>
              Статистика маълумотларини юклаб бўлмади
            </span>
          </div>
          <Button
            type="default"
            icon={<ReloadOutlined />}
            onClick={onRetry}
            loading={isRetrying}
            aria-label="Статистикани қайта юклаш"
            style={{
              borderColor: '#FCA5A5',
              color: '#991B1B',
              fontWeight: 600,
              minHeight: isDesktop ? 32 : 40,
              height: isDesktop ? 32 : 40,
              borderRadius: 6,
              boxShadow: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            Қайта уриниш
          </Button>
        </div>
      ) : (
        /* Cards Layout: 5-column grid on desktop, smooth horizontal snap on mobile */
        <div
          ref={containerRef}
          onScroll={!isDesktop ? handleScroll : undefined}
          data-testid="statistics-scroll-container"
          style={{
            display: isDesktop ? 'grid' : 'flex',
            gridTemplateColumns: isDesktop ? 'repeat(5, minmax(0, 1fr))' : undefined,
            gap: 16,
            overflowX: isDesktop ? 'visible' : 'auto',
            scrollSnapType: isDesktop ? undefined : 'x mandatory',
            scrollbarWidth: 'none',
            WebkitOverflowScrolling: 'touch',
            touchAction: isDesktop ? undefined : 'pan-x pan-y',
            paddingBottom: isDesktop ? 0 : 4,
          }}
        >
          {cards.map((card, index) => (
            <div
              key={card.id}
              ref={(el) => {
                cardRefs.current[index] = el;
              }}
              style={{
                flex: isDesktop ? undefined : '0 0 min(85%, 320px)',
                minWidth: isDesktop ? 0 : 260,
                maxWidth: isDesktop ? undefined : 320,
                scrollSnapAlign: isDesktop ? undefined : 'start',
                scrollSnapStop: isDesktop ? undefined : 'always',
              }}
            >
              <TopicStatisticCard
                id={card.id}
                title={card.title}
                value={card.value}
                subtitle={card.subtitle}
                icon={card.icon}
                iconBgColor={card.iconBgColor}
                iconColor={card.iconColor}
                isLoading={isLoading}
                comparison={card.comparison}
                hasComparisonSlot={card.hasComparisonSlot}
              />
            </div>
          ))}
          {/* Mobile Trailing Spacer Buffer: guarantees Card 5 snaps to start without bouncing back */}
          {!isDesktop && (
            <div
              aria-hidden="true"
              data-testid="carousel-trailing-spacer"
              style={{
                flex: '0 0 calc(100% - min(85%, 320px))',
                minWidth: 'calc(100% - min(85%, 320px))',
                scrollSnapAlign: 'none',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      )}
    </section>
  );
};
