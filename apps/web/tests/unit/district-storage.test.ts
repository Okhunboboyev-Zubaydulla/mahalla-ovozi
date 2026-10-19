import { describe, it, expect, beforeEach } from 'vitest';
import {
  DISTRICT_STORAGE_KEY,
  readStoredDistrictId,
  writeStoredDistrictId,
  clearStoredDistrictId,
} from '../../src/lib/district-storage.js';

describe('district-storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses the canonical storage key', () => {
    expect(DISTRICT_STORAGE_KEY).toBe('mahalla_active_district_id');
  });

  it('reads null when nothing is stored', () => {
    expect(readStoredDistrictId()).toBeNull();
  });

  it('reads null for an empty stored string', () => {
    localStorage.setItem(DISTRICT_STORAGE_KEY, '');
    expect(readStoredDistrictId()).toBeNull();
  });

  it('reads back a valid stored district id', () => {
    localStorage.setItem(DISTRICT_STORAGE_KEY, 'dist_42');
    expect(readStoredDistrictId()).toBe('dist_42');
  });

  it('does not parse the stored value as JSON and never throws on odd values', () => {
    // The persisted value is a raw string, not JSON: a value that merely looks
    // like broken JSON is still a usable id, exactly as before the refactor.
    localStorage.setItem(DISTRICT_STORAGE_KEY, '{not-json');
    expect(() => readStoredDistrictId()).not.toThrow();
    expect(readStoredDistrictId()).toBe('{not-json');
  });

  it('degrades to null when localStorage access throws', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });

    try {
      expect(readStoredDistrictId()).toBeNull();
      expect(() => writeStoredDistrictId('dist_x')).not.toThrow();
      expect(() => clearStoredDistrictId()).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(window, 'localStorage', original);
      }
    }
  });

  it('writes the district id under the canonical key', () => {
    writeStoredDistrictId('dist_7');
    expect(localStorage.getItem(DISTRICT_STORAGE_KEY)).toBe('dist_7');
  });

  it('overwrites a previously stored district id', () => {
    writeStoredDistrictId('dist_1');
    writeStoredDistrictId('dist_2');
    expect(readStoredDistrictId()).toBe('dist_2');
  });

  it('clears the district key and leaves other keys intact', () => {
    localStorage.setItem('unrelated_key', 'keep-me');
    writeStoredDistrictId('dist_9');

    clearStoredDistrictId();

    expect(localStorage.getItem(DISTRICT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('unrelated_key')).toBe('keep-me');
    expect(readStoredDistrictId()).toBeNull();
  });
});
