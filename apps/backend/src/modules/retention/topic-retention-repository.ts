import { eq, and, lte, asc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DbClient } from '../../adapters/db/client.js';
import * as schema from '../../adapters/db/schema/index.js';
import { topics } from '../../adapters/db/schema/topics.js';
import { acceptedEvidence } from '../../adapters/db/schema/accepted-evidence.js';
import { topicProjections } from '../../adapters/db/schema/topic-projections.js';

export type DrizzleDatabase = DbClient | NodePgDatabase<typeof schema>;

export interface TopicPurgeExecutionResult {
  evidenceCount: number;
  projectionsCount: number;
  purged: boolean;
  reason: 'SUCCESS' | 'EXTENDED_BY_NEWER_EVIDENCE' | 'TOPIC_NOT_FOUND';
}

/**
 * Finds topic IDs eligible for retention purge within an explicit District scope.
 * Governed by FR-12, AD-3, AD-9.
 */
export async function findExpiredTopicIds(
  db: DrizzleDatabase,
  districtId: string,
  limit: number = 100,
  now: Date = new Date(),
): Promise<string[]> {
  const cleanDistrictId = typeof districtId === 'string' ? districtId.trim() : '';
  if (!cleanDistrictId) {
    return [];
  }

  const safeLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : 100;

  const rows = await db
    .select({ id: topics.id })
    .from(topics)
    .where(
      and(
        eq(topics.districtId, cleanDistrictId),
        eq(topics.status, 'ACTIVE'),
        lte(topics.retentionExpiresAt, now),
      ),
    )
    .orderBy(asc(topics.retentionExpiresAt))
    .limit(safeLimit);

  return rows.map((r) => r.id);
}

/**
 * Executes atomic, referentially safe purge of an expired Topic and all its associated
 * Accepted Evidence and Topic Projections within a single PostgreSQL transaction block.
 *
 * Enforces strict topological deletion order to satisfy onDelete: 'restrict' constraints:
 *   topic_projections -> accepted_evidence -> topics
 *
 * Governed by FR-12, AD-3, AD-4, AD-6, AD-7, AD-9.
 */
export async function deleteTopicWithEvidenceAtomic(
  tx: NodePgDatabase<typeof schema>,
  districtId: string,
  topicId: string,
  now: Date = new Date(),
): Promise<TopicPurgeExecutionResult> {
  const cleanDistrictId = typeof districtId === 'string' ? districtId.trim() : '';
  const cleanTopicId = typeof topicId === 'string' ? topicId.trim() : '';

  if (!cleanDistrictId || !cleanTopicId) {
    return {
      evidenceCount: 0,
      projectionsCount: 0,
      purged: false,
      reason: 'TOPIC_NOT_FOUND',
    };
  }

  // 1. Acquire exclusive row lock on the target topic
  const [lockedTopic] = await tx
    .select()
    .from(topics)
    .where(and(eq(topics.id, cleanTopicId), eq(topics.districtId, cleanDistrictId)))
    .for('update')
    .limit(1);

  if (!lockedTopic) {
    return {
      evidenceCount: 0,
      projectionsCount: 0,
      purged: false,
      reason: 'TOPIC_NOT_FOUND',
    };
  }

  // 2. Re-verify retention expiration under the exclusive row lock
  if (lockedTopic.retentionExpiresAt.getTime() > now.getTime()) {
    return {
      evidenceCount: 0,
      projectionsCount: 0,
      purged: false,
      reason: 'EXTENDED_BY_NEWER_EVIDENCE',
    };
  }

  // 3. Step 1 of topological deletion: remove topic_projections (satisfies anchorEvidenceId FK restrict)
  const deletedProjections = await tx
    .delete(topicProjections)
    .where(
      and(
        eq(topicProjections.topicId, topicId),
        eq(topicProjections.districtId, districtId),
      ),
    )
    .returning({ id: topicProjections.id });

  // 4. Step 2 of topological deletion: remove accepted_evidence (satisfies topicId FK restrict)
  const deletedEvidence = await tx
    .delete(acceptedEvidence)
    .where(
      and(
        eq(acceptedEvidence.topicId, topicId),
        eq(acceptedEvidence.districtId, districtId),
      ),
    )
    .returning({ id: acceptedEvidence.id });

  // 5. Step 3 of topological deletion: remove the topic itself
  await tx
    .delete(topics)
    .where(and(eq(topics.id, topicId), eq(topics.districtId, districtId)));

  return {
    evidenceCount: deletedEvidence.length,
    projectionsCount: deletedProjections.length,
    purged: true,
    reason: 'SUCCESS',
  };
}
