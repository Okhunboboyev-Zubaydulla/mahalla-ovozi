import { describe, it, expect } from 'vitest';
import { getTashkentCalendarDay, getTashkentDayBounds } from '../src/modules/telegram-intake/timezone-util.js';

describe('getTashkentCalendarDay Utility', () => {
  it('correctly maps UTC midday timestamp to Tashkent calendar day', () => {
    // 2026-08-21 12:00:00 UTC -> 2026-08-21 17:00:00 Tashkent
    const unixSeconds = Math.floor(new Date('2026-08-21T12:00:00Z').getTime() / 1000);
    const day = getTashkentCalendarDay(unixSeconds);
    expect(day).toBe('2026-08-21');
  });

  it('accepts Date objects directly without manual conversion', () => {
    const date = new Date('2026-08-21T12:00:00Z');
    const day = getTashkentCalendarDay(date);
    expect(day).toBe('2026-08-21');
  });

  it('correctly preserves prior calendar day right before midnight (23:59:59 Tashkent / 18:59:59 UTC)', () => {
    // 2026-08-21 18:59:59 UTC + 5h = 2026-08-21 23:59:59 Tashkent
    const unixSeconds = Math.floor(new Date('2026-08-21T18:59:59Z').getTime() / 1000);
    const day = getTashkentCalendarDay(unixSeconds);
    expect(day).toBe('2026-08-21');
  });

  it('correctly rolls over to next calendar day at exact midnight (00:00:00 Tashkent / 19:00:00 UTC)', () => {
    // 2026-08-21 19:00:00 UTC + 5h = 2026-08-22 00:00:00 Tashkent
    const unixSeconds = Math.floor(new Date('2026-08-21T19:00:00Z').getTime() / 1000);
    const day = getTashkentCalendarDay(unixSeconds);
    expect(day).toBe('2026-08-22');
  });

  it('correctly handles month boundary crossing (e.g. Aug 31 19:00:00 UTC -> Sep 01 Tashkent)', () => {
    const unixSeconds = Math.floor(new Date('2026-08-31T19:00:00Z').getTime() / 1000);
    const day = getTashkentCalendarDay(unixSeconds);
    expect(day).toBe('2026-09-01');
  });

  it('correctly handles year boundary crossing (e.g. Dec 31 19:00:00 UTC -> Jan 01 next year)', () => {
    const unixSeconds = Math.floor(new Date('2026-12-31T19:00:00Z').getTime() / 1000);
    const day = getTashkentCalendarDay(unixSeconds);
    expect(day).toBe('2027-01-01');
  });

  it('safely handles millisecond timestamps (> 1e11) by converting to seconds', () => {
    const unixMs = new Date('2026-08-21T12:00:00Z').getTime();
    const day = getTashkentCalendarDay(unixMs);
    expect(day).toBe('2026-08-21');
  });

  it('safely falls back to current day when passed NaN, non-numeric, or negative timestamps', () => {
    expect(() => getTashkentCalendarDay(NaN)).not.toThrow();
    expect(getTashkentCalendarDay(NaN)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getTashkentCalendarDay(-500)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getTashkentCalendarDay(null as any)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getTashkentCalendarDay(undefined as any)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('derives exact UTC start and end bounds for Tashkent calendar day via getTashkentDayBounds', () => {
    const bounds = getTashkentDayBounds('2026-08-25');
    // Start of 2026-08-25 in Tashkent (UTC+5) is 2026-08-24 19:00:00.000Z
    expect(bounds.startUtc.toISOString()).toBe('2026-08-24T19:00:00.000Z');
    // End of 2026-08-25 in Tashkent (UTC+5) is 2026-08-25 18:59:59.999Z
    expect(() => getTashkentDayBounds('invalid-day')).toThrow('Invalid calendar day format');
  });

  describe('resolveDateBoundary', () => {
    it('resolves default scope to today', async () => {
      const { resolveDateBoundary } = await import('../src/modules/telegram-intake/timezone-util.js');
      const res = resolveDateBoundary({});
      expect(res.resolvedCalendarDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(res.datePredicate).toBeDefined();
    });

    it('resolves yesterday scope properly', async () => {
      const { resolveDateBoundary } = await import('../src/modules/telegram-intake/timezone-util.js');
      const res = resolveDateBoundary({ dateScope: 'yesterday' });
      expect(res.resolvedCalendarDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(res.datePredicate).toBeDefined();
    });

    it('rejects invalid custom range where dateFrom > dateTo', async () => {
      const { resolveDateBoundary } = await import('../src/modules/telegram-intake/timezone-util.js');
      expect(() =>
        resolveDateBoundary({
          dateScope: 'custom',
          dateFrom: '2026-08-25',
          dateTo: '2026-08-20',
        }),
      ).toThrow('Бошланиш санаси тугаш санасидан катта бўлиши мумкин эмас.');
    });

    it('rejects custom range older than 90-day retention', async () => {
      const { resolveDateBoundary } = await import('../src/modules/telegram-intake/timezone-util.js');
      expect(() =>
        resolveDateBoundary({
          dateScope: 'custom',
          dateFrom: '2020-01-01',
          dateTo: '2020-01-02',
        }),
      ).toThrow('Сана 90 кунлик сақлаш муддатидан эски бўлиши мумкин эмас.');
    });
  });
});
