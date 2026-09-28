import React, { useState, useEffect, useMemo } from 'react';
import { Tag, Typography, Space } from 'antd';
import {
  ClockCircleOutlined,
  MessageOutlined,
  EnvironmentOutlined,
  BankOutlined,
  ThunderboltOutlined,
  FireOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import type { TopicCardItem, QualifyingLane } from '@mahalla-ovozi/api-contracts';
import { formatTashkentCalendarDate, formatTashkentTime } from '../../lib/formatters.js';
import { TopicSummaryBody } from './TopicSummaryBody.js';
import { TopicLatestUpdateCallout } from './TopicLatestUpdateCallout.js';
import { themeColors } from '../../theme/antd-theme.js';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion.js';
import { useTopicReadState } from '../../hooks/useTopicReadState.js';
import { getMahallaColor } from '../../utils/mahalla-colors.js';

const { Text } = Typography;

export const WaterDropIcon: React.FC<{ style?: React.CSSProperties }> = ({ style }) => (
  <span role="img" aria-label="сув" className="anticon" style={style}>
    <svg
      viewBox="0 0 1024 1024"
      width="1em"
      height="1em"
      fill="currentColor"
      focusable="false"
    >
      <path d="M512 64C512 64 213.33 469.33 213.33 682.67c0 164.95 133.72 298.66 298.67 298.66s298.67-133.71 298.67-298.66C810.67 469.33 512 64 512 64z m0 810.67c-120.53 0-218.67-98.13-218.67-218.67 0-117.33 149.34-362.67 218.67-469.33 69.33 106.66 218.67 352 218.67 469.33 0 120.54-98.14 218.67-218.67 218.67z" />
    </svg>
  </span>
);

export const LANE_LABELS: Record<QualifyingLane, string> = {
  HOKIM_RELATED: 'Ҳокимга оид',
  WATER: 'Сув',
  ELECTRICITY: 'Электр',
  GAS: 'Газ',
  WASTE: 'Чиқинди',
};

export const LANE_STYLES: Record<
  QualifyingLane,
  { bg: string; text: string; border: string }
> = {
  HOKIM_RELATED: { bg: '#FEE2E2', text: '#DC2626', border: '#FECACA' },
  WATER: { bg: '#DBEAFE', text: '#1D4ED8', border: '#BFDBFE' },
  ELECTRICITY: { bg: '#F3E8FF', text: '#6D28D9', border: '#E9D5FF' },
  GAS: { bg: '#FFEDD5', text: '#C2410C', border: '#FED7AA' },
  WASTE: { bg: '#D1FAE5', text: '#047857', border: '#A7F3D0' },
};

export const LANE_ICONS: Record<QualifyingLane, React.ReactNode> = {
  HOKIM_RELATED: <BankOutlined aria-hidden="true" />,
  WATER: <WaterDropIcon style={{ fontSize: 13 }} />,
  ELECTRICITY: <ThunderboltOutlined aria-hidden="true" />,
  GAS: <FireOutlined aria-hidden="true" />,
  WASTE: <DeleteOutlined aria-hidden="true" />,
};

export interface TopicCardProps {
  topic: TopicCardItem;
  currentLane?: QualifyingLane;
  isSelected?: boolean;
  searchQuery?: string;
  onClick?: () => void;
  onSelectHokimChip?: (topic: TopicCardItem) => void;
  showNewBadge?: boolean;
  unreadDelta?: number | '+' | null;
}

const TopicCardComponent: React.FC<TopicCardProps> = ({
  topic,
  currentLane: _currentLane,
  isSelected = false,
  searchQuery,
  onClick,
  onSelectHokimChip,
  showNewBadge,
  unreadDelta,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  const readState = useTopicReadState();
  const freshness = readState.getTopicFreshness(topic);
  const effectiveShowNewBadge = showNewBadge !== undefined ? showNewBadge : freshness.showNewBadge;
  const effectiveUnreadDelta = unreadDelta !== undefined ? unreadDelta : freshness.unreadDelta;
  const displayedEvidenceCount =
    typeof effectiveUnreadDelta === 'number'
      ? Math.max(0, topic.evidenceCount - effectiveUnreadDelta)
      : topic.evidenceCount;

  const [isPulseActive, setIsPulseActive] = useState(
    () => effectiveShowNewBadge && !prefersReducedMotion,
  );

  useEffect(() => {
    if (effectiveShowNewBadge && !prefersReducedMotion) {
      setIsPulseActive(true);
      const timer = setTimeout(() => {
        setIsPulseActive(false);
      }, 2500);
      return () => {
        clearTimeout(timer);
      };
    }
    setIsPulseActive(false);
    return undefined;
  }, [effectiveShowNewBadge, prefersReducedMotion]);

  const formattedMahallaName = topic.mahallaName.toLowerCase().includes('маҳалла')
    ? topic.mahallaName
    : `${topic.mahallaName} маҳалласи`;

  const mahallaColor = useMemo(() => getMahallaColor(topic.mahallaName), [topic.mahallaName]);

  const formattedDate = formatTashkentCalendarDate(topic.calendarDay);
  const timeStr = formatTashkentTime(topic.latestMeaningfulActivityTimestamp);
  const formattedTimestamp = timeStr ? `${formattedDate}, ${timeStr}` : formattedDate;

  const isInteractive = Boolean(onClick);
  const isElevated = isInteractive && isHovered;

  return (
    <article
      id={`topic-card-${topic.id}`}
      role={onClick ? 'button' : undefined}
      aria-pressed={onClick ? isSelected : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={isInteractive ? () => setIsHovered(true) : undefined}
      onMouseLeave={isInteractive ? () => setIsHovered(false) : undefined}
      onFocus={(e) => {
        if (e.target !== e.currentTarget) return;
        setIsFocused(true);
      }}
      onBlur={(e) => {
        if (e.target !== e.currentTarget) return;
        setIsFocused(false);
      }}
      style={{
        backgroundColor: isPulseActive ? '#FFFBFB' : themeColors.colorBgLaneTrack,
        border: `1px solid ${
          isSelected || isFocused
            ? themeColors.colorPrimary
            : isPulseActive
              ? '#FECACA'
              : isElevated
                ? themeColors.colorBorderInput
                : themeColors.colorBorder
        }`,
        borderRadius: 8,
        padding: '16px',
        marginBottom: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        cursor: isInteractive ? 'pointer' : 'default',
        boxShadow: isElevated
          ? themeColors.shadowCardHover
          : isPulseActive
            ? '0 0 0 2px #FECACA, 0 4px 6px -1px rgba(220, 38, 38, 0.08)'
            : themeColors.shadowCard,
        outline: isSelected || isFocused ? `2px solid ${themeColors.colorPrimary}` : 'none',
        outlineOffset: isSelected || isFocused ? '2px' : undefined,
        transition: prefersReducedMotion
          ? 'none'
          : 'border-color 0.3s ease, box-shadow 0.6s ease, background-color 0.6s ease',
      }}
      aria-current={isSelected ? 'true' : undefined}
      aria-label={
        topic.summary === null
          ? `Мавзу: ${formattedMahallaName}, хулоса тайёрланмоқда`
          : `Мавзу: ${formattedMahallaName}, ${topic.summary}`
      }
    >
      {/* Header: Mahalla name + Badges (New / Updated / Search Match) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '6px 8px',
        }}
      >
        <Space size={6} style={{ minWidth: 120, flex: '1 1 auto', overflow: 'hidden' }}>
          <EnvironmentOutlined style={{ color: '#0284C7', fontSize: 13 }} />
          <Text
            strong
            style={{
              fontSize: 13,
              color: mahallaColor.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {formattedMahallaName}
          </Text>
        </Space>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flexShrink: 0, alignItems: 'center', marginLeft: 'auto' }}>
          {/* Match Badges (AC 2) */}
          {topic.searchMatchBadge === 'evidence' && (
            <Tag
              style={{
                backgroundColor: '#FEF3C7',
                color: '#B45309',
                borderColor: '#FDE68A',
                fontWeight: 500,
                fontSize: 11,
                margin: 0,
                borderRadius: 4,
              }}
            >
              Далилда топилди
            </Tag>
          )}
          {topic.searchMatchBadge === 'author' && (
            <Tag
              style={{
                backgroundColor: '#E0E7FF',
                color: '#4338CA',
                borderColor: '#C7D2FE',
                fontWeight: 500,
                fontSize: 11,
                margin: 0,
                borderRadius: 4,
              }}
            >
              Фойдаланувчида топилди
            </Tag>
          )}
          {effectiveShowNewBadge && (
            <Tag
              color="#DC2626"
              style={{
                backgroundColor: '#FEE2E2',
                color: '#DC2626',
                borderColor: '#FECACA',
                fontWeight: 600,
                fontSize: 12,
                margin: 0,
                borderRadius: 4,
              }}
            >
              Янги мавзу
            </Tag>
          )}
        </div>
      </div>

      {/* Summary Body (Progressive Loading with Skeleton / Graceful Degradation / Highlighted Text) */}
      <TopicSummaryBody
        summary={topic.summary}
        createdAt={topic.createdAt}
        searchQuery={searchQuery}
        fontSize={14}
        lineHeight="20px"
        fontWeight={500}
        color="#0F172A"
      />

      {/* Dynamic Contextual Latest Message Update (gated to evidenceCount >= 2) */}
      <TopicLatestUpdateCallout
        latestUpdate={topic.latestUpdate}
        evidenceCount={topic.evidenceCount}
        timestamp={topic.latestMeaningfulActivityTimestamp}
        searchQuery={searchQuery}
      />

      {/* Hokim Appeal Micro-Chip & Additional Lanes */}
      {(() => {
        const hasHokimAdditional = topic.additionalLanes?.includes('HOKIM_RELATED');
        const otherAdditionalLanes =
          topic.additionalLanes?.filter((l) => l !== 'HOKIM_RELATED') || [];

        if (!hasHokimAdditional && otherAdditionalLanes.length === 0) {
          return null;
        }

        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {hasHokimAdditional && (
              <Tag
                onClick={(e) => {
                  e.stopPropagation();
                  if (onSelectHokimChip) {
                    onSelectHokimChip(topic);
                  } else if (onClick) {
                    onClick();
                  }
                }}
                style={{
                  backgroundColor: '#FEE2E2',
                  color: '#DC2626',
                  borderColor: '#FECACA',
                  cursor: isInteractive ? 'pointer' : 'default',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  borderRadius: 4,
                  fontWeight: 500,
                  fontSize: 11,
                  margin: 0,
                  padding: '1px 7px',
                }}
              >
                <BankOutlined style={{ fontSize: 11 }} />
                <span>Ҳокимга мурожаат бор</span>
              </Tag>
            )}

            {otherAdditionalLanes.length > 0 && (
              <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                <Text style={{ fontSize: 12, color: '#64748B' }}>Қўшимча:</Text>
                {otherAdditionalLanes.map((lane) => {
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
                        fontWeight: 500,
                        margin: 0,
                        borderRadius: 4,
                      }}
                    >
                      {label}
                    </Tag>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* Footer: Evidence Count & Latest Activity Timestamp */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 6,
          paddingTop: 8,
          borderTop: `1px solid ${themeColors.colorBorder}`,
          marginTop: 2,
        }}
      >
        <Space size={6} style={{ color: themeColors.colorTextSecondary, fontSize: 13, alignItems: 'center' }}>
          <MessageOutlined style={{ fontSize: 13, color: themeColors.colorTextMuted }} />
          <Text style={{ fontSize: 13, color: themeColors.colorTextSecondary }}>
            <span style={{ fontWeight: 600, color: themeColors.colorText }}>{displayedEvidenceCount}</span> та хабар
          </Text>
          {effectiveUnreadDelta !== null && (
            <span
              style={{
                backgroundColor: themeColors.colorWarningBg,
                color: themeColors.colorWarning,
                border: '1px solid #FDE68A',
                borderRadius: 10,
                padding: '0 6px',
                fontSize: 11,
                fontWeight: 700,
                lineHeight: '16px',
                display: 'inline-flex',
                alignItems: 'center',
                userSelect: 'none',
              }}
              aria-label={
                effectiveUnreadDelta === '+'
                  ? 'Янги хабарлар мавжуд'
                  : `${effectiveUnreadDelta} та янги хабар`
              }
            >
              {effectiveUnreadDelta === '+' ? '+' : `+${effectiveUnreadDelta}`}
            </span>
          )}
        </Space>

        {formattedTimestamp && (
          <Space size={4} style={{ color: themeColors.colorTextSecondary, fontSize: 13 }}>
            <ClockCircleOutlined style={{ fontSize: 13, color: themeColors.colorTextMuted }} />
            <Text style={{ fontSize: 13, color: themeColors.colorTextSecondary }}>{formattedTimestamp}</Text>
          </Space>
        )}
      </div>
    </article>
  );
};

export const TopicCard = React.memo(TopicCardComponent);

