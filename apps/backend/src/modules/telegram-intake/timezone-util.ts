import { sql } from 'drizzle-orm';
import {
  type DateFilterScope,
  TASHKENT_OFFSET_SECONDS,
  getTashkentCalendarDay,
  getTashkentToday,
} from '@mahalla-ovozi/api-contracts';

export { TASHKENT_OFFSET_SECONDS, getTashkentCalendarDay, getTashkentToday };

/**
 * Derives the exact UTC start and end Date boundaries for an Asia/Tashkent calendar day (YYYY-MM-DD).
 * Tashkent day starts at UTC [day - 5h] (e.g. 2026-08-25 00:00:00+05 = 2026-08-24 19:00:00.000Z).
 */
export function getTashkentDayBounds(calendarDay: string): { startUtc: Date; endUtc: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDay.trim());
  if (!match || !match[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid calendar day format: expected YYYY-MM-DD, received "${calendarDay}"`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);

  // Start of day in Tashkent (00:00:00.000 +05:00) -> UTC is 5 hours earlier
  const startUtc = new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - TASHKENT_OFFSET_SECONDS * 1000);
  // End of day in Tashkent (23:59:59.999 +05:00)
  const endUtc = new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - TASHKENT_OFFSET_SECONDS * 1000);

  return { startUtc, endUtc };
}

export class InvalidDateRangeError extends Error {
  readonly statusCode = 400;
  readonly code = 'INVALID_DATE_RANGE';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDateRangeError';
  }
}

/**
 * Resolves DateFilterScope and calendar day inputs into SQL predicates and resolved day strings.
 */
export function resolveDateBoundary(params: {
  dateScope?: DateFilterScope;
  dateFrom?: string;
  dateTo?: string;
  calendarDay?: string;
}): {
  datePredicate: ReturnType<typeof sql>;
  resolvedCalendarDay: string;
} {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const today = getTashkentCalendarDay(nowSeconds);
  const yesterday = getTashkentCalendarDay(nowSeconds - 86400);
  const retentionLowerBound = getTashkentCalendarDay(nowSeconds - 90 * 86400);

  const scope = params.dateScope ?? 'today';

  if (scope === 'yesterday') {
    return {
      datePredicate: sql`t.calendar_day = ${yesterday}`,
      resolvedCalendarDay: yesterday,
    };
  }

  if (scope === 'custom') {
    const { dateFrom, dateTo } = params;
    if (!dateFrom || !dateTo) {
      throw new InvalidDateRangeError('Бошланиш ва тугаш саналари киритилиши шарт.');
    }
    if (dateFrom > dateTo) {
      throw new InvalidDateRangeError('Бошланиш санаси тугаш санасидан катта бўлиши мумкин эмас.');
    }
    if (dateFrom < retentionLowerBound) {
      throw new InvalidDateRangeError('Сана 90 кунлик сақлаш муддатидан эски бўлиши мумкин эмас.');
    }
    if (dateTo > today) {
      throw new InvalidDateRangeError('Сана бугунги кундан кейин бўлиши мумкин эмас.');
    }

    return {
      datePredicate: sql`t.calendar_day >= ${dateFrom} AND t.calendar_day <= ${dateTo}`,
      resolvedCalendarDay: dateFrom === dateTo ? dateFrom : `${dateFrom}..${dateTo}`,
    };
  }

  if (params.calendarDay) {
    if (params.calendarDay < retentionLowerBound) {
      throw new InvalidDateRangeError('Сана 90 кунлик сақлаш муддатидан эски бўлиши мумкин эмас.');
    }
    if (params.calendarDay > today) {
      throw new InvalidDateRangeError('Сана бугунги кундан кейин бўлиши мумкин эмас.');
    }
    return {
      datePredicate: sql`t.calendar_day = ${params.calendarDay}`,
      resolvedCalendarDay: params.calendarDay,
    };
  }

  return {
    datePredicate: sql`t.calendar_day = ${today}`,
    resolvedCalendarDay: today,
  };
}

