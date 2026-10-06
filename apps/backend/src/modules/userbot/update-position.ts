/**
 * Userbot update-position value object (Ticket 17 follow-up).
 *
 * The persisted position is a snapshot of the MTProto client's GLOBAL update state. It is the
 * only position this system may store: channel updates carry a channel-scoped `pts` sequence
 * that is not comparable with the account-wide `pts` the client keeps, so a per-update `pts`
 * must never be written into `update_position`.
 *
 * Governing principle for every comparison here: a stored position may never be able to cover
 * an update that has not been persisted yet. Advancing is therefore only ever permitted in the
 * strictly-newer direction, and an unreadable stored value is replaced rather than trusted.
 *
 * Pure functions only: no I/O, no clock, no database access.
 */

/** The serialization version written by this process. */
export const TELEPROTO_POSITION_VERSION = 'teleproto-v1';

export interface UserbotUpdatePosition {
  version: typeof TELEPROTO_POSITION_VERSION;
  pts: number;
  qts: number;
  date: number;
  seq: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Parses a stored update position into the exact shape this process writes, or null when the
 * raw value is absent, malformed, from a different serialization version, or missing one of the
 * four state legs. A null return means "no comparable stored position", never "the stored
 * position is zero".
 */
export function parseUserbotUpdatePosition(raw: string | null): UserbotUpdatePosition | null {
  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.version !== TELEPROTO_POSITION_VERSION) {
    return null;
  }

  const pts = readFiniteNumber(parsed.pts);
  const qts = readFiniteNumber(parsed.qts);
  const date = readFiniteNumber(parsed.date);
  const seq = readFiniteNumber(parsed.seq);
  if (pts === null || qts === null || date === null || seq === null) {
    return null;
  }

  return { version: TELEPROTO_POSITION_VERSION, pts, qts, date, seq };
}

/**
 * Total order over update positions, comparing the state legs in the order the MTProto state
 * machine itself advances them: `pts`, then `qts`, then `seq`, then `date`.
 *
 * `pts` alone is not sufficient: an update may advance only `qts` (a secret-chat-bound update
 * carries no `pts` but its own `date`), and `date` alone is not sufficient because several
 * updates can share the same second. Returns a negative number when `left` precedes `right`,
 * 0 when they are equal, and a positive number when `left` is newer.
 */
export function compareUserbotUpdatePositions(
  left: UserbotUpdatePosition,
  right: UserbotUpdatePosition,
): number {
  if (left.pts !== right.pts) {
    return left.pts - right.pts;
  }
  if (left.qts !== right.qts) {
    return left.qts - right.qts;
  }
  if (left.seq !== right.seq) {
    return left.seq - right.seq;
  }
  return left.date - right.date;
}

/**
 * Whether `candidate` is strictly newer than `incumbent` and therefore allowed to replace it.
 *
 * A candidate that cannot be parsed is never an advance. An incumbent that cannot be parsed
 * means there is no comparable stored position (absent, malformed, or written by an older
 * library or a different version), so the candidate advances instead of being blocked by a
 * value whose ordering is unknown.
 */
export function isNewerUserbotUpdatePosition(
  incumbent: UserbotUpdatePosition | null,
  candidate: UserbotUpdatePosition | null,
): boolean {
  if (candidate === null) {
    return false;
  }
  if (incumbent === null) {
    return true;
  }
  return compareUserbotUpdatePositions(candidate, incumbent) > 0;
}
