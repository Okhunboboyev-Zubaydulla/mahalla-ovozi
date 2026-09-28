import React from 'react';
import { Skeleton } from 'antd';
import { TopicStatisticCard1Comparison } from '@mahalla-ovozi/api-contracts';
import { themeColors } from '../../theme/antd-theme.js';

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
}) => {
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

  const isLongTextValue = typeof value === 'string' && value.length > 12;

  // Build accessible ARIA description
  let ariaLabel = `${title}: ${value} ${subtitle}`;
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

  return (
    <div
      id={id}
      tabIndex={-1}
      role="group"
      aria-label={ariaLabel}
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
        }}
        title={typeof value === 'string' ? value : String(value)}
        aria-hidden="true"
      >
        {value}
      </div>

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
