import { useState, useEffect, useCallback } from 'react';
import {
  QualifyingLane,
  QualifyingLaneSchema,
  CANONICAL_LANES,
} from '@mahalla-ovozi/api-contracts';

/**
 * The fallback lane order for a user with no saved preference.
 * Aliases the shared contract constant; the name is kept because
 * FiveLaneBoard and this module's test both import it.
 */
export const CANONICAL_LANE_ORDER: readonly QualifyingLane[] = CANONICAL_LANES;

const STORAGE_PREFIX = 'mahalla_ovozi_lane_order_';

export function getLaneOrderStorageKey(districtId: string | undefined, userId: string | undefined): string {
  const dId = districtId ? districtId : 'default';
  const uId = userId ? userId : 'default';
  return `${STORAGE_PREFIX}${dId}_${uId}`;
}

export function reconcileLaneOrder(raw: unknown): QualifyingLane[] {
  if (!Array.isArray(raw)) {
    return [...CANONICAL_LANE_ORDER];
  }

  const validLanes: QualifyingLane[] = [];
  for (const item of raw) {
    const parseResult = QualifyingLaneSchema.safeParse(item);
    if (parseResult.success && !validLanes.includes(parseResult.data)) {
      validLanes.push(parseResult.data);
    }
  }

  for (const canonicalLane of CANONICAL_LANE_ORDER) {
    if (!validLanes.includes(canonicalLane)) {
      validLanes.push(canonicalLane);
    }
  }

  return validLanes;
}

export function loadLaneOrderPreference(
  districtId: string | undefined,
  userId: string | undefined
): QualifyingLane[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [...CANONICAL_LANE_ORDER];
  }

  try {
    const storageKey = getLaneOrderStorageKey(districtId, userId);
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return [...CANONICAL_LANE_ORDER];
    }
    const parsed: unknown = JSON.parse(raw);
    return reconcileLaneOrder(parsed);
  } catch {
    return [...CANONICAL_LANE_ORDER];
  }
}

export function saveLaneOrderPreference(
  districtId: string | undefined,
  userId: string | undefined,
  order: QualifyingLane[]
): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    const storageKey = getLaneOrderStorageKey(districtId, userId);
    const reconciled = reconcileLaneOrder(order);
    window.localStorage.setItem(storageKey, JSON.stringify(reconciled));
  } catch {
    // Gracefully ignore QuotaExceeded or Storage Disabled in restricted/private modes
  }
}

export interface UseLaneOrderPreferenceResult {
  laneOrder: QualifyingLane[];
  setLaneOrder: (newOrder: QualifyingLane[]) => void;
}

export function useLaneOrderPreference(
  districtId: string | undefined,
  userId: string | undefined
): UseLaneOrderPreferenceResult {
  const [laneOrder, setLaneOrderInternal] = useState<QualifyingLane[]>(() =>
    loadLaneOrderPreference(districtId, userId)
  );

  useEffect(() => {
    setLaneOrderInternal(loadLaneOrderPreference(districtId, userId));
  }, [districtId, userId]);

  const setLaneOrder = useCallback(
    (newOrder: QualifyingLane[]) => {
      const reconciled = reconcileLaneOrder(newOrder);
      setLaneOrderInternal(reconciled);
      saveLaneOrderPreference(districtId, userId, reconciled);
    },
    [districtId, userId]
  );

  return {
    laneOrder,
    setLaneOrder,
  };
}
