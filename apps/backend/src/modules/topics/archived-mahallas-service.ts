import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import { acceptedEvidence } from '../../adapters/db/schema/accepted-evidence.js';
import { districts } from '../../adapters/db/schema/districts.js';
import { topicProjections } from '../../adapters/db/schema/topic-projections.js';
import { topics } from '../../adapters/db/schema/topics.js';
import {
  deleteTopicCascadeAtomic,
  type TopicCascadeDeletionCounts,
} from '../retention/topic-cascade-deletion.js';

/** One ARCHIVED topic (a mahalla whose Telegram group was deleted), with its live child counts. */
export interface ArchivedMahallaListItem {
  topicId: string;
  districtId: string;
  districtName: string;
  mahallaName: string;
  archivedAt: string | null;
  evidenceCount: number;
  projectionCount: number;
}

export interface DeleteArchivedMahallaResult {
  topicId: string;
  deleted: true;
  counts: TopicCascadeDeletionCounts;
}

export class ArchivedMahallaNotFoundError extends Error {
  readonly code = 'ARCHIVED_MAHALLA_NOT_FOUND';

  constructor(topicId: string) {
    super(`Архивланган маҳалла топилмади: ${topicId}`);
    this.name = 'ArchivedMahallaNotFoundError';
  }
}

export class ArchivedMahallaNotArchivedError extends Error {
  readonly code = 'ARCHIVED_MAHALLA_NOT_ARCHIVED';

  constructor(topicId: string, status: string) {
    super(
      `Маҳалла архивлашган ҳолатда эмас (ҳолат: ${status}, ID: ${topicId}). Фаол маҳаллани бу амал билан ўчириб бўлмайди.`,
    );
    this.name = 'ArchivedMahallaNotArchivedError';
  }
}

export class ArchivedMahallaConfirmationMismatchError extends Error {
  readonly code = 'ARCHIVED_MAHALLA_CONFIRMATION_MISMATCH';

  constructor() {
    super('Тасдиқлаш учун маҳалла номи аниқ мос келмади.');
    this.name = 'ArchivedMahallaConfirmationMismatchError';
  }
}

/**
 * Normalises an `archived_at` cell to an ISO string.
 *
 * Raw `sql` queries bypass Drizzle's column type parsers, so pg hands this column back as a
 * string, while a Drizzle-typed select hands back a Date. Both shapes are accepted here.
 */
function toIsoStringOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Lists every ARCHIVED topic joined to its district, ordered by district name then mahalla name.
 *
 * `archivedAt` is the topic's updated_at: the topics table has no dedicated archived_at column,
 * and the archive transition (Telegram group deletion) is the last write the row receives.
 */
export async function listArchivedMahallas(db: DbClient): Promise<ArchivedMahallaListItem[]> {
  const result = await db.execute<{
    topic_id: string;
    district_id: string;
    district_name: string;
    mahalla_name: string;
    archived_at: Date | string | null;
    evidence_count: number;
    projection_count: number;
  }>(sql`
    SELECT
      ${topics.id} AS topic_id,
      ${topics.districtId} AS district_id,
      ${districts.name} AS district_name,
      ${topics.mahallaName} AS mahalla_name,
      ${topics.updatedAt} AS archived_at,
      (
        SELECT COUNT(*)::int FROM ${acceptedEvidence}
        WHERE ${acceptedEvidence.topicId} = ${topics.id}
      ) AS evidence_count,
      (
        SELECT COUNT(*)::int FROM ${topicProjections}
        WHERE ${topicProjections.topicId} = ${topics.id}
      ) AS projection_count
    FROM ${topics}
    INNER JOIN ${districts} ON ${districts.id} = ${topics.districtId}
    WHERE ${topics.status} = ${'ARCHIVED'}
    ORDER BY ${districts.name} ASC, ${topics.mahallaName} ASC
  `);

  return result.rows.map((row) => ({
    topicId: row.topic_id,
    districtId: row.district_id,
    districtName: row.district_name,
    mahallaName: row.mahalla_name,
    archivedAt: toIsoStringOrNull(row.archived_at),
    evidenceCount: Number(row.evidence_count),
    projectionCount: Number(row.projection_count),
  }));
}

/**
 * Permanently deletes one ARCHIVED topic and every row it owns.
 *
 * The topic row is locked FOR UPDATE first, so two concurrent deletes cannot both pass the
 * status and confirmation gates; the shared cascade (which expects a caller-held transaction
 * and lock) then removes projections, evidence, ai_operations, intake records, jobs and the
 * topic itself.
 */
export async function deleteArchivedMahalla(
  db: DbClient,
  topicId: string,
  confirmMahallaName: string,
): Promise<DeleteArchivedMahallaResult> {
  const cleanTopicId = topicId.trim();
  if (cleanTopicId === '') {
    throw new ArchivedMahallaNotFoundError(topicId);
  }

  return db.transaction(async (tx) => {
    const [lockedTopic] = await tx
      .select({
        id: topics.id,
        districtId: topics.districtId,
        mahallaName: topics.mahallaName,
        status: topics.status,
      })
      .from(topics)
      .where(eq(topics.id, cleanTopicId))
      .for('update')
      .limit(1);

    if (!lockedTopic) {
      throw new ArchivedMahallaNotFoundError(cleanTopicId);
    }

    if (lockedTopic.status !== 'ARCHIVED') {
      throw new ArchivedMahallaNotArchivedError(cleanTopicId, lockedTopic.status);
    }

    if (lockedTopic.mahallaName.trim() !== confirmMahallaName) {
      throw new ArchivedMahallaConfirmationMismatchError();
    }

    const counts = await deleteTopicCascadeAtomic(tx, lockedTopic.districtId, lockedTopic.id);

    return { topicId: lockedTopic.id, deleted: true as const, counts };
  });
}
