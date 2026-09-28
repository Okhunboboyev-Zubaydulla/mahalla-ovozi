import React from 'react';
import { Button, Typography } from 'antd';
import { HolderOutlined } from '@ant-design/icons';
import { QualifyingLane } from '@mahalla-ovozi/api-contracts';
import { LANE_LABELS, LANE_STYLES, LANE_ICONS } from './TopicCard.js';

const { Text } = Typography;

export interface LaneHeaderProps {
  lane: QualifyingLane;
  totalCount: number;
  isDragDisabled?: boolean;
  isDragging?: boolean;
  setActivatorNodeRef?: (element: HTMLElement | null) => void;
  attributes?: Record<string, any>;
  listeners?: Record<string, any>;
}

export const LaneHeaderComponent: React.FC<LaneHeaderProps> = ({
  lane,
  totalCount,
  isDragDisabled = false,
  isDragging = false,
  setActivatorNodeRef,
  attributes,
  listeners,
}) => {
  const laneLabel = LANE_LABELS[lane];
  const laneStyle = LANE_STYLES[lane];

  return (
    <header
      id={`lane-header-${lane}`}
      tabIndex={-1}
      style={{
        padding: '12px 14px',
        backgroundColor: '#FFFFFF',
        borderBottom: '1px solid #E2E8F0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        outline: 'none',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Drag Handle Icon (visible on desktop) */}
        <Button
          ref={setActivatorNodeRef}
          type="text"
          size="small"
          disabled={isDragDisabled}
          aria-label={
            isDragDisabled
              ? `${laneLabel} устуни (суриш фаол эмас)`
              : `${laneLabel} устунини суриш`
          }
          title={
            isDragDisabled
              ? 'Барча йўналишлар кўрсатилганда тартибни ўзгартириш мумкин'
              : 'Устунни суриш'
          }
          icon={
            <HolderOutlined
              style={{
                color: isDragDisabled ? '#CBD5E1' : '#94A3B8',
                fontSize: 14,
              }}
            />
          }
          {...attributes}
          {...listeners}
          className="lane-drag-handle"
          style={{
            cursor: isDragDisabled ? 'not-allowed' : isDragging ? 'grabbing' : 'grab',
            padding: 0,
            height: 24,
            width: 18,
            minWidth: 18,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            boxShadow: 'none',
          }}
        />

        {/* Domain Icon Badge */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 6,
            backgroundColor: laneStyle.bg,
            color: laneStyle.text,
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          {LANE_ICONS[lane]}
        </span>

        {/* Isolated Bold Lane Title */}
        <Text
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: '#0F172A',
            letterSpacing: '-0.01em',
          }}
        >
          {laneLabel}
        </Text>
      </div>

      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: laneStyle.text,
          backgroundColor: laneStyle.bg,
          padding: '2px 8px',
          borderRadius: 12,
        }}
      >
        {totalCount}
      </span>
    </header>
  );
};

export const LaneHeader = React.memo(LaneHeaderComponent);
