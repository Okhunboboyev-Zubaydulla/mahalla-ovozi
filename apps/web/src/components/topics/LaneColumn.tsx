import React, { useRef, useEffect, useLayoutEffect, useContext, useState, useCallback } from 'react';
import { Typography, Empty } from 'antd';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { QualifyingLane, TopicCardItem } from '@mahalla-ovozi/api-contracts';
import { TopicCard, LANE_LABELS } from './TopicCard.js';
import { LaneHeader } from './LaneHeader.js';
import { LanePaginationTrigger } from './LanePaginationTrigger.js';
import { themeColors } from '../../theme/antd-theme.js';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion.js';
import { LiveAnnouncerContext } from '../../hooks/useLiveAnnouncer.js';

const { Text } = Typography;

export interface LaneColumnProps {
  lane: QualifyingLane;
  topics: TopicCardItem[];
  totalCount: number;
  newItemsCount?: number;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  selectedTopicId?: string | null;
  searchQuery?: string;
  onLoadMore: (lane: QualifyingLane) => void;
  onSelectTopic?: (topic: TopicCardItem, options?: { focusHokim?: boolean }) => void;
  onRevealNewItems?: (lane: QualifyingLane) => void;
  style?: React.CSSProperties;
  isDragDisabled?: boolean;
}

