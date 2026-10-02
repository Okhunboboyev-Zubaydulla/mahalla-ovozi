import { eq, and, or, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../adapters/db/schema/index.js';
import { acceptedEvidence } from '../../adapters/db/schema/accepted-evidence.js';
import { aiOperations } from '../../adapters/db/schema/ai.js';
import { telegramIntakeRecords } from '../../adapters/db/schema/telegram-intakes.js';
import { topicProjections } from '../../adapters/db/schema/topic-projections.js';
import { topics } from '../../adapters/db/schema/topics.js';

/**
 * Per-table deletion counters returned by the shared Topic cascade.
 */
export interface TopicCascadeDeletionCounts {
  evidenceCount: number;
  projectionsCount: number;
  aiOperationsCount: number;
  intakeRecordsCount: number;
  jobRecordsCount: number;
  topicDeletedCount: number;
}

/**
 * Removes every row a Topic owns, in strict FK-topological order:
 *
 *   1. topic_projections         (topic_id -> topics CASCADE; anchor_evidence_id -> accepted_evidence RESTRICT)
 *   2. accepted_evidence         (topic_id -> topics RESTRICT; intake_record_id -> telegram_intake_records RESTRICT)
 *   3. ai_operations             (target_id = evidence id or evidence intake_record_id)
 *   4. telegram_intake_records   (owner of the deleted evidence)
 *   5. pgboss.job                (intake/evidence keyed jobs + topic projection jobs)
 *   6. topics                    (the parent row itself)
 *
 * This is the single owner of the complete Topic deletion cascade. The retention purge and
 * the administrative ARCHIVED-topic delete both call it, so the two paths cannot drift apart.
 * It mirrors the proven cascade in topic-evidence-management-service.deleteEvidence.
 *
 * Children are keyed by topicId, not by districtId, so a district mismatch can never strand
 * orphaned rows; districtId is used only to scope the final topic row removal.
 *
 * Must be invoked inside an existing transaction; it neither opens one nor acquires the topic
 * row lock (the caller decides how the topic is locked and re-verified).
 * Governed by FR-12, AD-3, AD-4, AD-6, AD-7, AD-9.
 */
export async function deleteTopicCascadeAtomic(
  tx: NodePgDatabase<typeof schema>,
  districtId: string,
  topicId: string,
): Promise<TopicCascadeDeletionCounts> {
  // Capture the evidence set up front: these ids are needed for the projection anchor,
  // ai_operations, intake and pgboss keying, and the rows are gone once step 2 runs.
  const evidenceRows = await tx
    .select({
      id: acceptedEvidence.id,
      intakeRecordId: acceptedEvidence.intakeRecordId,
      districtId: acceptedEvidence.districtId,
    })
    .from(acceptedEvidence)
    .where(eq(acceptedEvidence.topicId, topicId));

  const evidenceIds = evidenceRows.map((row) => row.id);
  const intakeRecordIds = [...new Set(evidenceRows.map((row) => row.intakeRecordId))];
  const evidenceDistrictIds = [...new Set(evidenceRows.map((row) => row.districtId))];

  // 1. topic_projections: the topic's own rows plus any row anchored to evidence being removed
  //    (anchor_evidence_id -> accepted_evidence.id is ON DELETE RESTRICT).
  const deletedProjections = await tx
    .delete(topicProjections)
    .where(
      evidenceIds.length > 0
        ? or(
            eq(topicProjections.topicId, topicId),
            inArray(topicProjections.anchorEvidenceId, evidenceIds),
          )
        : eq(topicProjections.topicId, topicId),
    )
    .returning({ id: topicProjections.id });

  // 2. accepted_evidence (topic_id -> topics.id is ON DELETE RESTRICT).
  const deletedEvidence = await tx
    .delete(acceptedEvidence)
    .where(eq(acceptedEvidence.topicId, topicId))
    .returning({ id: acceptedEvidence.id });

  // 3. ai_operations whose targetId is an evidence id or the evidence's intake_record_id.
  const aiOperationTargets = [...evidenceIds, ...intakeRecordIds];
  let aiOperationsCount = 0;
  if (aiOperationTargets.length > 0) {
    const deletedAiOperations = await tx
      .delete(aiOperations)
      .where(
        and(
          inArray(aiOperations.districtId, evidenceDistrictIds),
          inArray(aiOperations.targetId, aiOperationTargets),
        ),
      )
      .returning({ id: aiOperations.id });
    aiOperationsCount = deletedAiOperations.length;
  }

  // 4. telegram_intake_records: only now, after step 2 released the RESTRICT reference.
  let intakeRecordsCount = 0;
  if (intakeRecordIds.length > 0) {
    const deletedIntakes = await tx
      .delete(telegramIntakeRecords)
      .where(inArray(telegramIntakeRecords.id, intakeRecordIds))
      .returning({ id: telegramIntakeRecords.id });
    intakeRecordsCount = deletedIntakes.length;
  }

  // 5. pgboss.job rows, keyed exactly as the evidence/topic templates key them:
  //    the intakeId payload arm (direct key plus nested-payload LIKE arm) and the topicId arm.
  let jobRecordsCount = 0;
  const jobIdArms = [...intakeRecordIds, ...evidenceIds].map(
    (id) => sql`(data->>'intakeId' = ${id} OR data::text LIKE ${'%' + id + '%'})`,
  );
  if (jobIdArms.length > 0) {
    const intakeJobDeletes = await tx.execute(sql`
      DELETE FROM pgboss.job
      WHERE ${sql.join(jobIdArms, sql` OR `)}
    `);
    jobRecordsCount += Number(intakeJobDeletes.rowCount ?? 0);
  }

  const topicJobDeletes = await tx.execute(sql`
    DELETE FROM pgboss.job
    WHERE name = 'telegram-topic-projection'
      AND data->>'topicId' = ${topicId}
  `);
  jobRecordsCount += Number(topicJobDeletes.rowCount ?? 0);

  // 6. the topic row itself, last: every child reference is already resolved.
  const deletedTopics = await tx
    .delete(topics)
    .where(and(eq(topics.id, topicId), eq(topics.districtId, districtId)))
    .returning({ id: topics.id });

  return {
    evidenceCount: deletedEvidence.length,
    projectionsCount: deletedProjections.length,
    aiOperationsCount,
    intakeRecordsCount,
    jobRecordsCount,
    topicDeletedCount: deletedTopics.length,
  };
}
