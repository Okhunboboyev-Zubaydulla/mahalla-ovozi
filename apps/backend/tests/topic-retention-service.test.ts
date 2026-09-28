import { describe, it, expect } from 'vitest';
import {
  calculateRetentionDeadline,
  isRetentionExpired,
  validateDistrictScope,
} from '../src/modules/retention/topic-retention-service.js';

describe('Topic Retention Functions Unit Tests', () => {
  describe('calculateRetentionDeadline (Exact 90-Day Millisecond Arithmetic)', () => {
    it('calculates exactly 90 calendar days from the given evidence timestamp', () => {
      const baseDate = new Date('2026-08-22T10:00:00.000Z');
      const deadline = calculateRetentionDeadline(baseDate);

      const expectedMs = baseDate.getTime() + 90 * 24 * 60 * 60 * 1000;
      expect(deadline.getTime()).toBe(expectedMs);
      expect(deadline.toISOString()).toBe('2026-11-20T10:00:00.000Z');
    });

    it('correctly handles leap year February across 90-day boundary', () => {
      // 2028 is a leap year (29 days in Feb)
      const baseDate = new Date('2028-01-15T00:00:00.000Z');
      const deadline = calculateRetentionDeadline(baseDate);

      const expectedMs = baseDate.getTime() + 90 * 24 * 60 * 60 * 1000;
      expect(deadline.getTime()).toBe(expectedMs);
      expect(deadline.toISOString()).toBe('2028-04-14T00:00:00.000Z');
    });

    it('correctly handles year boundary rollover', () => {
      const baseDate = new Date('2026-11-15T15:30:00.000Z');
      const deadline = calculateRetentionDeadline(baseDate);

      const expectedMs = baseDate.getTime() + 90 * 24 * 60 * 60 * 1000;
      expect(deadline.getTime()).toBe(expectedMs);
      expect(deadline.toISOString()).toBe('2027-02-13T15:30:00.000Z');
    });

    it('preserves millisecond precision without rounding or drift', () => {
      const baseDate = new Date('2026-08-22T23:59:59.999Z');
      const deadline = calculateRetentionDeadline(baseDate);

      expect(deadline.getUTCMilliseconds()).toBe(999);
      expect(deadline.getTime() - baseDate.getTime()).toBe(7_776_000_000);
    });
  });

  describe('isRetentionExpired', () => {
    it('returns true when current time is strictly after retentionExpiresAt', () => {
      const expiresAt = new Date('2026-08-22T10:00:00.000Z');
      const now = new Date('2026-08-22T10:00:00.001Z');
      expect(isRetentionExpired(expiresAt, now)).toBe(true);
    });

    it('returns true when current time is exactly equal to retentionExpiresAt', () => {
      const expiresAt = new Date('2026-08-22T10:00:00.000Z');
      const now = new Date('2026-08-22T10:00:00.000Z');
      expect(isRetentionExpired(expiresAt, now)).toBe(true);
    });

    it('returns false when current time is before retentionExpiresAt', () => {
      const expiresAt = new Date('2026-08-22T10:00:00.000Z');
      const now = new Date('2026-08-22T09:59:59.999Z');
      expect(isRetentionExpired(expiresAt, now)).toBe(false);
    });
  });

  describe('validateDistrictScope', () => {
    it('succeeds for valid non-empty districtId strings', () => {
      expect(() => validateDistrictScope('dist_tashkent_yakkasaroy')).not.toThrow();
    });

    it('throws INVALID_DISTRICT_SCOPE when districtId is empty, whitespace, null, or undefined', () => {
      expect(() => validateDistrictScope('')).toThrowError(/INVALID_DISTRICT_SCOPE/);
      expect(() => validateDistrictScope('   ')).toThrowError(/INVALID_DISTRICT_SCOPE/);
      expect(() => validateDistrictScope(null as any)).toThrowError(/INVALID_DISTRICT_SCOPE/);
      expect(() => validateDistrictScope(undefined as any)).toThrowError(/INVALID_DISTRICT_SCOPE/);
    });
  });
});
