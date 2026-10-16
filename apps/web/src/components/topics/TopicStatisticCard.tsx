import React, { useState, useEffect } from 'react';
import { Skeleton, Popover } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { TopicStatisticCard1Comparison } from '@mahalla-ovozi/api-contracts';
import { themeColors } from '../../theme/antd-theme.js';

export interface TopicStatisticCardPopoverProps {
  title: string;
  subtitle?: string;
  items: string[];
}

export interface TopicStatisticCardProps {
  id?: string;
  title: string;
  value: string | number;
  subtitle: string;
  icon: React.ReactNode;
  iconBgColor: string;
  iconColor?: string;
  isLoading?: boolean;
  comparison?: TopicStatisticCard1Comparison;
  hasComparisonSlot?: boolean;
  popover?: TopicStatisticCardPopoverProps;
  cyclingItems?: string[];
}

export const TopicStatisticCard: React.FC<TopicStatisticCardProps> = ({
  id,
  title,
  value,
  subtitle,
  icon,
  iconBgColor,
  iconColor,
  isLoading = false,
  comparison,
  hasComparisonSlot = false,
  popover,
  cyclingItems,
}) => {
  const hasCycling = Boolean(cyclingItems && cyclingItems.length > 1);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const cyclingKey = cyclingItems?.join('|') ?? '';

  useEffect(() => {
    setCurrentIndex(0);
  }, [cyclingKey]);

  useEffect(() => {
    if (!hasCycling || !cyclingItems || cyclingItems.length <= 1) {
      return;
    }

    if (isPaused) {
      return;
    }

    const itemCount = cyclingItems.length;
    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % itemCount);
    }, 3500);

    return () => clearInterval(timer);
  }, [hasCycling, cyclingKey, isPaused, cyclingItems]);
  if (isLoading) {
    const showComparisonSkeleton = hasComparisonSlot || comparison !== undefined;
    return (
      <div
        id={id}
        tabIndex={-1}
        role="group"
        aria-label={`${title}: Юкланмоқда...`}
        style={{
          backgroundColor: '#FFFFFF',
          border: '1px solid #E2E8F0',
          borderRadius: 8,
          padding: '8px 12px',
          boxShadow: themeColors.shadowCard,
          minHeight: 76,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          outline: 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 2,
          }}
        >
          <Skeleton.Input active size="small" style={{ width: 70, height: 14 }} />
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              backgroundColor: iconBgColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: 0.6,
            }}
          />
        </div>
        <Skeleton.Input active size="small" style={{ width: 45, height: 22, margin: '2px 0' }} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
          }}
        >
          <Skeleton.Input active size="small" style={{ width: 80, height: 12 }} />
          {showComparisonSkeleton && (
            <Skeleton.Input active size="small" style={{ width: 70, height: 12 }} />
          )}
        </div>
      </div>
    );
  }

  const displayValue =
    hasCycling && cyclingItems ? (cyclingItems[currentIndex % cyclingItems.length] ?? value) : value;

  const isLongTextValue =
    (hasCycling && cyclingItems?.some((item) => item.length > 12 || item.includes('•'))) ||
    (typeof displayValue === 'string' && (displayValue.length > 12 || displayValue.includes('•')));

  // Build accessible ARIA description
  let ariaLabel = `${title}: ${displayValue} ${subtitle}`;
  if (popover && popover.items.length > 0) {
    ariaLabel = `${title}: ${displayValue} ${subtitle}. ${popover.title}: ${popover.items.join(', ')}`;
  } else if (hasCycling && cyclingItems) {
    ariaLabel = `${title}: ${displayValue} ${subtitle}. Соҳалар: ${cyclingItems.join(', ')}`;
  }
  if (comparison) {
    if (comparison.isAvailable) {
      const deltaText =
        comparison.delta > 0
          ? `${comparison.delta} та кўп (+${comparison.delta})`
          : comparison.delta < 0
            ? `${Math.abs(comparison.delta)} та кам (${comparison.delta})`
            : 'ўзгаришсиз (0)';
      ariaLabel = `${title}: ${value} та, ${subtitle}. ${comparison.comparisonPeriodLabel} ${deltaText}`;
    } else {
      if (comparison.reason === 'UNSUPPORTED_FILTER_SCOPE') {
        ariaLabel = `${title}: ${value} та, ${subtitle}. Таққослаш мавжуд эмас: барча йўналишлар танланмаган ёки қидирув фаол`;
      } else if (comparison.reason === 'OUTSIDE_RETENTION_WINDOW') {
        ariaLabel = `${title}: ${value} та, ${subtitle}. Таққослаш мавжуд эмас: 90 кунлик сақлаш муддатидан ташқарида`;
      } else {
        ariaLabel = `${title}: ${value} та, ${subtitle}. Таққослаш мавжуд эмас`;
      }
    }
  }

  const cyclingStepBadge = hasCycling && cyclingItems ? (
    <span
      data-testid="cycling-step-badge"
      aria-hidden="true"
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: '#8c8c8c',
        marginLeft: 6,
        padding: '1px 5px',
        borderRadius: 4,
        background: 'rgba(0,0,0,0.04)',
        flexShrink: 0,
      }}
    >
      {currentIndex + 1}/{cyclingItems.length}
    </span>
  ) : null;

  const popoverContent = popover ? (
    <div style={{ maxWidth: 260, padding: '2px 0' }} data-testid="statistic-card-popover-content">
      <div
        style={{
          fontWeight: 600,
          fontSize: 13,
          color: '#0F172A',
          lineHeight: '18px',
        }}
      >
        {popover.title}
      </div>
      {popover.subtitle && (
        <div
          style={{
            fontSize: 11,
            color: '#64748B',
            marginTop: 2,
            marginBottom: 6,
            lineHeight: '14px',
          }}
        >
          {popover.subtitle}
        </div>
      )}
      <div
        style={{
          maxHeight: 240,
          overflowY: 'auto',
          marginTop: popover.subtitle ? 0 : 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          paddingRight: 4,
        }}
        data-testid="popover-items-list"
      >
        {popover.items.map((item, index) => (
          <div
            key={`${item}-${index}`}
            style={{
              fontSize: 12,
              lineHeight: '18px',
              color: '#334155',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span
              style={{
                width: 4,
                height: 4,
                borderRadius: '50%',
                backgroundColor: '#94A3B8',
                flexShrink: 0,
              }}
              aria-hidden="true"
            />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={item}
            >
              {item}
            </span>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <div
      id={id}
      tabIndex={-1}
      role="group"
      aria-label={ariaLabel}
      onMouseEnter={hasCycling ? () => setIsPaused(true) : undefined}
      onMouseLeave={hasCycling ? () => setIsPaused(false) : undefined}
      onTouchStart={hasCycling ? () => setIsPaused(true) : undefined}
      onTouchEnd={hasCycling ? () => setIsPaused(false) : undefined}
      style={{
        backgroundColor: '#FFFFFF',
        border: '1px solid #E2E8F0',
        borderRadius: 8,
        padding: '8px 12px',
        boxShadow: themeColors.shadowCard,
        minHeight: 76,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        outline: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 2,
        }}
        aria-hidden="true"
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: '#64748B',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={title}
        >
          {title}
        </span>
        <div
          style={{
            width: 28,
            height: 28,
            minWidth: 28,
            borderRadius: 6,
            backgroundColor: iconBgColor,
            color: iconColor,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
          }}
          aria-hidden="true"
        >
          {icon}
        </div>
      </div>

      {popover ? (
        <Popover
          content={popoverContent}
          trigger={['hover', 'click']}
          placement="bottom"
          overlayStyle={{ zIndex: 1050 }}
        >
          <button
            type="button"
            data-testid="statistic-card-popover-trigger"
            aria-label={`${title}: ${displayValue}. ${popover.title}. Батафсил кўриш учун босинг.`}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              margin: 0,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              maxWidth: '100%',
              minHeight: 26,
              textAlign: 'left',
              font: 'inherit',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <span
              key={hasCycling ? currentIndex : undefined}
              aria-live={hasCycling ? 'polite' : undefined}
              style={{
                fontSize: isLongTextValue ? 16 : 22,
                fontWeight: 600,
                lineHeight: isLongTextValue ? '22px' : '26px',
                color: '#0F172A',
                fontVariantNumeric: 'tabular-nums',
                fontFeatureSettings: '"tnum"',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                opacity: 1,
                transition: 'opacity 0.3s ease-in-out',
              }}
              title={typeof displayValue === 'string' ? displayValue : String(displayValue)}
            >
              {displayValue}
            </span>
            {cyclingStepBadge}
            <InfoCircleOutlined
              style={{
                fontSize: 13,
                color: '#64748B',
                flexShrink: 0,
              }}
              aria-hidden="true"
            />
          </button>
        </Popover>
      ) : (
        <div
          style={{
            fontSize: isLongTextValue ? 16 : 22,
            fontWeight: 600,
            lineHeight: isLongTextValue ? '22px' : '26px',
            color: '#0F172A',
            fontVariantNumeric: 'tabular-nums',
            fontFeatureSettings: '"tnum"',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            minHeight: 26,
          }}
          title={typeof displayValue === 'string' ? displayValue : String(displayValue)}
          aria-hidden={hasCycling ? undefined : 'true'}
        >
          <span
            key={hasCycling ? currentIndex : undefined}
            aria-live={hasCycling ? 'polite' : undefined}
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: 1,
              transition: 'opacity 0.3s ease-in-out',
            }}
          >
            {displayValue}
          </span>
          {cyclingStepBadge}
        </div>
      )}

      {/* Bottom row: Subtitle and Optional Prior-Period Comparison Sub-block (Side-by-Side) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          overflow: 'hidden',
          minHeight: 16,
        }}
      >
        <div
          style={{
            fontSize: 12,
            lineHeight: '16px',
            color: '#64748B',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 1,
          }}
          title={subtitle}
          aria-hidden="true"
        >
          {subtitle}
        </div>

        {(comparison !== undefined || hasComparisonSlot) && (
          <div
            data-testid="card-comparison-subblock"
            style={{
              minHeight: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              lineHeight: '14px',
              color: '#64748B',
              overflow: 'hidden',
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            {comparison !== undefined ? (
              comparison.isAvailable ? (
                <>
                  <span
                    data-testid="comparison-delta-badge"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '1px 5px',
                      borderRadius: 4,
                      backgroundColor: '#F1F5F9',
                      border: '1px solid #E2E8F0',
                      color: '#334155',
                      fontWeight: 600,
                      fontSize: 11,
                      fontVariantNumeric: 'tabular-nums',
                      fontFeatureSettings: '"tnum"',
                    }}
                  >
                    {comparison.delta > 0 ? `+${comparison.delta}` : comparison.delta}
                  </span>
                  <span
                    data-testid="comparison-label"
                    style={{
                      color: '#64748B',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 130,
                    }}
                    title={comparison.comparisonPeriodLabel}
                  >
                    {comparison.comparisonPeriodLabel}
                  </span>
                </>
              ) : (
                <span
                  data-testid="comparison-unavailable"
                  style={{
                    color: '#475569',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={
                    comparison.reason === 'UNSUPPORTED_FILTER_SCOPE'
                      ? 'Барча йўналишлар танланмаган ёки қидирув фаол'
                      : comparison.reason === 'OUTSIDE_RETENTION_WINDOW'
                        ? '90 кунлик сақлаш муддатидан ташқарида'
                        : 'Маълумот мавжуд эмас'
                  }
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '1px 5px',
                      borderRadius: 4,
                      backgroundColor: '#F1F5F9',
                      border: '1px solid #E2E8F0',
                      color: '#475569',
                      fontWeight: 600,
                      fontSize: 11,
                    }}
                  >
                    —
                  </span>
                  <span>Маълумот йўқ</span>
                </span>
              )
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};
