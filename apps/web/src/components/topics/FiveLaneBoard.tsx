import React, { useRef, useState, useEffect, useContext } from 'react';
import { Button, Typography } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { QualifyingLane, TopicCardItem } from '@mahalla-ovozi/api-contracts';
import { LaneColumn } from './LaneColumn.js';
import { LANE_LABELS } from './TopicCard.js';
import { LaneLocalState } from '../../topics/useHokimTopicBoard.js';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion.js';
import { LiveAnnouncerContext } from '../../hooks/useLiveAnnouncer.js';
import {
  useLaneOrderPreference,
  CANONICAL_LANE_ORDER,
} from '../../hooks/useLaneOrderPreference.js';
import { themeColors } from '../../theme/antd-theme.js';

const { Text } = Typography;

export interface FiveLaneBoardProps {
  lanes: Record<QualifyingLane, LaneLocalState>;
  activeLanes?: QualifyingLane[];
  isFiltered?: boolean;
  onResetFilters?: () => void;
  selectedTopicId?: string | null;
  searchQuery?: string;
  onLoadMore: (lane: QualifyingLane) => void;
  onSelectTopic?: (topic: TopicCardItem, options?: { focusHokim?: boolean }) => void;
  onRevealNewTopics?: (lane: QualifyingLane) => void;
  districtId?: string;
  userId?: string;
}

