import React from 'react';
import { Button, Space, Typography, Spin } from 'antd';
import { ClearOutlined, LoadingOutlined } from '@ant-design/icons';
import { DateScopeSelect } from './DateScopeSelect.js';
import { MahallaSelect } from './MahallaSelect.js';
import { LaneMultiSelect } from './LaneMultiSelect.js';
import { DashboardSearchInput } from './DashboardSearchInput.js';
import { DashboardFilterState } from '../../hooks/useDashboardFilterParams.js';

const { Text } = Typography;

export interface FilterBarProps {
  filters: DashboardFilterState;
  onFilterChange: (newFilters: Partial<DashboardFilterState>) => void;
  onResetFilters: () => void;
  isDefaultFilters: boolean;
  isLoading?: boolean;
  searchQuery?: string;
  onSearchChange?: (val: string) => void;
}

export const FilterBar: React.FC<FilterBarProps> = ({
  filters,
  onFilterChange,
  onResetFilters,
  isDefaultFilters,
  isLoading = false,
  searchQuery = '',
  onSearchChange,
}) => {
  const isSearchActive = Boolean(searchQuery.trim());
  const canReset = !isDefaultFilters || isSearchActive;

  return (
    <nav
      aria-label="Фильтрлар панели"
      style={{
        backgroundColor: '#FFFFFF',
        borderBottom: '1px solid #E2E8F0',
        padding: '10px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'nowrap',
        overflowX: 'auto',
        gap: 12,
        boxShadow: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'nowrap',
          flexShrink: 0,
        }}
      >
        {/* Lexical Search Input (AC 1, AC 4) */}
        <DashboardSearchInput
          value={searchQuery}
          onChange={(val) => onSearchChange?.(val)}
        />

        <div style={{ width: 1, height: 24, backgroundColor: '#E2E8F0', flexShrink: 0 }} />

        {/* Date Scope Filter */}
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

        <div style={{ width: 1, height: 24, backgroundColor: '#E2E8F0', flexShrink: 0 }} />

        {/* Mahalla Filter */}
        <MahallaSelect
          value={filters.mahallaName}
          onChange={(mahallaName) => onFilterChange({ mahallaName })}
        />

        {/* Lane Multi-Select */}
        <LaneMultiSelect
          value={filters.lanes}
          onChange={(lanes) => onFilterChange({ lanes })}
        />

        {/* Loading / Transition Spinner */}
        {isLoading && (
          <Space size={6} style={{ marginLeft: 4, flexShrink: 0 }}>
            <Spin indicator={<LoadingOutlined style={{ fontSize: 16, color: '#0284C7' }} spin />} />
            <Text type="secondary" style={{ fontSize: 13, color: '#64748B' }}>
              Юкланмоқда...
            </Text>
          </Space>
        )}
      </div>

      {/* Clear Filters Action */}
      {canReset && (
        <Button
          type="link"
          icon={<ClearOutlined />}
          onClick={onResetFilters}
          disabled={isLoading}
          style={{
            color: '#DC2626',
            fontWeight: 500,
            fontSize: 13,
            padding: '0 8px',
            height: 36,
            display: 'inline-flex',
            alignItems: 'center',
            flexShrink: 0,
          }}
          aria-label="Барча фильтрларни тозалаш"
        >
          Фильтрларни тозалаш
        </Button>
      )}
    </nav>
  );
};

