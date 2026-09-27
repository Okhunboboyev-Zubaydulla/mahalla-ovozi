/**
 * Formats relative duration from an ISO timestamp into approved Uzbek Cyrillic text (Story 4.2 AC 3, AC 5).
 */
export function formatIssueDuration(
  startedAt: string | Date,
  baseDate: Date = new Date(),
): string {
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) {
    return 'Номаълум вақт';
  }

  const diffMs = Math.max(0, baseDate.getTime() - start.getTime());
  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffMins < 1) {
    return 'Ҳозиргина';
  }
  if (diffMins < 60) {
    return `${diffMins} дақиқа олдин`;
  }
  if (diffHours < 24) {
    return `${diffHours} соат олдин`;
  }
  return `${diffDays} кун олдин`;
}
