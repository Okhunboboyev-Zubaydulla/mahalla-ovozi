export const TASHKENT_OFFSET_SECONDS = 5 * 3600; // +05:00 (18,000s)
export const TASHKENT_OFFSET_MS = TASHKENT_OFFSET_SECONDS * 1000;

/**
 * Deterministically derives the Uzbekistan calendar day (YYYY-MM-DD) in Asia/Tashkent
 * from a Unix timestamp (seconds or milliseconds) or Date instance.
 *
 * Uses pure UTC+5 arithmetic to prevent timezone drift, DST variations, or OS locale dependencies.
 * When input is omitted or invalid, evaluates against the current timestamp.
 */
export function getTashkentCalendarDay(input?: number | Date): string {
  let safeSeconds: number;
  if (input instanceof Date) {
    safeSeconds = Math.floor(input.getTime() / 1000);
  } else if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    safeSeconds = input > 1e11 ? Math.floor(input / 1000) : Math.floor(input);
  } else {
    safeSeconds = Math.floor(Date.now() / 1000);
  }

  const adjustedDate = new Date((safeSeconds + TASHKENT_OFFSET_SECONDS) * 1000);
  const year = adjustedDate.getUTCFullYear();
  const month = String(adjustedDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(adjustedDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Convenience helper returning the current calendar day string (YYYY-MM-DD) in Asia/Tashkent.
 */
export function getTashkentToday(referenceDate?: Date): string {
  return getTashkentCalendarDay(referenceDate);
}
