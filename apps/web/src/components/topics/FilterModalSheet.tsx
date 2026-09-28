import React, { useState, useEffect } from 'react';
import { Modal, Button, Typography, Space, Checkbox, Tag, Divider, Grid } from 'antd';
import { FilterOutlined, CheckOutlined, ClearOutlined } from '@ant-design/icons';
import { QualifyingLane, CANONICAL_LANES } from '@mahalla-ovozi/api-contracts';
import { DateScopeSelect } from './DateScopeSelect.js';
import { MahallaSelect } from './MahallaSelect.js';
import { DashboardSearchInput } from './DashboardSearchInput.js';
import { DashboardFilterState } from '../../hooks/useDashboardFilterParams.js';
import { LANE_LABELS, LANE_STYLES } from './TopicCard.js';

const { Title, Text } = Typography;

export interface FilterModalSheetProps {
  open: boolean;
  onClose: () => void;
  filters: DashboardFilterState;
  onApplyFilters: (newFilters: DashboardFilterState) => void;
  onResetFilters: () => void;
  openerRef?: React.RefObject<HTMLElement | null>;
  searchQuery?: string;
  onSearchChange?: (search: string) => void;
}

export const FilterModalSheet: React.FC<FilterModalSheetProps> = ({
  open,
  onClose,
  filters,
  onApplyFilters,
  onResetFilters,
  openerRef,
  searchQuery = '',
  onSearchChange,
}) => {
  const screens = Grid.useBreakpoint();
  const isMobile = Boolean(screens.xs);

  const [pendingFilters, setPendingFilters] = useState<DashboardFilterState>(filters);
  const [pendingSearch, setPendingSearch] = useState<string>(searchQuery);

  // Sync pending filters when modal opens
  useEffect(() => {
    if (open) {
      setPendingFilters(filters);
      setPendingSearch(searchQuery);
    }
  }, [open, filters, searchQuery]);

  const handleClose = () => {
    onClose();
    setTimeout(() => {
      if (typeof document !== 'undefined') {
        if (openerRef?.current) {
          openerRef.current.focus();
        } else {
          const btn = document.getElementById('mobile-filter-button');
          if (btn) {
            btn.focus();
          }
        }
      }
    }, 50);
  };

  const handleApply = () => {
    onApplyFilters(pendingFilters);
    onSearchChange?.(pendingSearch);
    handleClose();
  };

  const handleReset = () => {
    onResetFilters();
    onSearchChange?.('');
    handleClose();
  };

  const handleToggleLane = (lane: QualifyingLane, checked: boolean) => {
    if (checked) {
      const nextLanes = CANONICAL_LANES.filter(
        (l) => pendingFilters.lanes.includes(l) || l === lane,
      );
      setPendingFilters((prev) => ({ ...prev, lanes: nextLanes }));
    } else {
      if (pendingFilters.lanes.length <= 1) {
        return; // Non-zero invariant
      }
      const nextLanes = CANONICAL_LANES.filter(
        (l) => pendingFilters.lanes.includes(l) && l !== lane,
      );
      setPendingFilters((prev) => ({ ...prev, lanes: nextLanes }));
    }
  };

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      footer={null}
      centered
      width={480}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FilterOutlined style={{ color: '#0284C7', fontSize: 18 }} />
          <Title
            level={4}
            id="filter-sheet-title"
            style={{ margin: 0, fontSize: 18, color: '#0F172A' }}
          >
            Фильтрлар
          </Title>
        </div>
      }
      styles={{
        content: {
          borderRadius: 12,
          padding: isMobile ? '20px 16px' : '20px 24px',
          boxShadow: 'none',
          border: '1px solid #E2E8F0',
        },
      }}
      aria-labelledby="filter-sheet-title"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingTop: 12 }}>
        {/* 0. Lexical Search Section */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8, color: '#334155', fontSize: 14 }}>
            Қидирув
          </Text>
          <DashboardSearchInput
            value={pendingSearch}
            onChange={(val) => setPendingSearch(val)}
            style={{ maxWidth: '100%' }}
          />
        </div>

        <Divider style={{ margin: 0, borderColor: '#F1F5F9' }} />

        {/* 1. Date Scope Section */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8, color: '#334155', fontSize: 14 }}>
            Сана оралиғи
          </Text>
          <DateScopeSelect
            dateScope={pendingFilters.dateScope}
            dateFrom={pendingFilters.dateFrom}
            dateTo={pendingFilters.dateTo}
            onChange={(scope) => {
              setPendingFilters((prev) => ({
                ...prev,
                dateScope: scope.dateScope,
                dateFrom: scope.dateFrom,
                dateTo: scope.dateTo,
              }));
            }}
          />
        </div>

        <Divider style={{ margin: 0, borderColor: '#F1F5F9' }} />

        {/* 2. Mahalla Section */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8, color: '#334155', fontSize: 14 }}>
            Маҳалла
          </Text>
          <MahallaSelect
            value={pendingFilters.mahallaName}
            onChange={(mahallaName) => {
              setPendingFilters((prev) => ({ ...prev, mahallaName }));
            }}
            style={{ width: '100%' }}
          />
        </div>

        <Divider style={{ margin: 0, borderColor: '#F1F5F9' }} />

        {/* 3. Lanes Section */}
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <Text strong style={{ color: '#334155', fontSize: 14 }}>
              Йўналишлар ({pendingFilters.lanes.length}/5)
            </Text>
            {pendingFilters.lanes.length < CANONICAL_LANES.length && (
              <Button
                type="link"
                size="small"
                onClick={() => setPendingFilters((prev) => ({ ...prev, lanes: [...CANONICAL_LANES] }))}
                style={{ padding: '4px 8px', fontSize: 12, height: 'auto', color: '#0284C7' }}
              >
                Барчасини кўрсатиш
              </Button>
            )}
          </div>

          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            {CANONICAL_LANES.map((lane) => {
              const isChecked = pendingFilters.lanes.includes(lane);
              const isSoleLane = isChecked && pendingFilters.lanes.length === 1;
              const styleConfig = LANE_STYLES[lane];

              return (
                <div
                  key={lane}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderRadius: 8,
                    backgroundColor: isChecked ? '#F8FAFC' : 'transparent',
                    border: '1px solid',
                    borderColor: isChecked ? '#CBD5E1' : '#F1F5F9',
                  }}
                >
                  <Checkbox
                    checked={isChecked}
                    disabled={isSoleLane}
                    onChange={(e) => handleToggleLane(lane, e.target.checked)}
                    aria-label={LANE_LABELS[lane]}
                    style={{ width: '100%' }}
                  >
                    <Tag
                      style={{
                        backgroundColor: styleConfig.bg,
                        color: styleConfig.text,
                        borderColor: styleConfig.border,
                        borderRadius: 4,
                        fontSize: 13,
                        fontWeight: 600,
                        padding: '2px 8px',
                      }}
                    >
                      {LANE_LABELS[lane]}
                    </Tag>
                  </Checkbox>
                </div>
              );
            })}
          </Space>
        </div>

        <Divider style={{ margin: 0, borderColor: '#F1F5F9' }} />

        {/* Modal Actions Footer */}
        {isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, width: '100%' }}>
              <Button onClick={handleClose} style={{ borderRadius: 8, height: 44, fontSize: 14 }}>
                Бекор қилиш
              </Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={handleApply}
                style={{
                  borderRadius: 8,
                  height: 44,
                  fontSize: 14,
                  fontWeight: 600,
                  backgroundColor: '#0284C7',
                  boxShadow: 'none',
                }}
              >
                Қўллаш
              </Button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
              <Button
                type="text"
                icon={<ClearOutlined />}
                onClick={handleReset}
                aria-label="Барча фильтрларни тозалаш"
                style={{ color: '#DC2626', fontWeight: 500, height: 36, display: 'inline-flex', alignItems: 'center' }}
              >
                Тозалаш
              </Button>
            </div>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 4,
              width: '100%',
            }}
          >
            <Button
              type="text"
              icon={<ClearOutlined />}
              onClick={handleReset}
              aria-label="Барча фильтрларни тозалаш"
              style={{ color: '#DC2626', fontWeight: 500, height: 44, display: 'inline-flex', alignItems: 'center' }}
            >
              Тозалаш
            </Button>

            <Space size={10}>
              <Button onClick={handleClose} style={{ borderRadius: 8, height: 44 }}>
                Бекор қилиш
              </Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={handleApply}
                style={{
                  borderRadius: 8,
                  height: 44,
                  fontWeight: 600,
                  backgroundColor: '#0284C7',
                  boxShadow: 'none',
                }}
              >
                Қўллаш
              </Button>
            </Space>
          </div>
        )}
      </div>
    </Modal>
  );
};
