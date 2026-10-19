/**
 * Single home for the persisted "selected district" id.
 *
 * The persisted value is the district id itself (a plain string, not JSON),
 * so no serialisation is involved. `localStorage` may be unavailable (server
 * rendering, privacy modes, disabled storage), so every access is guarded and
 * degrades to "no stored district" instead of throwing.
 */
export const DISTRICT_STORAGE_KEY = 'mahalla_active_district_id';

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** Resolves `window.localStorage`, or `null` when absent or inaccessible. */
function getDistrictStorage(): StorageLike | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads the persisted district id. An absent or empty entry reads as `null`,
 * matching the historical `localStorage.getItem(key) || null` behaviour.
 */
export function readStoredDistrictId(): string | null {
  const storage = getDistrictStorage();
  if (!storage) {
    return null;
  }
  try {
    const stored = storage.getItem(DISTRICT_STORAGE_KEY);
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** Persists the selected district id under `DISTRICT_STORAGE_KEY`. */
export function writeStoredDistrictId(districtId: string): void {
  const storage = getDistrictStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(DISTRICT_STORAGE_KEY, districtId);
  } catch {
    // Writes can be rejected (quota, privacy mode); selection still works in memory.
  }
}

/** Removes the persisted district id. */
export function clearStoredDistrictId(): void {
  const storage = getDistrictStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(DISTRICT_STORAGE_KEY);
  } catch {
    // Removals can be rejected (privacy mode); nothing else to do.
  }
}
