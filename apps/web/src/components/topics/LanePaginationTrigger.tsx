import React from 'react';
import { Button, Alert } from 'antd';
import { ReloadOutlined, DownOutlined } from '@ant-design/icons';
import { QualifyingLane } from '@mahalla-ovozi/api-contracts';

export interface LanePaginationTriggerProps {
  lane: QualifyingLane;
  laneLabel: string;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: (lane: QualifyingLane) => void;
  onTriggerKeyboard?: () => void;
}

export const LanePaginationTriggerComponent: React.FC<LanePaginationTriggerProps> = ({
  lane,
  laneLabel,
  hasNextPage,
  isLoadingMore,
  loadMoreError,
  onLoadMore,
  onTriggerKeyboard,
}) => {
  return (
    <>
      {/* Local Failure Retry Banner (Preserving existing cards) */}
      {loadMoreError && (
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          <Alert
            message={loadMoreError}
            type="error"
            showIcon
            style={{
              fontSize: 13,
              borderRadius: 6,
              border: '1px solid #FECACA',
              backgroundColor: '#FEE2E2',
              boxShadow: 'none',
            }}
            action={
              <Button
                size="small"
                type="text"
                danger
                icon={<ReloadOutlined />}
                onClick={(e) => {
                  if (e.detail === 0 && onTriggerKeyboard) {
                    onTriggerKeyboard();
                  }
                  onLoadMore(lane);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    if (onTriggerKeyboard) onTriggerKeyboard();
                  }
                }}
                style={{ fontWeight: 600, fontSize: 12, boxShadow: 'none' }}
              >
                Қайта уриниш
              </Button>
            }
          />
        </div>
      )}

      {/* Keyset Pagination Load More Button */}
      {hasNextPage && !loadMoreError && (
        <div style={{ marginTop: 4, marginBottom: 8, textAlign: 'center' }}>
          <Button
            block
            onClick={(e) => {
              if (e.detail === 0 && onTriggerKeyboard) {
                onTriggerKeyboard();
              }
              onLoadMore(lane);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                if (onTriggerKeyboard) onTriggerKeyboard();
              }
            }}
            loading={isLoadingMore}
            icon={!isLoadingMore ? <DownOutlined style={{ fontSize: 12 }} /> : undefined}
            aria-label={`${laneLabel} бўйича яна 20 та мавзуни юклаш`}
            style={{
              backgroundColor: '#FFFFFF',
              borderColor: '#CBD5E1',
              color: '#0F172A',
              fontWeight: 600,
              fontSize: 13,
              minHeight: 44,
              height: 44,
              borderRadius: 6,
              boxShadow: 'none',
            }}
            onFocus={(e) => {
              e.currentTarget.style.outline = '2px solid #0284C7';
              e.currentTarget.style.outlineOffset = '2px';
            }}
            onBlur={(e) => {
              e.currentTarget.style.outline = 'none';
            }}
          >
            {isLoadingMore ? 'Юкланмоқда...' : 'Яна кўрсатиш'}
          </Button>
        </div>
      )}
    </>
  );
};

export const LanePaginationTrigger = React.memo(LanePaginationTriggerComponent);
