import React from 'react';
import { Button, Tooltip, Badge } from 'antd';
import { ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { formatTashkentTime } from '../../../lib/formatters.js';

export interface SmartRefreshButtonProps {
  lastRefreshedAt?: string | null;
  isRefreshing?: boolean;
  isOffline?: boolean;
  hasProcessingDelay?: boolean;
  onRefresh?: () => void;
  prefersReducedMotion?: boolean;
}

export const SmartRefreshButton: React.FC<SmartRefreshButtonProps> = ({
  lastRefreshedAt,
  isRefreshing = false,
  isOffline = false,
  hasProcessingDelay = false,
  onRefresh,
  prefersReducedMotion = false,
}) => {
  const formattedRefreshTime = lastRefreshedAt ? formatTashkentTime(lastRefreshedAt) : null;

  return (
    <Tooltip
      title={
        <div style={{ padding: '2px 0', fontSize: 12 }}>
          <div style={{ fontWeight: 600 }}>
            {formattedRefreshTime
              ? `Охирги янгиланиш: ${formattedRefreshTime}`
              : 'Ҳали янгиланмаган'}
          </div>
          {hasProcessingDelay && (
            <div
              style={{
                color: '#F59E0B',
                marginTop: 4,
                fontSize: 11,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <WarningOutlined /> Янгиланиш давом этмоқда — айрим сўнгги хабарлар ҳали кўринмаслиги мумкин.
            </div>
          )}
          {isOffline && (
            <div style={{ color: '#EF4444', marginTop: 4, fontSize: 11 }}>
              Интернет алоқаси йўқ
            </div>
          )}
        </div>
      }
      placement="bottom"
    >
      <Badge
        dot={hasProcessingDelay}
        status="warning"
        offset={[-2, 2]}
        aria-label={
          hasProcessingDelay
            ? 'Янгиланиш давом этмоқда — айрим сўнгги хабарлар ҳали кўринмаслиги мумкин.'
            : undefined
        }
      >
        <Button
          type="default"
          icon={
            <ReloadOutlined
              spin={Boolean(isRefreshing && !prefersReducedMotion)}
              style={{
                color: isRefreshing
                  ? '#0284C7'
                  : hasProcessingDelay
                  ? '#D97706'
                  : '#64748B',
                fontSize: 14,
              }}
            />
          }
          onClick={onRefresh}
          disabled={isOffline || isRefreshing}
          loading={Boolean(isRefreshing && !prefersReducedMotion)}
          style={{
            width: 32,
            height: 32,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            borderRadius: 6,
            borderColor: '#CBD5E1',
            backgroundColor: '#FFFFFF',
            boxShadow: 'none',
          }}
          aria-label="Маълумотларни янгилаш"
        />
      </Badge>
    </Tooltip>
  );
};
