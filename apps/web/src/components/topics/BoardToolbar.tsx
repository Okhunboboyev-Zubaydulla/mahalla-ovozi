import React from 'react';
import { Button, Typography, Grid, Tooltip, Badge } from 'antd';
import {
  FilterOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion.js';
import { DashboardFilterState } from '../../hooks/useDashboardFilterParams.js';
import { LiveClock } from './toolbar/LiveClock.js';
import { MahallaOvoziLogo } from './toolbar/MahallaOvoziLogo.js';
import { DistrictBadge } from './toolbar/DistrictBadge.js';
import { DesktopFilterBar } from './toolbar/DesktopFilterBar.js';
import { SmartRefreshButton } from './toolbar/SmartRefreshButton.js';
import { HokimProfileMenu } from './toolbar/HokimProfileMenu.js';

export { MahallaOvoziLogo } from './toolbar/MahallaOvoziLogo.js';

const { Title } = Typography;
const { useBreakpoint } = Grid;

export interface BoardToolbarProps {
  districtName?: string;
  calendarDay?: string;
  lastRefreshedAt?: string | null;
  isRefreshing?: boolean;
  isOffline?: boolean;
  hasProcessingDelay?: boolean;
  onRefresh?: () => void;
  onOpenFilters?: () => void;
  activeFilterCount?: number;
  mobileFilterButtonRef?: React.RefObject<HTMLButtonElement | null>;
  onOpenHelp?: () => void;
  helpButtonRef?: React.RefObject<HTMLButtonElement | null>;
  filters?: DashboardFilterState;
  onFilterChange?: (newFilters: Partial<DashboardFilterState>) => void;
  onResetFilters?: () => void;
  isDefaultFilters?: boolean;
  isFilterLoading?: boolean;
  searchQuery?: string;
  onSearchChange?: (val: string) => void;
}

export const BoardToolbar: React.FC<BoardToolbarProps> = ({
  districtName = 'Туман',
  calendarDay: _calendarDay,
  lastRefreshedAt,
  isRefreshing = false,
  isOffline = false,
  hasProcessingDelay = false,
  onRefresh,
  onOpenFilters,
  activeFilterCount = 0,
  mobileFilterButtonRef,
  onOpenHelp,
  helpButtonRef,
  filters,
  onFilterChange,
  onResetFilters,
  isDefaultFilters = true,
  isFilterLoading = false,
  searchQuery = '',
  onSearchChange,
}) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const screens = useBreakpoint();
  const isDesktop = screens.lg ?? true;
  const isPhone = Boolean(screens.xs);
  const isMobile = !isDesktop;

  const isSearchActive = Boolean(searchQuery.trim());
  const canReset = !isDefaultFilters || isSearchActive;

  return (
    <header
      aria-labelledby="dashboard-main-heading"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        backgroundColor: '#FFFFFF',
        borderBottom: '1px solid #E2E8F0',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: 'none',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: isPhone ? '8px 12px' : '8px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: isPhone ? 8 : 12,
          minHeight: 50,
          maxHeight: 52,
        }}
      >
        {/* Left Section: Logo & District */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isPhone ? 6 : 10, minWidth: 0, flexShrink: 0 }}>
          <MahallaOvoziLogo />
          <Title
            level={4}
            id="dashboard-main-heading"
            tabIndex={-1}
            className={isPhone ? 'sr-only' : undefined}
            style={{
              margin: 0,
              color: '#0F172A',
              fontWeight: 700,
              fontSize: 18,
              outline: 'none',
              whiteSpace: 'nowrap',
              ...(isPhone
                ? {
                    position: 'absolute',
                    width: 1,
                    height: 1,
                    padding: 0,
                    margin: -1,
                    overflow: 'hidden',
                    clipPath: 'inset(50%)',
                    border: 0,
                  }
                : {}),
            }}
          >
            Маҳалла Овози
          </Title>
          {!isPhone && <div style={{ width: 1, height: 18, backgroundColor: '#E2E8F0', flexShrink: 0 }} />}
          <DistrictBadge districtName={districtName} isPhone={isPhone} />
        </div>

        {/* Subtle Vertical Divider between District and Filters */}
        {!isMobile && filters && onFilterChange && (
          <div
            aria-hidden="true"
            style={{
              width: 1,
              height: 18,
              backgroundColor: '#E2E8F0',
              flexShrink: 0,
              margin: '0 4px',
            }}
          />
        )}

        {/* Center Section: Desktop Filters (Clustered to the left) */}
        {!isMobile && filters && onFilterChange && (
          <DesktopFilterBar
            filters={filters}
            onFilterChange={onFilterChange}
            onResetFilters={onResetFilters}
            isDefaultFilters={isDefaultFilters}
            isFilterLoading={isFilterLoading}
            searchQuery={searchQuery}
            onSearchChange={onSearchChange}
            canReset={canReset}
          />
        )}

        {/* Right Section: Live Clock, Smart Refresh, Help, Profile Popover */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: isPhone ? 6 : 8,
            flexShrink: 0,
            marginLeft: 'auto',
          }}
        >
          {!isMobile && (
            <>
              <LiveClock />
              <div style={{ width: 1, height: 18, backgroundColor: '#E2E8F0' }} />
            </>
          )}

          {onOpenFilters && isMobile && (
            isPhone ? (
              <Badge
                count={activeFilterCount}
                size="small"
                offset={[-2, 2]}
                styles={{ root: { display: 'inline-flex' } }}
              >
                <Button
                  id="mobile-filter-button"
                  ref={mobileFilterButtonRef}
                  type="default"
                  icon={
                    <FilterOutlined
                      style={{ color: activeFilterCount > 0 ? '#0284C7' : '#64748B', fontSize: 14 }}
                    />
                  }
                  onClick={onOpenFilters}
                  style={{
                    width: 32,
                    height: 32,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    borderRadius: 6,
                    borderColor: activeFilterCount > 0 ? '#0284C7' : '#CBD5E1',
                    backgroundColor: activeFilterCount > 0 ? '#F0F9FF' : '#FFFFFF',
                    boxShadow: 'none',
                  }}
                  aria-label={
                    activeFilterCount > 0
                      ? `Фильтрлар: ${activeFilterCount} та фаол`
                      : 'Фильтрлар панелини очиш'
                  }
                />
              </Badge>
            ) : (
              <Button
                id="mobile-filter-button"
                ref={mobileFilterButtonRef}
                icon={
                  <FilterOutlined
                    style={{ color: activeFilterCount > 0 ? '#0284C7' : '#64748B' }}
                  />
                }
                onClick={onOpenFilters}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 500,
                  height: 30,
                  color: activeFilterCount > 0 ? '#0284C7' : '#334155',
                  borderColor: activeFilterCount > 0 ? '#0284C7' : '#CBD5E1',
                  backgroundColor: activeFilterCount > 0 ? '#F0F9FF' : '#FFFFFF',
                  boxShadow: 'none',
                }}
                aria-label={`Фильтрлар: ${activeFilterCount} та фаол`}
              >
                Фильтрлар {activeFilterCount > 0 ? `(${activeFilterCount})` : ''}
              </Button>
            )
          )}

          <SmartRefreshButton
            lastRefreshedAt={lastRefreshedAt}
            isRefreshing={isRefreshing}
            isOffline={isOffline}
            hasProcessingDelay={hasProcessingDelay}
            onRefresh={onRefresh}
            prefersReducedMotion={prefersReducedMotion}
          />

          <Tooltip title="Тизим ёрдами" placement="bottom">
            <Button
              id="dashboard-help-button"
              ref={helpButtonRef}
              type="default"
              icon={<QuestionCircleOutlined style={{ color: '#64748B', fontSize: 15 }} />}
              onClick={onOpenHelp}
              style={{
                width: 32,
                height: 32,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                color: '#64748B',
                borderColor: '#CBD5E1',
                backgroundColor: '#FFFFFF',
                boxShadow: 'none',
                borderRadius: 6,
              }}
              aria-label="Тизим ёрдами"
            />
          </Tooltip>

          {!isPhone && <div style={{ width: 1, height: 18, backgroundColor: '#E2E8F0' }} />}

          <HokimProfileMenu
            districtName={districtName}
            isMobile={isMobile}
            isPhone={isPhone}
          />
        </div>
      </div>
    </header>
  );
};
