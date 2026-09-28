import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useLaneOrderPreference,
  reconcileLaneOrder,
  CANONICAL_LANE_ORDER,
  getLaneOrderStorageKey,
} from './useLaneOrderPreference.js';
import { QualifyingLane } from '@mahalla-ovozi/api-contracts';

describe('reconcileLaneOrder', () => {
  it('returns canonical order when given non-array inputs', () => {
    expect(reconcileLaneOrder(null)).toEqual(CANONICAL_LANE_ORDER);
    expect(reconcileLaneOrder(undefined)).toEqual(CANONICAL_LANE_ORDER);
    expect(reconcileLaneOrder('random-string')).toEqual(CANONICAL_LANE_ORDER);
    expect(reconcileLaneOrder({ foo: 'bar' })).toEqual(CANONICAL_LANE_ORDER);
  });

  it('filters out invalid lane strings and appends missing canonical lanes', () => {
    const raw = ['GAS', 'UNKNOWN_LANE', 'WATER', 123];
    const result = reconcileLaneOrder(raw);
    expect(result).toEqual(['GAS', 'WATER', 'HOKIM_RELATED', 'ELECTRICITY', 'WASTE']);
  });

  it('deduplicates duplicate lanes', () => {
    const raw = ['GAS', 'GAS', 'WATER', 'GAS'];
    const result = reconcileLaneOrder(raw);
    expect(result).toEqual(['GAS', 'WATER', 'HOKIM_RELATED', 'ELECTRICITY', 'WASTE']);
  });

  it('preserves complete valid custom order', () => {
    const custom: QualifyingLane[] = ['WASTE', 'GAS', 'ELECTRICITY', 'WATER', 'HOKIM_RELATED'];
    expect(reconcileLaneOrder(custom)).toEqual(custom);
  });
});

describe('useLaneOrderPreference', () => {
  const districtId = 'dist-1';
  const userId = 'usr-1';
  const storageKey = getLaneOrderStorageKey(districtId, userId);

  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('initializes with CANONICAL_LANE_ORDER when storage is empty', () => {
    const { result } = renderHook(() => useLaneOrderPreference(districtId, userId));
    expect(result.current.laneOrder).toEqual(CANONICAL_LANE_ORDER);
  });

  it('loads valid custom order from localStorage on mount', () => {
    const customOrder: QualifyingLane[] = ['GAS', 'ELECTRICITY', 'WATER', 'WASTE', 'HOKIM_RELATED'];
    window.localStorage.setItem(storageKey, JSON.stringify(customOrder));

    const { result } = renderHook(() => useLaneOrderPreference(districtId, userId));
    expect(result.current.laneOrder).toEqual(customOrder);
  });

  it('updates laneOrder and writes to localStorage', () => {
    const { result } = renderHook(() => useLaneOrderPreference(districtId, userId));

    const newOrder: QualifyingLane[] = ['WATER', 'GAS', 'ELECTRICITY', 'WASTE', 'HOKIM_RELATED'];
    act(() => {
      result.current.setLaneOrder(newOrder);
    });

    expect(result.current.laneOrder).toEqual(newOrder);
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual(newOrder);
  });
});
