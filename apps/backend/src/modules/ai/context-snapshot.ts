import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import { acceptedEvidence } from '../../adapters/db/schema/accepted-evidence.js';
import { topics } from '../../adapters/db/schema/topics.js';
import { topicProjections } from '../../adapters/db/schema/topic-projections.js';

export interface AcceptedEvidenceItem {
  id: string;
  topicId?: string;
  telegramMessageId: string;
  telegramUserId?: string;
  authorHandle?: string;
  originalTimestamp: string; // ISO-8601 string
  verbatimText: string;
  lane?: string;
  topicSummary?: string;
}

export interface MahallaDailySnapshot {
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  contextRevision: number;
  snapshotFingerprint: string;
  evidence: AcceptedEvidenceItem[];
}

export function computeSnapshotFingerprint(evidence: AcceptedEvidenceItem[]): string {
  if (evidence.length === 0) {
    return 'sha256_empty_v1';
  }
  const serialized = evidence
    .map(
      (e) =>
        `${e.id}:${e.telegramMessageId}:${e.originalTimestamp}:${e.verbatimText.trim()}`,
    )
    .join('|');
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Assembles the complete, deterministic same-day Accepted Evidence context snapshot
 * for a specific District, Mahalla, and Uzbekistan calendar day.
 *
 * Deterministic ordering rule:
 * original_timestamp ASC -> telegram_message_id ASC -> id ASC
 */
export async function getMahallaDailySnapshot(
  db: DbClient,
  districtId: string,
  mahallaName: string,
  calendarDay: string,
  injectedEvidence?: AcceptedEvidenceItem[],
): Promise<MahallaDailySnapshot> {
  let evidence: AcceptedEvidenceItem[] = [];

  if (injectedEvidence) {
    // If explicit evidence was passed (e.g. in tests or mock resolver)
    evidence = [...injectedEvidence];
  } else {
    // Retrieve accepted evidence for this mahalla/day directly from accepted_evidence inner-joined with topics
    const rows = await db
      .select({
        id: acceptedEvidence.id,
        topicId: acceptedEvidence.topicId,
        telegramMessageId: acceptedEvidence.telegramMessageId,
        telegramUserId: acceptedEvidence.telegramUserId,
        userMetadata: acceptedEvidence.userMetadata,
        originalTimestamp: acceptedEvidence.originalTimestamp,
        verbatimText: acceptedEvidence.verbatimText,
        lane: topics.primaryLane,
        summary: topicProjections.summary,
      })
      .from(acceptedEvidence)
      .innerJoin(topics, eq(acceptedEvidence.topicId, topics.id))
      .leftJoin(topicProjections, eq(topics.id, topicProjections.topicId))
      .where(
        and(
          eq(acceptedEvidence.districtId, districtId),
          eq(acceptedEvidence.mahallaName, mahallaName),
          eq(acceptedEvidence.calendarDay, calendarDay),
        ),
      );

    for (const row of rows) {
      const meta = row.userMetadata as { username?: string; firstName?: string; lastName?: string } | null;
      const authorHandle = meta?.username
        ? `@${meta.username}`
        : meta?.firstName
          ? meta.firstName
          : undefined;

      evidence.push({
        id: row.id,
        topicId: row.topicId,
        telegramMessageId: row.telegramMessageId,
        telegramUserId: row.telegramUserId || undefined,
        authorHandle,
        originalTimestamp: row.originalTimestamp.toISOString(),
        verbatimText: row.verbatimText,
        lane: row.lane,
        topicSummary: row.summary?.trim() || undefined,
      });
    }
  }

  // Deterministic sorting: originalTimestamp ASC -> telegramMessageId ASC -> id ASC
  evidence.sort((a, b) => {
    const timeA = new Date(a.originalTimestamp).getTime();
    const timeB = new Date(b.originalTimestamp).getTime();
    if (timeA !== timeB) return timeA - timeB;

    const msgIdA = BigInt(a.telegramMessageId.replace(/\D/g, '') || '0');
    const msgIdB = BigInt(b.telegramMessageId.replace(/\D/g, '') || '0');
    if (msgIdA !== msgIdB) return msgIdA < msgIdB ? -1 : 1;

    return a.id.localeCompare(b.id);
  });

  const contextRevision = evidence.length;
  const snapshotFingerprint = computeSnapshotFingerprint(evidence);

  return {
    districtId,
    mahallaName,
    calendarDay,
    contextRevision,
    snapshotFingerprint,
    evidence,
  };
}

export class StaleSnapshotRevisionError extends Error {
  readonly code = 'STALE_SNAPSHOT' as const;
  readonly status = 409;
  constructor(currentRevision: number, expectedRevision: number) {
    super(
      `Context snapshot revision mismatch: expected revision ${expectedRevision}, but current revision is ${currentRevision}.`,
    );
    this.name = 'StaleSnapshotRevisionError';
  }
}

/**
 * Cryptographically verifies the internal integrity of a MahallaDailySnapshot (AD-5).
 * Validates that contextRevision matches evidence count and SHA-256 fingerprint matches evidence content.
 */
export function verifySnapshotIntegrity(snapshot: MahallaDailySnapshot): boolean {
  if (!snapshot || !Array.isArray(snapshot.evidence)) {
    return false;
  }
  if (snapshot.contextRevision !== snapshot.evidence.length) {
    return false;
  }
  const expectedFingerprint = computeSnapshotFingerprint(snapshot.evidence);
  return snapshot.snapshotFingerprint === expectedFingerprint;
}

/**
 * Enforces Compare-And-Swap (CAS) optimistic concurrency control on snapshot revisions (AD-6).
 * Throws StaleSnapshotRevisionError if the current revision has diverged from expected.
 */
export function assertSnapshotRevision(currentRevision: number, expectedRevision: number): void {
  if (currentRevision !== expectedRevision) {
    throw new StaleSnapshotRevisionError(currentRevision, expectedRevision);
  }
}

export interface FormatEvidenceItemOptions {
  includeId?: boolean;
  includeLane?: boolean;
  includeAuthor?: boolean;
  authorLabel?: string;
  authorTag?: string;
  indent?: string;
  prefix?: string;
  timeLabel?: 'Timestamp' | 'Time';
  relativeTimeOffset?: string;
}

/**
 * Pure deterministic formatter for an individual evidence item line (AD-5).
 */
export function formatEvidenceItemLine(
  item: AcceptedEvidenceItem,
  index: number,
  options: FormatEvidenceItemOptions = {},
): string {
  const indent = options.indent ?? '';
  const prefix = options.prefix ?? `#${index + 1}`;
  const idPart = options.includeId ? `ID: ${item.id} | ` : '';
  const tagSuffix = options.authorTag ? ` [${options.authorTag}]` : '';
  const authorPart = options.authorLabel
    ? `Author: [${options.authorLabel}]${tagSuffix} | `
    : options.includeAuthor && (item.authorHandle || item.telegramUserId)
      ? `Author: [${item.authorHandle || item.telegramUserId}]${tagSuffix} | `
      : options.authorTag
        ? `[${options.authorTag}] | `
        : '';
  const timeLabel = options.timeLabel ?? 'Timestamp';
  const offsetPart = options.relativeTimeOffset ? ` (${options.relativeTimeOffset})` : '';
  const lanePart = options.includeLane && item.lane ? ` | Lane: [${item.lane}]` : '';
  return `${indent}[${prefix}] ${idPart}${authorPart}${timeLabel}: ${item.originalTimestamp}${offsetPart} | MsgID: ${item.telegramMessageId}${lanePart} | Text: "${item.verbatimText}"`;
}

/**
 * Formats a flat chronological evidence list for prompt injection (AD-5).
 */
export function formatSnapshotEvidenceList(
  evidence: AcceptedEvidenceItem[],
  options: FormatEvidenceItemOptions = {},
): string {
  if (!evidence || evidence.length === 0) {
    return '';
  }
  return evidence
    .map((item, idx) => {
      let relativeTimeOffset: string | undefined = undefined;
      if (idx > 0 && evidence[idx - 1]) {
        const prevTime = new Date(evidence[idx - 1]!.originalTimestamp).getTime();
        const currTime = new Date(item.originalTimestamp).getTime();
        if (!Number.isNaN(prevTime) && !Number.isNaN(currTime)) {
          const diffMinutes = Math.round((currTime - prevTime) / 60000);
          relativeTimeOffset = `+${diffMinutes}m from previous`;
        }
      }
      return formatEvidenceItemLine(item, idx, {
        ...options,
        relativeTimeOffset: options.relativeTimeOffset ?? relativeTimeOffset,
      });
    })
    .join('\n');
}

/**
 * Deterministically groups snapshot evidence by topicId preserving chronological order.
 */
export function groupSnapshotByTopic(
  snapshot: MahallaDailySnapshot,
): Map<string, { lane: string; summary?: string; items: AcceptedEvidenceItem[] }> {
  const topicMap = new Map<string, { lane: string; summary?: string; items: AcceptedEvidenceItem[] }>();
  for (const item of snapshot.evidence) {
    const topicId = item.topicId || 'UNKNOWN_TOPIC';
    const existing = topicMap.get(topicId);
    if (existing) {
      existing.items.push(item);
      if (!existing.summary?.trim() && item.topicSummary?.trim()) {
        existing.summary = item.topicSummary.trim();
      }
    } else {
      topicMap.set(topicId, {
        lane: item.lane || 'UNKNOWN',
        summary: item.topicSummary?.trim() || undefined,
        items: [item],
      });
    }
  }
  return topicMap;
}

/**
 * Formats the full SAME-DAY ACCEPTED EVIDENCE CONTEXT block for Semantic Relevance prompts (AD-5).
 */
export function formatSnapshotForSemanticRelevance(snapshot: MahallaDailySnapshot): string {
  const header = `### SAME-DAY ACCEPTED EVIDENCE CONTEXT (Mahalla: ${snapshot.mahallaName}, Day: ${snapshot.calendarDay})`;
  if (snapshot.evidence.length === 0) {
    return `${header}\n(No accepted evidence recorded yet today for this Mahalla)`;
  }
  const evidenceList = formatSnapshotEvidenceList(snapshot.evidence, {
    includeLane: true,
  });
  return `${header}\n${evidenceList}`;
}


