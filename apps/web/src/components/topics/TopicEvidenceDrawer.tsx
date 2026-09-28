import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Drawer, Typography, Tag, Space, Skeleton, Button, Alert, Segmented } from 'antd';
import {
  CloseOutlined,
  EnvironmentOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  MessageOutlined,
  DownOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { useTopicEvidence } from '../../topics/useTopicEvidence.js';
import { useTopicReadState } from '../../hooks/useTopicReadState.js';
import { useBottomSentinelObserver } from '../../hooks/useBottomSentinelObserver.js';
import { getSafeScrollBehavior } from '../../lib/scrollUtils.js';
import { LANE_LABELS, LANE_STYLES } from './TopicCard.js';
import { EvidenceTimeline } from './EvidenceTimeline.js';
import { formatTashkentActivityTime } from '../../lib/formatters.js';
import { TopicSummaryBody } from './TopicSummaryBody.js';
import { TopicLatestUpdateCallout } from './TopicLatestUpdateCallout.js';
import { TopicCardItem } from '@mahalla-ovozi/api-contracts';

const { Title, Text } = Typography;

export interface TopicEvidenceDrawerProps {
  topicId: string | null;
  initialTopic?: TopicCardItem | null;
  focusHokim?: boolean;
  onClose: () => void;
  onInvalidated?: () => void;
}

export const TopicEvidenceDrawer: React.FC<TopicEvidenceDrawerProps> = ({
  topicId,
  initialTopic,
  focusHokim,
  onClose,
  onInvalidated,
}) => {
  const effectiveFocusHokim = focusHokim ?? false;
  const headingRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);

  const [order, setOrder] = useState<'ASC' | 'DESC'>('ASC');

  const {
    topic,
    evidenceList,
    totalCount,
    isLoading,
    isError,
    error,
    isFetchingNextPage,
    isFetchNextPageError,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useTopicEvidence(topicId, { order, onInvalidated, initialTopic });

  const { markTopicAsRead } = useTopicReadState();

  // Zero-overhead scroll position detection:
  // In ASC mode: observe bottom sentinel (detecting if scrolled away from bottom)
  // In DESC mode: observe top sentinel (detecting if scrolled away from top)
  const isScrolledAway = useBottomSentinelObserver({
    rootRef: scrollContainerRef,
    sentinelRef: order === 'ASC' ? bottomSentinelRef : topSentinelRef,
    thresholdOffsetPx: 150,
    enabled: Boolean(topicId && !isLoading && topic),
    direction: order === 'ASC' ? 'bottom' : 'top',
  });

  // Synchronize read state when topic evidence loads or updates in drawer
  useEffect(() => {
    if (topic) {
      markTopicAsRead(topic.id, Math.max(totalCount, topic.evidenceCount));
    }
  }, [topic, totalCount, markTopicAsRead]);

  // Motion-safe, keyboard-accessible glide to the latest evidence item
  const handleScrollToLatest = useCallback(() => {
    const behavior = getSafeScrollBehavior();
    const targetId =
      order === 'ASC'
        ? evidenceList[evidenceList.length - 1]?.id
        : evidenceList[0]?.id;

    if (order === 'ASC') {
      const sentinel = bottomSentinelRef.current;
      if (sentinel) {
        sentinel.scrollIntoView({ behavior, block: 'end' });
      } else if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTo({
          top: scrollContainerRef.current.scrollHeight,
          behavior,
        });
      }
    } else {
      // In DESC mode, scroll directly to top to bring summary card and latest message into view
      scrollContainerRef.current?.scrollTo({
        top: 0,
        behavior,
      });
    }

    // Accessible focus management: focus actual EvidenceItem article rather than aria-hidden sentinel (WCAG 4.1.2)
    if (targetId) {
      const targetEl = document.getElementById(`evidence-item-${targetId}`);
      if (targetEl) {
        targetEl.focus({ preventScroll: true });
      }
    }
  }, [order, evidenceList]);

  const handleOrderChange = useCallback((newOrder: 'ASC' | 'DESC') => {
    setOrder(newOrder);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, []);

  // Programmatic focus on drawer heading and scroll reset when topicId opens or changes (AC 7)
  useEffect(() => {
    if (!topicId) {
      return;
    }
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
    // Small timeout allows DOM to mount drawer contents before focusing
    const timer = setTimeout(() => {
      headingRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [topicId]);

  // Keyboard Escape listener to close drawer and restore focus (AC 7)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && topicId) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [topicId, onClose]);

  const formattedActivityTime = topic
    ? formatTashkentActivityTime(
        topic.latestMeaningfulActivityTimestamp,
        topic.calendarDay,
      )
    : '';

  const errorMessage =
    error instanceof Error ? error.message : 'Далилларни юклашда хатолик юз берди.';

  return (
    <Drawer
      open={Boolean(topicId)}
      onClose={onClose}
      mask={true}
      width={typeof window !== 'undefined' ? Math.min(540, window.innerWidth - 32) : 540}
      aria-label="Мавзу далиллари"
      aria-modal={true}
      keyboard={true}
      closeIcon={<CloseOutlined aria-label="Ёпиш" style={{ fontSize: 16, color: '#64748B' }} />}
      styles={{
        mask: {
          backgroundColor: 'rgba(15, 23, 42, 0.25)',
          backdropFilter: 'blur(2px)',
        },
        wrapper: {
          top: 16,
          right: 16,
          bottom: 16,
          height: 'calc(100vh - 32px)',
          maxHeight: 'calc(100vh - 32px)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 20px 25px -5px rgba(15, 23, 42, 0.14), 0 8px 10px -6px rgba(15, 23, 42, 0.08)',
        },
        content: {
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid #E2E8F0',
          backgroundColor: '#FFFFFF',
          boxShadow: 'none',
        },
        header: {
          borderBottom: '1px solid #E2E8F0',
          padding: '14px 20px',
          backgroundColor: '#FFFFFF',
        },
        body: {
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflow: 'hidden',
          backgroundColor: '#F8FAFC',
          position: 'relative',
        },
      }}
      title={
        <div
          ref={headingRef}
          tabIndex={-1}
          id="topic-evidence-heading"
          style={{ outline: 'none', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              backgroundColor: '#E0F2FE',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <MessageOutlined style={{ color: '#0284C7', fontSize: 16 }} />
          </div>
          <Title
            level={5}
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 700,
              color: '#0F172A',
            }}
          >
            Мавзу далиллари
          </Title>
        </div>
      }
    >
      <section
        role="region"
        aria-label="Мавзу далиллари"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', minHeight: 0 }}
      >
        {/* 1. Loading Skeleton during Initial Fetch when no topic metadata exists (AC 7) */}
        {isLoading && !topic && (
          <div style={{ padding: '20px' }}>
            <Skeleton active paragraph={{ rows: 8 }} />
          </div>
        )}

        {/* 2. Error State for Initial Load (AC 7) */}
        {!isLoading && isError && !topic && (
          <div style={{ padding: '24px 20px', textAlign: 'center' }}>
          <Alert
            type="error"
            showIcon
            message="Юклашда хатолик"
            description={errorMessage}
            style={{
              textAlign: 'left',
              backgroundColor: '#FEE2E2',
              borderColor: '#FECACA',
              marginBottom: 16,
              borderRadius: 8,
              boxShadow: 'none',
            }}
          />
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => refetch()}
            style={{ fontWeight: 600, borderRadius: 6, boxShadow: 'none' }}
          >
            Қайта уриниш
          </Button>
        </div>
      )}

      {/* 3. Loaded / Optimistic Topic Header & Evidence Stream */}
      {topic && (
        <>
          <div
            ref={scrollContainerRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              scrollbarWidth: 'thin',
              scrollbarColor: '#CBD5E1 transparent',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Context Summary & Anchor Quote (scrolls out of view) */}
            <div
              style={{
                padding: '20px 20px 0 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
              }}
            >
          {/* Topic Metadata & Summary Card */}
          <div
            style={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #E2E8F0',
              borderRadius: 12,
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              boxShadow: '0 2px 4px -1px rgba(15, 23, 42, 0.06), 0 1px 2px -1px rgba(15, 23, 42, 0.04)',
            }}
          >
            {/* Mahalla + Lane Tags */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <Space size={6}>
                <EnvironmentOutlined style={{ color: '#0284C7', fontSize: 14 }} />
                <Text strong style={{ fontSize: 15, color: '#0F172A' }}>
                  {topic.mahallaName}
                </Text>
              </Space>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {topic.lanes.map((lane) => {
                  const style = LANE_STYLES[lane] || LANE_STYLES.HOKIM_RELATED;
                  const label = LANE_LABELS[lane] || lane;
                  return (
                    <Tag
                      key={lane}
                      style={{
                        backgroundColor: style.bg,
                        color: style.text,
                        borderColor: style.border,
                        fontSize: 11,
                        fontWeight: 600,
                        margin: 0,
                        borderRadius: 4,
                      }}
                    >
                      {label}
                    </Tag>
                  );
                })}
              </div>
            </div>

            {/* Summary Text (Progressive Loading with Skeleton / Graceful Degradation) */}
            <TopicSummaryBody
              summary={topic.summary}
              createdAt={topic.createdAt}
              fontSize={14}
              lineHeight="20px"
              color="#1E293B"
            />

            {/* Dynamic Contextual Latest Message Update */}
            <TopicLatestUpdateCallout
              latestUpdate={topic.latestUpdate}
              evidenceCount={topic.evidenceCount}
              timestamp={topic.latestMeaningfulActivityTimestamp}
            />

            {/* Latest Activity Time + Total Evidence Count */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: 8,
                borderTop: '1px solid #F1F5F9',
                fontSize: 13,
                color: '#64748B',
              }}
            >
              <Space size={4}>
                <MessageOutlined style={{ fontSize: 13, color: '#94A3B8' }} />
                <Text style={{ fontSize: 13, color: '#64748B' }}>
                  Жами: <span style={{ fontWeight: 600, color: '#0F172A' }}>{totalCount}</span> та хабар
                </Text>
              </Space>

              {formattedActivityTime && (
                <Space size={4}>
                  <ClockCircleOutlined style={{ fontSize: 13, color: '#94A3B8' }} />
                  <Text style={{ fontSize: 13, color: '#64748B' }}>{formattedActivityTime}</Text>
                </Space>
              )}
            </div>
          </div>
        </div>

        {/* Sticky Evidence Section Header */}
        <div
          data-testid="evidence-sticky-header"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 15,
            backgroundColor: '#F8FAFC',
            borderBottom: '1px solid #E2E8F0',
            padding: '10px 20px',
            marginTop: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
          }}
        >
              <Space size={8} align="center">
                <Text
                  strong
                  style={{
                    fontSize: 13,
                    color: '#0F172A',
                  }}
                >
                  Сақланган далиллар рўйхати
                </Text>
                <Tag
                  style={{
                    backgroundColor: '#E0F2FE',
                    color: '#0284C7',
                    borderColor: '#BAE6FD',
                    borderRadius: 12,
                    fontWeight: 600,
                    fontSize: 12,
                    margin: 0,
                    padding: '1px 8px',
                  }}
                >
                  {evidenceList.length} / {totalCount}
                </Tag>
              </Space>

              <Segmented<'ASC' | 'DESC'>
                size="small"
                value={order}
                onChange={handleOrderChange}
                options={[
                  { label: 'Эскилари олдин', value: 'ASC' },
                  { label: 'Янгилари олдин', value: 'DESC' },
                ]}
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                }}
              />
            </div>

            {/* Evidence Timeline */}
            <div style={{ padding: '16px 20px 24px 20px', flex: 1 }}>
              {isLoading && evidenceList.length === 0 ? (
                <div style={{ padding: '12px 0' }} data-testid="evidence-timeline-skeleton">
                  <Skeleton active avatar paragraph={{ rows: 3 }} />
                  <Skeleton active avatar paragraph={{ rows: 3 }} style={{ marginTop: 24 }} />
                </div>
              ) : (
                <EvidenceTimeline
                  evidenceList={evidenceList}
                  totalCount={totalCount}
                  hasNextPage={hasNextPage}
                  isFetchingNextPage={isFetchingNextPage}
                  isFetchNextPageError={isFetchNextPageError}
                  onFetchNextPage={fetchNextPage}
                  focusHokim={effectiveFocusHokim}
                  sentinelRef={bottomSentinelRef}
                  topSentinelRef={topSentinelRef}
                />
              )}
            </div>
          </div>

          {/* Floating Jump-to-Latest Button (Adaptive UX with 60fps CSS transitions & a11y focus) */}
          {evidenceList.length > 0 && (
            <Button
              type="primary"
            shape="round"
            icon={
              order === 'ASC' ? (
                <DownOutlined style={{ fontSize: 12 }} />
              ) : (
                <UpOutlined style={{ fontSize: 12 }} />
              )
            }
            onClick={handleScrollToLatest}
            aria-label={order === 'ASC' ? 'Сўнгги хабарга пастга ўтиш' : 'Сўнгги хабарга юқорига ўтиш'}
            tabIndex={isScrolledAway ? 0 : -1}
            aria-hidden={!isScrolledAway}
            style={{
              position: 'absolute',
              bottom: 24,
              right: 24,
              zIndex: 25,
              boxShadow: '0 4px 14px rgba(2, 132, 199, 0.35), 0 2px 6px rgba(15, 23, 42, 0.12)',
              fontWeight: 600,
              fontSize: 13,
              backgroundColor: '#0284C7',
              borderColor: '#0284C7',
              color: '#FFFFFF',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 38,
              padding: '0 16px',
              cursor: isScrolledAway ? 'pointer' : 'default',
              opacity: isScrolledAway ? 1 : 0,
              transform: isScrolledAway ? 'translateY(0) scale(1)' : 'translateY(10px) scale(0.95)',
              pointerEvents: isScrolledAway ? 'auto' : 'none',
              transition:
                'opacity 200ms cubic-bezier(0.16, 1, 0.3, 1), transform 200ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            Сўнгги хабарга
          </Button>
        )}
      </>
    )}
      </section>
    </Drawer>
  );
};