const LaneColumnComponent: React.FC<LaneColumnProps> = ({
  lane,
  topics,
  totalCount,
  newItemsCount: _newItemsCount,
  hasNextPage,
  isLoadingMore,
  loadMoreError,
  selectedTopicId,
  searchQuery,
  onLoadMore,
  onSelectTopic,
  onRevealNewItems: _onRevealNewItems,
  style,
  isDragDisabled = false,
}) => {
  const laneLabel = LANE_LABELS[lane];
  const prefersReducedMotion = usePrefersReducedMotion();
  const liveAnnouncer = useContext(LiveAnnouncerContext);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevTopicsLengthRef = useRef(topics.length);
  const prevScrollHeightRef = useRef<number>(0);
  const prevFirstTopicIdRef = useRef<string | undefined>(topics[0]?.id);
  const isKeyboardTriggerRef = useRef(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: lane,
    disabled: isDragDisabled,
  });

  const sortableStyle: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: prefersReducedMotion ? undefined : transition,
    opacity: isDragging ? 0.6 : undefined,
    zIndex: isDragging ? 50 : undefined,
    position: 'relative',
  };

  const [canScrollTop, setCanScrollTop] = useState(false);
  const [canScrollBottom, setCanScrollBottom] = useState(false);

  const updateScrollEdges = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const hasOverflow = scrollHeight > clientHeight + 1;
    setCanScrollTop(hasOverflow && scrollTop > 4);
    setCanScrollBottom(hasOverflow && scrollTop + clientHeight < scrollHeight - 4);
  }, []);

  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      updateScrollEdges();
    });
    const el = scrollContainerRef.current;
    if (!el) return () => cancelAnimationFrame(rafId);

    el.addEventListener('scroll', updateScrollEdges, { passive: true });
    window.addEventListener('resize', updateScrollEdges);
    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener('scroll', updateScrollEdges);
      window.removeEventListener('resize', updateScrollEdges);
    };
  }, [topics, isLoadingMore, updateScrollEdges]);

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const prevLength = prevTopicsLengthRef.current;
    const prevFirstId = prevFirstTopicIdRef.current;
    const currentFirstId = topics[0]?.id;

    // Detect if newly incoming topic(s) were prepended at index 0 (not a loadMore append)
    const isPrepended =
      topics.length > prevLength && prevFirstId !== undefined && currentFirstId !== prevFirstId;

    if (isPrepended && el.scrollTop > 20) {
      const prevScrollHeight = prevScrollHeightRef.current;
      const newScrollHeight = el.scrollHeight;
      const heightDelta = newScrollHeight - prevScrollHeight;
      if (heightDelta > 0) {
        // Anchor scroll position so existing cards remain stationary
        el.scrollTop += heightDelta;
      }
    }

    prevScrollHeightRef.current = el.scrollHeight;
    prevFirstTopicIdRef.current = currentFirstId;
  }, [topics]);

  useEffect(() => {
    if (prevTopicsLengthRef.current !== topics.length) {
      if (isKeyboardTriggerRef.current) {
        // Find newly loaded cards and announce
        const addedCount = topics.length - prevTopicsLengthRef.current;
        if (addedCount > 0 && liveAnnouncer) {
          liveAnnouncer.announce(
            `${laneLabel} йўналишига яна ${addedCount} та янги мавзу юкланди`,
          );
        }
      }
    }
    isKeyboardTriggerRef.current = false;
    prevTopicsLengthRef.current = topics.length;
  }, [topics, laneLabel, liveAnnouncer]);

  return (
    <section
      ref={setNodeRef}
      aria-labelledby={`lane-header-${lane}`}
      style={{
        flex: '1 1 0px',
        minWidth: 240,
        backgroundColor: themeColors.colorBgLaneTrack,
        border: isDragging ? '1px dashed #0284C7' : '1px solid #E2E8F0',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        boxShadow: isDragging ? themeColors.shadowCardHover : themeColors.shadowCard,
        ...sortableStyle,
        ...style,
      }}
    >
      {/* Fixed Lane Header */}
      <LaneHeader
        lane={lane}
        totalCount={totalCount}
        isDragDisabled={isDragDisabled}
        isDragging={isDragging}
        setActivatorNodeRef={setActivatorNodeRef}
        attributes={attributes}
        listeners={listeners}
      />

      {/* Relative wrapper for scroll container and edge fade overlays */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Top Edge Gradient Fade */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 6,
            height: 24,
            background: 'linear-gradient(to bottom, #F8FAFC 0%, rgba(248, 250, 252, 0) 100%)',
            pointerEvents: 'none',
            zIndex: 2,
            opacity: canScrollTop ? 1 : 0,
            transition: prefersReducedMotion ? 'none' : 'opacity 0.2s ease',
          }}
        />

        {/* Scrollable Topic Cards List */}
        <div
          ref={scrollContainerRef}
          className="lane-scrollbar"
          aria-busy={isLoadingMore}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(148, 163, 184, 0.35) transparent',
          }}
        >
          {topics.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '24px 8px',
              }}
            >
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Text style={{ color: '#64748B', fontSize: 14 }}>
                    Мос мавзу топилмади
                  </Text>
                }
                style={{ margin: 0 }}
              />
            </div>
          ) : (
            topics.map((topic) => (
              <TopicCard
                key={topic.id}
                topic={topic}
                currentLane={lane}
                isSelected={topic.id === selectedTopicId}
                searchQuery={searchQuery}
                onClick={
                  onSelectTopic
                    ? () => onSelectTopic(topic, { focusHokim: lane === 'HOKIM_RELATED' })
                    : undefined
                }
                onSelectHokimChip={
                  onSelectTopic
                    ? () => onSelectTopic(topic, { focusHokim: true })
                    : undefined
                }
              />
            ))
          )}

          {/* Keyset Pagination Load More & Failure Retry Controls */}
          <LanePaginationTrigger
            lane={lane}
            laneLabel={laneLabel}
            hasNextPage={hasNextPage}
            isLoadingMore={isLoadingMore}
            loadMoreError={loadMoreError}
            onLoadMore={onLoadMore}
            onTriggerKeyboard={() => {
              isKeyboardTriggerRef.current = true;
            }}
          />
        </div>

        {/* Bottom Edge Gradient Fade */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 6,
            height: 24,
            background: 'linear-gradient(to top, #F8FAFC 0%, rgba(248, 250, 252, 0) 100%)',
            pointerEvents: 'none',
            zIndex: 2,
            opacity: canScrollBottom ? 1 : 0,
            transition: prefersReducedMotion ? 'none' : 'opacity 0.2s ease',
          }}
        />
      </div>
    </section>
  );
};

export const LaneColumn = React.memo(LaneColumnComponent);

