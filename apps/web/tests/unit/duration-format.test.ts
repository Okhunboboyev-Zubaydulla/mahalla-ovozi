import { describe, it, expect } from 'vitest';
import { formatIssueDuration } from '../../src/utils/duration-format.js';

describe('Story 4.2: formatIssueDuration Utility Tests (AC 3, AC 5)', () => {
  const baseDate = new Date('2026-08-25T12:00:00.000Z');

  it('formats duration under 1 minute as Ҳозиргина', () => {
    const startedAt = new Date('2026-08-25T11:59:30.000Z');
    expect(formatIssueDuration(startedAt, baseDate)).toBe('Ҳозиргина');
  });

  it('formats duration under 1 hour in minutes (дақиқа олдин)', () => {
    const startedAt = new Date('2026-08-25T11:45:00.000Z');
    expect(formatIssueDuration(startedAt, baseDate)).toBe('15 дақиқа олдин');
  });

  it('formats duration under 24 hours in hours (соат олдин)', () => {
    const startedAt = new Date('2026-08-25T08:00:00.000Z');
    expect(formatIssueDuration(startedAt, baseDate)).toBe('4 соат олдин');
  });

  it('formats duration of 1 or more days in days (кун олдин)', () => {
    const startedAt = new Date('2026-08-23T12:00:00.000Z');
    expect(formatIssueDuration(startedAt, baseDate)).toBe('2 кун олдин');
  });

  it('returns fallback text "Номаълум вақт" for invalid or unparseable timestamps', () => {
    expect(formatIssueDuration('invalid-date-string', baseDate)).toBe('Номаълум вақт');
  });
});
