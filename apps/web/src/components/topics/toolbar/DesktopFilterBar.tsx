import React from 'react';
import { Button, Spin } from 'antd';
import { ClearOutlined, LoadingOutlined } from '@ant-design/icons';
import { DateScopeSelect } from '../DateScopeSelect.js';
import { MahallaSelect } from '../MahallaSelect.js';
import { LaneMultiSelect } from '../LaneMultiSelect.js';
import { DashboardSearchInput } from '../DashboardSearchInput.js';
import type { DashboardFilterState } from '../../../hooks/useDashboardFilterParams.js';

export interface DesktopFilterBarProps {
  filters: DashboardFilterState;
  onFilterChange: (newFilters: Partial<DashboardFilterState>) => void;
  onResetFilters?: () => void;
  isDefaultFilters?: boolean;
  isFilterLoading?: boolean;
  searchQuery?: string;
  onSearchChange?: (val: string) => void;
  canReset: boolean;
}

export const DesktopFilterBar: React.FC<DesktopFilterBarProps> = ({
  filters,
  onFilterChange,
  onResetFilters,
  isDefaultFilters: _isDefaultFilters,
  isFilterLoading = false,
  searchQuery = '',
  onSearchChange,
  canReset,
}) => {
  return (
    <nav
      aria-label="Фильтрлар панели"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'nowrap',
        overflow: 'visible',
        flexShrink: 1,
      }}
    >
      {/* Date Scope */}
      <DateScopeSelect
        dateScope={filters.dateScope}
        dateFrom={filters.dateFrom}
        dateTo={filters.dateTo}
        onChange={(scope) => {
          onFilterChange({
            dateScope: scope.dateScope,
            dateFrom: scope.dateFrom,
            dateTo: scope.dateTo,
          });
        }}
      />

      {/* Mahalla */}
      <MahallaSelect
        value={filters.mahallaName}
        onChange={(mahallaName) => onFilterChange({ mahallaName })}
        style={{ width: 165, height: 32, fontSize: 14, fontWeight: 400 }}
      />

      {/* Lane */}
      <LaneMultiSelect
        value={filters.lanes}
        onChange={(lanes) => onFilterChange({ lanes })}
        style={{ height: 32, fontSize: 14, fontWeight: 400 }}
      />

      <div style={{ width: 1, height: 18, backgroundColor: '#E2E8F0', flexShrink: 0 }} />

      {/* Topic & Evidence Search (Responsive elastic width, fits full 33-char placeholder) */}
      <DashboardSearchInput
        value={searchQuery}
        onChange={(val) => onSearchChange?.(val)}
        style={{
          width: 280,
          maxWidth: 280,
          minWidth: 180,
          flexShrink: 1,
          height: 32,
          fontSize: 14,
          fontWeight: 400,
        }}
      />

      {/* Fixed-Width Feedback & Clear Action Slot (Zero Cumulative Layout Shift) */}
      <div
        style={{
          width: 80,
          height: 32,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          flexShrink: 0,
          position: 'relative',
        }}
      >
        {/* Spinner indicator when filter is applying */}
        {isFilterLoading && (
          <div
            style={{
              position: 'absolute',
              left: 2,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <Spin indicator={<LoadingOutlined style={{ fontSize: 13, color: '#0284C7' }} spin />} />
          </div>
        )}

        {/* Clear button (smoothly transitions without altering bounding box) */}
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'inline-flex',
            alignItems: 'center',
            visibility: canReset && onResetFilters ? 'visible' : 'hidden',
            opacity: canReset && onResetFilters ? (isFilterLoading ? 0.5 : 1) : 0,
            transition: 'opacity 0.15s ease, visibility 0.15s ease',
            pointerEvents: canReset && onResetFilters && !isFilterLoading ? 'auto' : 'none',
            paddingLeft: isFilterLoading ? 18 : 0,
          }}
        >
          {onResetFilters && (
            <Button
              type="link"
              icon={!isFilterLoading ? <ClearOutlined style={{ fontSize: 12 }} /> : undefined}
              onClick={onResetFilters}
              disabled={isFilterLoading}
              style={{
                color: '#DC2626',
                fontWeight: 500,
                fontSize: 13,
                padding: '0 4px',
                height: 32,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
              aria-label="Барча фильтрларни тозалаш"
            >
              Тозалаш
            </Button>
          )}
        </div>
      </div>
    </nav>
  );
};
