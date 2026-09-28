import React, { useState, useEffect, useRef } from 'react';
import { Select, Input, Button, Space, theme } from 'antd';
import { SearchOutlined, ClearOutlined, LoadingOutlined } from '@ant-design/icons';
import {
  DateFilterScope,
  QualifyingLane,
  DistrictTopicsSearchBody,
  CANONICAL_LANES,
} from '@mahalla-ovozi/api-contracts';
import { DateScopeSelect } from '../../topics/DateScopeSelect.js';
import { LaneMultiSelect } from '../../topics/LaneMultiSelect.js';

export interface DistrictTopicFilterBarProps {
  filter: DistrictTopicsSearchBody;
  mahallaOptions: string[];
  isLoadingMahallas?: boolean;
  onFilterChange: (nextFilter: DistrictTopicsSearchBody) => void;
  onResetFilters: () => void;
  disabled?: boolean;
}

export const DistrictTopicFilterBar: React.FC<DistrictTopicFilterBarProps> = ({
  filter,
  mahallaOptions,
  isLoadingMahallas = false,
  onFilterChange,
  onResetFilters,
  disabled = false,
}) => {
  const { token } = theme.useToken();
  const [searchInput, setSearchInput] = useState<string>(filter.search || '');
  const [isDebouncing, setIsDebouncing] = useState(false);

  const filterRef = useRef(filter);
  filterRef.current = filter;
  const onFilterChangeRef = useRef(onFilterChange);
  onFilterChangeRef.current = onFilterChange;

  // Sync internal search input with incoming prop
  useEffect(() => {
    setSearchInput(filter.search || '');
  }, [filter.search]);

  // Debounce search input changes (300ms)
  useEffect(() => {
    const trimmed = searchInput.trim();
    const currentPropSearch = filterRef.current.search?.trim() || '';

    if (trimmed === currentPropSearch) {
      setIsDebouncing(false);
      return;
    }

    setIsDebouncing(true);
    const timer = setTimeout(() => {
      setIsDebouncing(false);
      onFilterChangeRef.current({
        ...filterRef.current,
        search: trimmed.length > 0 ? trimmed : undefined,
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [searchInput]);

  const handleDateScopeChange = (scope: {
    dateScope: DateFilterScope;
    dateFrom?: string;
    dateTo?: string;
  }) => {
    onFilterChange({
      ...filter,
      dateScope: scope.dateScope,
      dateFrom: scope.dateFrom,
      dateTo: scope.dateTo,
    });
  };

  const handleMahallaChange = (value: string | undefined) => {
    onFilterChange({
      ...filter,
      mahallaName: value && value !== 'all' ? value : undefined,
    });
  };

  const handleLanesChange = (lanes: QualifyingLane[]) => {
    onFilterChange({
      ...filter,
      lanes: lanes.length === CANONICAL_LANES.length ? undefined : lanes,
    });
  };

  const isCustomFilterActive =
    (filter.dateScope && filter.dateScope !== 'today') ||
    Boolean(filter.mahallaName) ||
    Boolean(filter.lanes && filter.lanes.length < CANONICAL_LANES.length) ||
    Boolean(filter.search && filter.search.trim().length > 0);

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        backgroundColor: token.colorBgContainer,
        borderRadius: 8,
        border: `1px solid ${token.colorBorderSecondary}`,
        marginBottom: 16,
      }}
    >
      <Space wrap size={10} style={{ alignItems: 'center' }}>
        {/* Date Scope Selector */}
        <DateScopeSelect
          dateScope={filter.dateScope || 'today'}
          dateFrom={filter.dateFrom}
          dateTo={filter.dateTo}
          onChange={handleDateScopeChange}
          disabled={disabled}
        />

        {/* Mahalla Dropdown */}
        <Select
          value={filter.mahallaName || 'all'}
          onChange={handleMahallaChange}
          disabled={disabled || isLoadingMahallas}
          loading={isLoadingMahallas}
          style={{ width: 180, height: 36 }}
          placeholder="Маҳалла"
          options={[
            { label: 'Барча маҳаллалар', value: 'all' },
            ...mahallaOptions.map((m) => ({ label: m, value: m })),
          ]}
          showSearch
          optionFilterProp="label"
          aria-label="Маҳаллани танлаш"
        />

        {/* Lanes Multi-Select */}
        <LaneMultiSelect
          value={filter.lanes || [...CANONICAL_LANES]}
          onChange={handleLanesChange}
          disabled={disabled}
        />
      </Space>

      <Space wrap size={10} style={{ alignItems: 'center' }}>
        {/* Debounced Plain-Text Search Input */}
        <Input
          placeholder="Мавзу, далил ёки муаллиф..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          disabled={disabled}
          allowClear
          prefix={
            isDebouncing ? (
              <LoadingOutlined style={{ color: '#0284C7' }} />
            ) : (
              <SearchOutlined style={{ color: '#94A3B8' }} />
            )
          }
          style={{
            width: 240,
            height: 36,
            borderRadius: 6,
          }}
          aria-label="Мавзулар бўйича қидирув"
        />

        {/* Reset Filters Button */}
        {isCustomFilterActive && (
          <Button
            icon={<ClearOutlined />}
            onClick={() => {
              setSearchInput('');
              onResetFilters();
            }}
            disabled={disabled}
            style={{
              height: 36,
              borderRadius: 6,
            }}
            aria-label="Фильтрларни тозалаш"
          >
            Тозалаш
          </Button>
        )}
      </Space>
    </div>
  );
};
