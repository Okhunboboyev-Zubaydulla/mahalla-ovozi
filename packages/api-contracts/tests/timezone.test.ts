import { describe, it, expect } from 'vitest';
import {
  TASHKENT_OFFSET_SECONDS,
  TASHKENT_OFFSET_MS,
  getTashkentCalendarDay,
  getTashkentToday,
} from '../src/timezone.js';

describe('Tashkent Timezone Arithmetic', () => {
  it('defines correct constants for UTC+5 offset', () => {
    expect(TASHKENT_OFFSET_SECONDS).toBe(18000);
    expect(TASHKENT_OFFSET_MS).toBe(18000000);
  });

  it('correctly calculates Tashkent day at boundary crossing (18:59:59 UTC vs 19:00:00 UTC)', () => {
    // 2026-03-15 18:59:59.000 UTC -> 2026-03-15 23:59:59 in Tashkent
    const beforeMidnightUtc = new Date('2026-03-15T18:59:59.000Z');
    expect(getTashkentCalendarDay(beforeMidnightUtc)).toBe('2026-03-15');

    // 2026-03-15 19:00:00.000 UTC -> 2026-03-16 00:00:00 in Tashkent (next day)
    const exactMidnightUtc = new Date('2026-03-15T19:00:00.000Z');
    expect(getTashkentCalendarDay(exactMidnightUtc)).toBe('2026-03-16');
  });

  it('correctly handles leap year leap days (Feb 29)', () => {
    // 2024 is a leap year. 2024-02-28 19:00:00 UTC -> 2024-02-29 in Tashkent
    const leapDayStart = new Date('2024-02-28T19:00:00.000Z');
    expect(getTashkentCalendarDay(leapDayStart)).toBe('2024-02-29');

    // 2024-02-29 19:00:00 UTC -> 2024-03-01 in Tashkent
    const nextDayAfterLeap = new Date('2024-02-29T19:00:00.000Z');
    expect(getTashkentCalendarDay(nextDayAfterLeap)).toBe('2024-03-01');
  });

  it('correctly handles year-end rollover across December 31 / January 1', () => {
    // 2025-12-31 18:59:59 UTC -> 2025-12-31 in Tashkent
    const endOfYear = new Date('2025-12-31T18:59:59.000Z');
    expect(getTashkentCalendarDay(endOfYear)).toBe('2025-12-31');

    // 2025-12-31 19:00:00 UTC -> 2026-01-01 in Tashkent
    const newYear = new Date('2025-12-31T19:00:00.000Z');
    expect(getTashkentCalendarDay(newYear)).toBe('2026-01-01');
  });

  it('supports Unix timestamp inputs in seconds and milliseconds', () => {
    // 2026-06-01 12:00:00 UTC = 1780315200 seconds = 1780315200000 ms
    const date = new Date('2026-06-01T12:00:00.000Z');
    const seconds = Math.floor(date.getTime() / 1000);
    const ms = date.getTime();

    expect(getTashkentCalendarDay(seconds)).toBe('2026-06-01');
    expect(getTashkentCalendarDay(ms)).toBe('2026-06-01');
  });

  it('falls back safely to current date when input is omitted or non-positive', () => {
    const today = getTashkentToday();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getTashkentCalendarDay()).toBe(today);
    expect(getTashkentCalendarDay(0)).toBe(today);
    expect(getTashkentCalendarDay(-100)).toBe(today);
  });
});
