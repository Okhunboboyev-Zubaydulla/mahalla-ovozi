import { useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { QualifyingLane, DateFilterScope, CANONICAL_LANES } from '@mahalla-ovozi/api-contracts';

const VALID_LANES_SET = new Set<string>(CANONICAL_LANES);

export interface DashboardFilterState {
  dateScope: DateFilterScope;
  dateFrom?: string;
  dateTo?: string;
  mahallaName?: string;
  lanes: QualifyingLane[];
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function parseFiltersFromSearchParams(searchParams: URLSearchParams): DashboardFilterState {
  // 1. Date Range
  const rawDateFrom = searchParams.get('dateFrom');
  const rawDateTo = searchParams.get('dateTo');
  const dateFrom = rawDateFrom && DATE_REGEX.test(rawDateFrom) ? rawDateFrom : undefined;
  const dateTo = rawDateTo && DATE_REGEX.test(rawDateTo) ? rawDateTo : undefined;

  // 2. Date Scope (Fall back to today if custom is missing valid date bounds)
  const rawDateScope = searchParams.get('dateScope');
  let dateScope: DateFilterScope = 'today';
  if (rawDateScope === 'yesterday') {
    dateScope = 'yesterday';
  } else if (rawDateScope === 'custom') {
    if (dateFrom && dateTo && dateFrom <= dateTo) {
      dateScope = 'custom';
    } else {
      dateScope = 'today';
    }
  }

  // 3. Mahalla Name
  const rawMahalla = searchParams.get('mahalla') || searchParams.get('mahallaName');
  const mahallaName =
    rawMahalla && rawMahalla.trim() !== '' && rawMahalla.trim() !== 'all'
      ? rawMahalla.trim()
      : undefined;

  // 4. Lanes Multi-Select
  const rawLanes = searchParams.get('lanes');
  let lanes: QualifyingLane[] = [...CANONICAL_LANES];
  if (rawLanes) {
    const parsedLanes = rawLanes
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is QualifyingLane => VALID_LANES_SET.has(s));

    // Preserve canonical display order
    const canonicalSubset = CANONICAL_LANES.filter((l) => parsedLanes.includes(l));
    if (canonicalSubset.length > 0) {
      lanes = canonicalSubset;
    }
  }

  return {
    dateScope,
    dateFrom: dateScope === 'custom' ? dateFrom : undefined,
    dateTo: dateScope === 'custom' ? dateTo : undefined,
    mahallaName,
    lanes,
  };
}

export function useDashboardFilterParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters: DashboardFilterState = useMemo(() => {
    return parseFiltersFromSearchParams(searchParams);
  }, [searchParams]);

  const isDefaultFilters = useMemo(() => {
    return (
      filters.dateScope === 'today' &&
      !filters.mahallaName &&
      filters.lanes.length === CANONICAL_LANES.length
    );
  }, [filters]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.dateScope !== 'today') count += 1;
    if (filters.mahallaName) count += 1;
    if (filters.lanes.length < CANONICAL_LANES.length) count += 1;
    return count;
  }, [filters]);

  const setFilters = useCallback(
    (newFilters: Partial<DashboardFilterState>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const current = parseFiltersFromSearchParams(prev);
          const merged: DashboardFilterState = {
            ...current,
            ...newFilters,
          };

          // 1. Date scope
          if (merged.dateScope === 'today' || !merged.dateScope) {
            next.delete('dateScope');
            next.delete('dateFrom');
            next.delete('dateTo');
          } else if (merged.dateScope === 'yesterday') {
            next.set('dateScope', 'yesterday');
            next.delete('dateFrom');
            next.delete('dateTo');
          } else if (merged.dateScope === 'custom') {
            next.set('dateScope', 'custom');
            if (merged.dateFrom) {
              next.set('dateFrom', merged.dateFrom);
            } else {
              next.delete('dateFrom');
            }
            if (merged.dateTo) {
              next.set('dateTo', merged.dateTo);
            } else {
              next.delete('dateTo');
            }
          }

          // 2. Mahalla
          if (!merged.mahallaName || merged.mahallaName === 'all' || merged.mahallaName.trim() === '') {
            next.delete('mahalla');
            next.delete('mahallaName');
          } else {
            next.set('mahalla', merged.mahallaName.trim());
            next.delete('mahallaName');
          }

          // 3. Lanes (Non-zero invariant & clean omission when all 5)
          const validLanes = merged.lanes?.filter((l) => VALID_LANES_SET.has(l)) || [];
          if (validLanes.length === 0 || validLanes.length === CANONICAL_LANES.length) {
            next.delete('lanes');
          } else {
            // Write in canonical order
            const sortedLanes = CANONICAL_LANES.filter((l) => validLanes.includes(l));
            next.set('lanes', sortedLanes.join(','));
          }

          // Clean obsolete params if any
          next.delete('calendarDay');

          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const resetFilters = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('dateScope');
        next.delete('dateFrom');
        next.delete('dateTo');
        next.delete('mahalla');
        next.delete('mahallaName');
        next.delete('lanes');
        next.delete('calendarDay');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  return {
    filters,
    isDefaultFilters,
    activeFilterCount,
    setFilters,
    resetFilters,
  };
}
