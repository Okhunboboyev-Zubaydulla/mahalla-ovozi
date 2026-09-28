import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useDashboardFilterParams } from '../../src/hooks/useDashboardFilterParams.js';

describe('useDashboardFilterParams Hook Tests', () => {
  const createWrapper = (initialEntries: string[] = ['/topics']) => {
    return ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    );
  };

  it('defaults to clean state with dateScope=today and all 5 canonical lanes when no query params are present', () => {
    const { result } = renderHook(() => useDashboardFilterParams(), {
      wrapper: createWrapper(['/topics']),
    });

    expect(result.current.filters.dateScope).toBe('today');
    expect(result.current.filters.dateFrom).toBeUndefined();
    expect(result.current.filters.dateTo).toBeUndefined();
    expect(result.current.filters.mahallaName).toBeUndefined();
    expect(result.current.filters.lanes).toEqual([
      'HOKIM_RELATED',
      'WATER',
      'ELECTRICITY',
      'GAS',
      'WASTE',
    ]);
    expect(result.current.isDefaultFilters).toBe(true);
    expect(result.current.activeFilterCount).toBe(0);
  });

  it('correctly parses custom dateScope, mahalla, and lanes from URL search params', () => {
    const { result } = renderHook(() => useDashboardFilterParams(), {
      wrapper: createWrapper([
        '/topics?dateScope=custom&dateFrom=2026-08-01&dateTo=2026-08-15&mahalla=%D0%9D%D0%B0%D0%B2%D1%80%D1%9E%D0%B7&lanes=WATER,GAS',
      ]),
    });

    expect(result.current.filters.dateScope).toBe('custom');
    expect(result.current.filters.dateFrom).toBe('2026-08-01');
    expect(result.current.filters.dateTo).toBe('2026-08-15');
    expect(result.current.filters.mahallaName).toBe('Наврўз');
    expect(result.current.filters.lanes).toEqual(['WATER', 'GAS']);
    expect(result.current.isDefaultFilters).toBe(false);
    expect(result.current.activeFilterCount).toBe(3); // dateScope custom, mahalla, lanes
  });

  it('parses dateScope=yesterday', () => {
    const { result } = renderHook(() => useDashboardFilterParams(), {
      wrapper: createWrapper(['/topics?dateScope=yesterday']),
    });

    expect(result.current.filters.dateScope).toBe('yesterday');
    expect(result.current.isDefaultFilters).toBe(false);
    expect(result.current.activeFilterCount).toBe(1);
  });

  it('sanitizes invalid lane names and preserves non-zero invariant', () => {
    const { result } = renderHook(() => useDashboardFilterParams(), {
      wrapper: createWrapper(['/topics?lanes=INVALID_LANE_NAME']),
    });

    // When all provided lanes are invalid, fallback safely to all 5 canonical lanes
    expect(result.current.filters.lanes).toEqual([
      'HOKIM_RELATED',
      'WATER',
      'ELECTRICITY',
      'GAS',
      'WASTE',
    ]);
  });

  it('setFilters updates URL and omits default parameters to preserve clean URL', () => {
    let currentLocation: { search: string } = { search: '' };
    const LocationWatcher = () => {
      const location = useLocation();
      currentLocation = location;
      return null;
    };

    const { result } = renderHook(
      () => {
        const filterHook = useDashboardFilterParams();
        return filterHook;
      },
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={['/topics']}>
            <LocationWatcher />
            {children}
          </MemoryRouter>
        ),
      },
    );

    // Apply non-default filter
    act(() => {
      result.current.setFilters({
        dateScope: 'yesterday',
        mahallaName: 'Боғбон',
      });
    });

    expect(currentLocation.search).toContain('dateScope=yesterday');
    expect(currentLocation.search).toContain('mahalla=%D0%91%D0%BE%D2%93%D0%B1%D0%BE%D0%BD');

    // Setting back to default values cleans query params
    act(() => {
      result.current.setFilters({
        dateScope: 'today',
        mahallaName: undefined,
        lanes: ['HOKIM_RELATED', 'WATER', 'ELECTRICITY', 'GAS', 'WASTE'],
      });
    });

    expect(currentLocation.search).toBe('');
  });

  it('resetFilters resets URL search params cleanly', () => {
    let currentLocation: { search: string } = { search: '' };
    const LocationWatcher = () => {
      const location = useLocation();
      currentLocation = location;
      return null;
    };

    const { result } = renderHook(
      () => useDashboardFilterParams(),
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={['/topics?dateScope=yesterday&mahalla=Navruz']}>
            <LocationWatcher />
            {children}
          </MemoryRouter>
        ),
      },
    );

    expect(result.current.isDefaultFilters).toBe(false);

    act(() => {
      result.current.resetFilters();
    });

    expect(currentLocation.search).toBe('');
  });

  it('falls back dateScope to today if dateScope=custom has missing or inverted date range in URL', () => {
    const { result } = renderHook(() => useDashboardFilterParams(), {
      wrapper: createWrapper(['/topics?dateScope=custom&dateFrom=2026-08-15&dateTo=2026-08-01']),
    });

    expect(result.current.filters.dateScope).toBe('today');
    expect(result.current.filters.dateFrom).toBeUndefined();
    expect(result.current.filters.dateTo).toBeUndefined();
  });
});
