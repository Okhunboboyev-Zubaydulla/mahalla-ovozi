import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Button, Alert, Empty, Typography, Space } from 'antd';
import { ReloadOutlined, DownOutlined, UpOutlined, BankOutlined } from '@ant-design/icons';
import { TopicEvidenceItem } from '@mahalla-ovozi/api-contracts';
import { EvidenceItem } from './EvidenceItem.js';

const { Text } = Typography;

export interface EvidenceTimelineProps {
  evidenceList: TopicEvidenceItem[];
  totalCount: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  onFetchNextPage: () => void;
  focusHokim?: boolean;
  sentinelRef?: React.RefObject<HTMLDivElement | null>;
  topSentinelRef?: React.RefObject<HTMLDivElement | null>;
}

export const EvidenceTimeline: React.FC<EvidenceTimelineProps> = ({
  evidenceList,
  totalCount,
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  onFetchNextPage,
  focusHokim,
  sentinelRef,
  topSentinelRef,
}) => {
  const effectiveFocusHokim = focusHokim ?? false;
  const hokimEvidenceIds = useMemo(() => {
    return evidenceList.filter((e) => e.isHokimRelated).map((e) => e.id);
  }, [evidenceList]);

  const [targetedId, setTargetedId] = useState<string | null>(null);
  const [activeHokimIndex, setActiveHokimIndex] = useState<number>(0);
  const hasAutoScrolledRef = useRef<boolean>(false);

  useEffect(() => {
    if (effectiveFocusHokim && hokimEvidenceIds.length > 0 && !hasAutoScrolledRef.current) {
      hasAutoScrolledRef.current = true;
      const firstId = hokimEvidenceIds[0]!;
      setTargetedId(firstId);
      setActiveHokimIndex(0);

      const timer = setTimeout(() => {
        const element = document.getElementById(`evidence-item-${firstId}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 150);

      const pulseTimer = setTimeout(() => {
        setTargetedId(null);
      }, 2200);

      return () => {
        clearTimeout(timer);
        clearTimeout(pulseTimer);
      };
    }
    return undefined;
  }, [focusHokim, hokimEvidenceIds]);

  if (evidenceList.length === 0) {
    return (
      <div style={{ padding: '32px 16px', textAlign: 'center' }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text style={{ color: '#64748B', fontSize: 14 }}>
              Ушбу мавзу бўйича сақланган далиллар топилмади.
            </Text>
          }
        />
      </div>
    );
  }

  const handleJumpToHokimIndex = (index: number) => {
    if (index < 0 || index >= hokimEvidenceIds.length) return;
    setActiveHokimIndex(index);
    const targetId = hokimEvidenceIds[index]!;
    setTargetedId(targetId);
    const element = document.getElementById(`evidence-item-${targetId}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setTimeout(() => {
      setTargetedId(null);
    }, 2000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
      {/* Sticky Multi-Match Navigator Toolbar when 2+ Hokim messages exist */}
      {hokimEvidenceIds.length >= 2 && (
        <div
          style={{
            position: 'sticky',
            top: 48,
            zIndex: 10,
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 6,
            backgroundColor: '#FEF2F2',
            border: '1px solid #FECACA',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxShadow: '0 2px 4px rgba(220, 38, 38, 0.06)',
          }}
        >
          <Space size={6}>
            <BankOutlined style={{ color: '#DC2626', fontSize: 13 }} />
            <Text style={{ fontSize: 12, fontWeight: 600, color: '#991B1B' }}>
              Ҳокимга оид {hokimEvidenceIds.length} та хабар мавжуд ({activeHokimIndex + 1}/{hokimEvidenceIds.length})
            </Text>
          </Space>

          <Space size={4}>
            <Button
              size="small"
              icon={<UpOutlined style={{ fontSize: 10 }} />}
              disabled={activeHokimIndex === 0}
              onClick={() => handleJumpToHokimIndex(activeHokimIndex - 1)}
              style={{ fontSize: 11, height: 26, padding: '0 8px' }}
              aria-label="Олдинги ҳоким мурожаати"
            >
              Олдингиси
            </Button>
            <Button
              size="small"
              icon={<DownOutlined style={{ fontSize: 10 }} />}
              disabled={activeHokimIndex >= hokimEvidenceIds.length - 1}
              onClick={() => handleJumpToHokimIndex(activeHokimIndex + 1)}
              style={{ fontSize: 11, height: 26, padding: '0 8px' }}
              aria-label="Кейинги ҳоким мурожаати"
            >
              Кейингиси
            </Button>
          </Space>
        </div>
      )}

      {/* Zero-height focusable top sentinel for IntersectionObserver and a11y keyboard anchoring */}
      <div
        ref={topSentinelRef}
        id="evidence-top-sentinel"
        tabIndex={-1}
        aria-hidden="true"
        style={{ height: 1, outline: 'none', pointerEvents: 'none' }}
      />

      {/* Chronological list of evidence items (oldest to newest or newest to oldest) */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {evidenceList.map((evidence) => (
          <EvidenceItem
            key={evidence.id}
            evidence={evidence}
            isTargetedPulse={evidence.id === targetedId}
          />
        ))}
      </div>

      {/* Scoped Error / Retry State for Progressive Continuation (AC 3) */}
      {isFetchNextPageError && (
        <div style={{ marginTop: 8, marginBottom: 12 }}>
          <Alert
            message="Қўшимча далилларни юклаб бўлмади."
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
                onClick={onFetchNextPage}
                style={{ fontWeight: 600, fontSize: 12, boxShadow: 'none' }}
              >
                Қайта уриниш
              </Button>
            }
          />
        </div>
      )}

      {/* Keyset Pagination Continuation Button (AC 3) */}
      {hasNextPage && !isFetchNextPageError && (
        <div style={{ marginTop: 4, marginBottom: 16, textAlign: 'center' }}>
          <Button
            block
            onClick={onFetchNextPage}
            loading={isFetchingNextPage}
            icon={!isFetchingNextPage ? <DownOutlined style={{ fontSize: 12 }} /> : undefined}
            style={{
              backgroundColor: '#FFFFFF',
              borderColor: '#CBD5E1',
              color: '#0F172A',
              fontWeight: 600,
              fontSize: 13,
              height: 38,
              borderRadius: 6,
              boxShadow: 'none',
            }}
          >
            {isFetchingNextPage
              ? 'Юкланмоқда...'
              : `Яна кўрсатиш (${evidenceList.length} / ${Math.max(totalCount, evidenceList.length)})`}
          </Button>
        </div>
      )}

      {/* Zero-height focusable bottom sentinel for IntersectionObserver and a11y keyboard anchoring */}
      <div
        ref={sentinelRef}
        id="evidence-bottom-sentinel"
        tabIndex={-1}
        aria-hidden="true"
        style={{ height: 1, outline: 'none', pointerEvents: 'none' }}
      />
    </div>
  );
};