export const FiveLaneBoard: React.FC<FiveLaneBoardProps> = ({
  lanes,
  activeLanes,
  isFiltered = false,
  selectedTopicId,
  searchQuery,
  onLoadMore,
  onSelectTopic,
  onRevealNewTopics: _onRevealNewTopics,
  districtId,
  userId,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [activeDragId, setActiveDragId] = useState<QualifyingLane | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const liveAnnouncer = useContext(LiveAnnouncerContext);

  const { laneOrder, setLaneOrder } = useLaneOrderPreference(districtId, userId);

  const isFilterActive = Boolean(
    activeLanes && activeLanes.length > 0 && activeLanes.length < CANONICAL_LANE_ORDER.length
  );

  const lanesToRender =
    activeLanes && activeLanes.length > 0
      ? laneOrder.filter((l) => activeLanes.includes(l))
      : laneOrder;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as QualifyingLane);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);

    if (over && active.id !== over.id) {
      const oldIndex = laneOrder.indexOf(active.id as QualifyingLane);
      const newIndex = laneOrder.indexOf(over.id as QualifyingLane);
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(laneOrder, oldIndex, newIndex);
        setLaneOrder(newOrder);

        const activeLaneName = LANE_LABELS[active.id as QualifyingLane] || active.id;
        if (liveAnnouncer) {
          liveAnnouncer.announce(
            `${activeLaneName} йўналиши ${newIndex + 1}-ўринга кўчирилди`
          );
        }
      }
    }
  };

  const totalVisibleCount = lanesToRender.reduce(
    (sum, laneKey) => sum + (lanes[laneKey]?.topics?.length || 0),
    0,
  );

  const updateScrollButtons = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 5);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 5);
  };

  useEffect(() => {
    updateScrollButtons();
    const el = scrollContainerRef.current;
    if (!el) return;

    el.addEventListener('scroll', updateScrollButtons, { passive: true });
    window.addEventListener('resize', updateScrollButtons);
    return () => {
      el.removeEventListener('scroll', updateScrollButtons);
      window.removeEventListener('resize', updateScrollButtons);
    };
  }, [lanes, lanesToRender]);

  const scrollByLane = (direction: 'left' | 'right') => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const laneWidth = 320; // Approx lane column width + gap
    const behavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';

    el.scrollBy({
      left: direction === 'left' ? -laneWidth : laneWidth,
      behavior,
    });
  };

  const isBoardEmpty = totalVisibleCount === 0;

  return (
    <main
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        backgroundColor: '#F8FAFC',
        padding: '8px 20px 6px 20px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Informative Empty State Banner (AC 12 & UX Design Spec) */}
      {isBoardEmpty && (
        <div
          role="status"
          style={{
            backgroundColor: '#FFFFFF',
            border: '1px solid #E2E8F0',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 12,
            boxShadow: themeColors.shadowCard,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div>
            <Text strong style={{ color: '#0F172A', fontSize: 14 }}>
              {isFiltered
                ? 'Танланган шартлар бўйича мавзулар топилмади'
                : 'Бугун ҳозирча мавзулар йўқ'}
            </Text>
            <span style={{ color: '#64748B', fontSize: 13, marginLeft: 8 }}>
              {isFiltered
                ? 'Бошқа сана оралиғи, маҳалла ёки йўналишларни танлаб кўринг.'
                : 'Туман маҳаллалари гуруҳларидан янги хабарлар келиб тушганда бу ерда мавзулар шаклланади.'}
            </span>
          </div>
        </div>
      )}
      {/* Scroll Navigation Controls (Mobile / Narrow screens < 1200px) */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          right: 28,
          zIndex: 10,
          display: canScrollLeft || canScrollRight ? 'flex' : 'none',
          gap: 8,
        }}
      >
        <Button
          shape="circle"
          size="small"
          icon={<LeftOutlined />}
          disabled={!canScrollLeft}
          onClick={() => scrollByLane('left')}
          aria-label="Олдинги йўналиш"
          className="focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:outline-none"
          style={{
            backgroundColor: '#FFFFFF',
            borderColor: '#CBD5E1',
            boxShadow: 'none',
          }}
        />
        <Button
          shape="circle"
          size="small"
          icon={<RightOutlined />}
          disabled={!canScrollRight}
          onClick={() => scrollByLane('right')}
          aria-label="Кейинги йўналиш"
          className="focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:outline-none"
          style={{
            backgroundColor: '#FFFFFF',
            borderColor: '#CBD5E1',
            boxShadow: 'none',
          }}
        />
      </div>

      {/* 5 Distinct Kanban Lane Columns */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={lanesToRender} strategy={horizontalListSortingStrategy}>
          <div
            ref={scrollContainerRef}
            tabIndex={0}
            aria-label="Йўналишлар панели"
            style={{
              display: 'flex',
              gap: 16,
              flex: 1,
              minHeight: 0,
              overflowX: 'auto',
              overflowY: 'hidden',
              paddingBottom: 4,
              scrollSnapType: activeDragId ? 'none' : 'x mandatory',
              WebkitOverflowScrolling: 'touch',
              justifyContent: lanesToRender.length <= 3 ? 'safe center' : 'flex-start',
            }}
            onFocus={(e) => {
              if (e.target === e.currentTarget) {
                e.currentTarget.style.outline = '2px solid #0284C7';
              }
            }}
            onBlur={(e) => {
              e.currentTarget.style.outline = 'none';
            }}
          >
            {lanesToRender.map((laneKey) => {
              const laneData = lanes[laneKey] || {
                lane: laneKey,
                topics: [],
                totalCount: 0,
                nextCursor: null,
                hasNextPage: false,
                isLoadingMore: false,
                loadMoreError: null,
              };

              return (
                <LaneColumn
                  key={laneKey}
                  lane={laneKey}
                  topics={laneData.topics}
                  totalCount={laneData.totalCount}
                  hasNextPage={laneData.hasNextPage}
                  isLoadingMore={laneData.isLoadingMore}
                  loadMoreError={laneData.loadMoreError}
                  selectedTopicId={selectedTopicId}
                  searchQuery={searchQuery}
                  onLoadMore={onLoadMore}
                  onSelectTopic={onSelectTopic}
                  isDragDisabled={isFilterActive}
                  style={lanesToRender.length < 5 ? { maxWidth: 480 } : undefined}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </main>
  );
};
