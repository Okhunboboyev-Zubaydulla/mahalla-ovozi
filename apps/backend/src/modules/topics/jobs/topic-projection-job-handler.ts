import crypto from 'node:crypto';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, and, sql } from 'drizzle-orm';
import type { DbClient } from '../../../adapters/db/client.js';
import {
  districts,
  topics,
  topicProjections,
  aiOperations,
  operationalIssues,
} from '../../../adapters/db/schema/index.js';
import {
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  TELEGRAM_TOPIC_PROJECTION_RECONCILE_CRON_QUEUE,
  withTransactionalIntake,
  type TelegramTopicProjectionJobData,
} from '../../../adapters/jobs/boss-client.js';
import type { QualifyingLane } from '@mahalla-ovozi/api-contracts';
import { TopicProjectionEvaluator } from '../topic-projection-evaluator.js';
import { insertAiProviderAttempts } from '../../ai/ai-operation-repository.js';
import {
  getMahallaDailySnapshot,
  type AcceptedEvidenceItem,
} from '../../ai/context-snapshot.js';
import { clearPendingRetryFlag } from '../../issues/retry-service.js';
import { reconcileUnprojectedTopics } from '../topic-reconciliation-service.js';

/**
 * The seeded AI profile that the gateway resolves for `TOPIC_DERIVED_PROJECTION`.
 * Named rather than inlined because the failure telemetry row must carry SOME profile id
 * (`ai_operations.pinned_profile_id` is NOT NULL with an FK to `ai_profiles`), and this is
 * the profile the operation type deterministically maps to.
 */
const TOPIC_PROJECTION_PROFILE_ID = 'prof_proj_2026_08_v1';

/**
 * Marks an `ai_operations.snapshot_fingerprint` for a run that failed BEFORE a snapshot
 * was assembled. Chosen to be visually non-fingerprint-like, unlike a plausible hex string.
 */
const SNAPSHOT_FINGERPRINT_UNAVAILABLE = 'unavailable';

export interface TopicProjectionJobDeps {
  db: DbClient;
  pool: pg.Pool;
  boss: PgBoss;
  topicProjectionEvaluator: TopicProjectionEvaluator;
  injectedEvidenceResolver?: (
    districtId: string,
    mahallaName: string,
    calendarDay: string,
  ) => Promise<AcceptedEvidenceItem[] | undefined>;
}

export async function processTopicProjectionJobs(
  jobs: PgBoss.Job<TelegramTopicProjectionJobData>[],
  deps: TopicProjectionJobDeps,
): Promise<void> {
  const { db, pool, boss, topicProjectionEvaluator } = deps;
  const options = deps;
        for (const job of jobs) {
          const { topicId, districtId, mahallaName, calendarDay, generation } = job.data;
          const startTime = performance.now();

          // Hoisted so the failure path records the SAME generation key the success path
          // would have used, and the REAL snapshot provenance instead of invented values.
          // (L3-P05-16: the reconciliation sweep matches on `topicId:targetGeneration`.)
          let failureTargetId: string | null = null;
          let failureSnapshotRevision: number | null = null;
          let failureSnapshotFingerprint: string | null = null;

          try {
            // 1. Lifecycle Gate 1 (Pre-AI): Verify district is ACTIVE and accessEligible !== false (AC 1, 19 / AD-9)
            const [district] = await db
              .select({
                id: districts.id,
                status: districts.status,
                accessEligible: districts.accessEligible,
              })
              .from(districts)
              .where(eq(districts.id, districtId))
              .limit(1);

            if (
              !district ||
              (district.status !== 'ACTIVE' && district.status !== 'GRACE') ||
              district.accessEligible === false
            ) {
              const durationMs = Math.round(performance.now() - startTime);
              console.log(
                JSON.stringify({
                  event: 'TELEGRAM_TOPIC_PROJECTION_DROPPED_INACTIVE_DISTRICT',
                  districtId,
                  mahallaName,
                  calendarDay,
                  topicId,
                  generation,
                  districtStatus: district?.status ?? 'NOT_FOUND',
                  accessEligible: district?.accessEligible ?? false,
                  durationMs,
                }),
              );
              continue;
            }

            // 2. Fetch target Topic from database
            const [targetTopic] = await db
              .select()
              .from(topics)
              .where(eq(topics.id, topicId))
              .limit(1);

            if (!targetTopic) {
              const durationMs = Math.round(performance.now() - startTime);
              console.log(
                JSON.stringify({
                  event: 'TELEGRAM_TOPIC_PROJECTION_DROPPED_EXPIRED',
                  topicId,
                  districtId,
                  mahallaName,
                  calendarDay,
                  generation,
                  durationMs,
                }),
              );
              // Defensive cleanup: purge any remaining ghost jobs for this deleted topic
              try {
                await db.execute(sql`
                  DELETE FROM pgboss.job
                  WHERE name = 'telegram-topic-projection'
                    AND data->>'topicId' = ${topicId}
                `);
              } catch (delErr) {
                console.warn('Failed to purge ghost jobs for deleted topic:', delErr);
              }
              continue;
            }

            // 3. Out-of-order drop check (AC 3, Matrix #14 / AD-7)
            if (generation <= targetTopic.appliedDerivedGeneration) {
              const durationMs = Math.round(performance.now() - startTime);
              console.log(
                JSON.stringify({
                  event: 'TELEGRAM_TOPIC_PROJECTION_DROPPED_SUPERSEDED',
                  districtId,
                  mahallaName,
                  calendarDay,
                  topicId,
                  jobGeneration: generation,
                  appliedDerivedGeneration: targetTopic.appliedDerivedGeneration,
                  durationMs,
                }),
              );
              continue; // Drop with 0 AI calls, 0 DB writes
            }

            // 4. Deterministic same-day Mahalla context snapshot (AC 2 / AD-5)
            const injected = options?.injectedEvidenceResolver
              ? await options.injectedEvidenceResolver(districtId, mahallaName, calendarDay)
              : undefined;

            const snapshot = await getMahallaDailySnapshot(
              db,
              districtId,
              mahallaName,
              calendarDay,
              injected,
            );

            // In-flight coalescing: target topic's newest required generation at execution time (AC 4, Matrix #15)
            const targetGeneration = Math.max(generation, targetTopic.requiredDerivedGeneration);
            // Capture the values the failure path must record if this run dies downstream.
            failureTargetId = `${topicId}:${targetGeneration}`;
            failureSnapshotRevision = snapshot.contextRevision;
            failureSnapshotFingerprint = snapshot.snapshotFingerprint;

            // 5. AI Projection Evaluation executed outside DB transaction (AC 10 / AD-8)
            const evaluation = await topicProjectionEvaluator.evaluateTopicProjection({
              topicId,
              primaryLane: targetTopic.primaryLane as QualifyingLane,
              generation: targetGeneration,
              snapshot,
            });

            // 6. Lifecycle Gate 2 (Pre-Commit): Re-verify district active status (AC 1, Matrix #20 / AD-9)
            const [gate2District] = await db
              .select({
                id: districts.id,
                status: districts.status,
                accessEligible: districts.accessEligible,
              })
              .from(districts)
              .where(eq(districts.id, districtId))
              .limit(1);

            if (
              !gate2District ||
              (gate2District.status !== 'ACTIVE' && gate2District.status !== 'GRACE') ||
              gate2District.accessEligible === false
            ) {
              const durationMs = Math.round(performance.now() - startTime);
              console.log(
                JSON.stringify({
                  event: 'TELEGRAM_TOPIC_PROJECTION_ABORTED_INACTIVE_DISTRICT_PRECOMMIT',
                  districtId,
                  mahallaName,
                  calendarDay,
                  topicId,
                  generation: targetGeneration,
                  districtStatus: gate2District?.status ?? 'NOT_FOUND',
                  accessEligible: gate2District?.accessEligible ?? false,
                  durationMs,
                }),
              );
              continue;
            }

            // 7. Atomic Transactional Commit with CAS Generation Advancement (AC 12, 13, 14, 16 / AD-3, AD-7)
            const projectionOpId = `aiop_${crypto.randomUUID()}`;
            const opTargetId = `${topicId}:${targetGeneration}`;

            let projectionCommitted = false;

            await withTransactionalIntake(pool, boss, async ({ tx }) => {
              // Row lock topic
              const [lockedTopic] = await tx
                .select()
                .from(topics)
                .where(eq(topics.id, topicId))
                .for('update')
                .limit(1);

              if (!lockedTopic) {
                console.log(
                  JSON.stringify({
                    event: 'TELEGRAM_TOPIC_PROJECTION_DROPPED_EXPIRED',
                    topicId,
                    districtId,
                    targetGeneration,
                  }),
                );
                return;
              }

              // CAS stale check (AC 13, Matrix #16)
              if (lockedTopic.appliedDerivedGeneration >= targetGeneration) {
                console.log(
                  JSON.stringify({
                    event: 'TELEGRAM_TOPIC_PROJECTION_STALE_CAS_ABORT',
                    topicId,
                    districtId,
                    targetGeneration,
                    appliedDerivedGeneration: lockedTopic.appliedDerivedGeneration,
                  }),
                );
                return;
              }

              // 7a. Record ai_operations with targetId = `${topicId}:${generation}` (AC 10)
              const [recordedOp] = await tx
                .insert(aiOperations)
                .values({
                  id: projectionOpId,
                  districtId,
                  mahallaName,
                  calendarDay,
                  operationType: 'TOPIC_DERIVED_PROJECTION',
                  targetId: opTargetId,
                  pinnedProfileId: evaluation.aiResult.profileId,
                  contextRevision: snapshot.contextRevision,
                  snapshotFingerprint: snapshot.snapshotFingerprint,
                  finalStatus: 'COMPLETED',
                  resultPayload: {
                    summary: evaluation.summary,
                    lanes: evaluation.lanes,
                    anchorEvidenceId: evaluation.anchorEvidenceId,
                    isHokimRelated: evaluation.isHokimRelated,
                    latestUpdate: evaluation.latestUpdate,
                  },
                })
                .onConflictDoUpdate({
                  target: [aiOperations.districtId, aiOperations.operationType, aiOperations.targetId],
                  set: {
                    pinnedProfileId: evaluation.aiResult.profileId,
                    contextRevision: snapshot.contextRevision,
                    snapshotFingerprint: snapshot.snapshotFingerprint,
                    finalStatus: 'COMPLETED',
                    resultPayload: {
                      summary: evaluation.summary,
                      lanes: evaluation.lanes,
                      anchorEvidenceId: evaluation.anchorEvidenceId,
                      isHokimRelated: evaluation.isHokimRelated,
                      latestUpdate: evaluation.latestUpdate,
                    },
                    updatedAt: new Date(),
                  },
                })
                .returning({ id: aiOperations.id });

              const effectiveOpId = recordedOp?.id ?? projectionOpId;

              // 7b. Record ai_provider_attempts
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx from withTransactionalIntake is structurally DbOrTx; module-identity mismatch in TS
              await insertAiProviderAttempts(tx as any, effectiveOpId, evaluation.aiResult);

              // 7c. Upsert into topic_projections table (1:1 with topics)
              const projectionRecordId = `prj_${crypto.randomUUID()}`;
              await tx
                .insert(topicProjections)
                .values({
                  id: projectionRecordId,
                  topicId,
                  districtId,
                  mahallaName,
                  calendarDay,
                  summary: evaluation.summary,
                  latestUpdate: evaluation.latestUpdate,
                  lanes: evaluation.lanes,
                  primaryLane: lockedTopic.primaryLane,
                  anchorEvidenceId: evaluation.anchorEvidenceId,
                  anchorQuote: evaluation.anchorQuote,
                  latestMeaningfulActivityTimestamp: new Date(
                    evaluation.latestMeaningfulActivityTimestamp,
                  ),
                  attribution: evaluation.attribution,
                  isHokimRelated: evaluation.isHokimRelated,
                  generation: targetGeneration,
                  aiProfileId: evaluation.aiResult.profileId,
                  aiOperationId: effectiveOpId,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                })
                .onConflictDoUpdate({
                  target: topicProjections.topicId,
                  set: {
                    summary: evaluation.summary,
                    latestUpdate: evaluation.latestUpdate,
                    lanes: evaluation.lanes,
                    anchorEvidenceId: evaluation.anchorEvidenceId,
                    anchorQuote: evaluation.anchorQuote,
                    latestMeaningfulActivityTimestamp: new Date(
                      evaluation.latestMeaningfulActivityTimestamp,
                    ),
                    attribution: evaluation.attribution,
                    isHokimRelated: evaluation.isHokimRelated,
                    generation: targetGeneration,
                    aiProfileId: evaluation.aiResult.profileId,
                    aiOperationId: effectiveOpId,
                    updatedAt: new Date(),
                  },
                });

              // 7d. Advance topics.appliedDerivedGeneration and updatedAt
              await tx
                .update(topics)
                .set({
                  appliedDerivedGeneration: targetGeneration,
                  updatedAt: new Date(),
                })
                .where(eq(topics.id, topicId));

              projectionCommitted = true;
            });

            if (projectionCommitted) {
              const durationMs = Math.round(performance.now() - startTime);

              // Auto-resolve any active operational delay issue for this topic
              try {
                await db
                  .update(operationalIssues)
                  .set({
                    status: 'RESOLVED',
                    resolvedAt: new Date(),
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(
                        operationalIssues.logicalKey,
                        `DISTRICT:${districtId}:topic_projection:TOPIC_PROCESSING_DELAY:${topicId}`,
                      ),
                      eq(operationalIssues.status, 'ACTIVE'),
                    ),
                  );
              } catch (resErr) {
                console.warn('Failed to resolve topic delay issue on projection commit:', resErr);
              }

              // 8. Privacy-safe structured telemetry (AC 18 / AD-11)
              console.log(
                JSON.stringify({
                  event: 'TELEGRAM_TOPIC_PROJECTION_COMMITTED',
                  districtId,
                  mahallaName,
                  calendarDay,
                  topicId,
                  generation: targetGeneration,
                  primaryLane: targetTopic.primaryLane,
                  lanes: evaluation.lanes,
                  isHokimRelated: evaluation.isHokimRelated,
                  anchorEvidenceId: evaluation.anchorEvidenceId,
                  aiOperationId: projectionOpId,
                  durationMs,
                }),
              );
            }
          } catch (err) {
            console.error(
              JSON.stringify({
                event: 'TELEGRAM_TOPIC_PROJECTION_ERROR',
                topicId,
                districtId,
                mahallaName,
                calendarDay,
                generation,
                error: err instanceof Error ? err.message : String(err),
              }),
            );

            // Record failure in ai_operations for health check telemetry.
            try {
              const failedOpId = `aiop_${crypto.randomUUID()}`;
              await db
                .insert(aiOperations)
                .values({
                  id: failedOpId,
                  districtId,
                  mahallaName,
                  calendarDay,
                  operationType: 'TOPIC_DERIVED_PROJECTION',
                  // L3-P05-16: key on the COALESCED generation. The reconciliation sweep
                  // matches `targetId === `${topicId}:${requiredDerivedGeneration}``, so
                  // keying this on the job's own `generation` makes the row unmatchable
                  // and silently suppresses the TOPIC_PROCESSING_DELAY alarm.
                  targetId: failureTargetId ?? `${topicId}:${generation}`,
                  pinnedProfileId: TOPIC_PROJECTION_PROFILE_ID,
                  // Real provenance when the run reached the snapshot; explicit sentinels
                  // otherwise, instead of fabricated revision 0 / fingerprint 'error'.
                  contextRevision: failureSnapshotRevision ?? 0,
                  snapshotFingerprint:
                    failureSnapshotFingerprint ?? SNAPSHOT_FINGERPRINT_UNAVAILABLE,
                  finalStatus: 'FAILED',
                  resultPayload: {
                    error: err instanceof Error ? err.message : String(err),
                  },
                })
                .onConflictDoUpdate({
                  target: [aiOperations.districtId, aiOperations.operationType, aiOperations.targetId],
                  // L3-P05-17: never downgrade a COMPLETED operation to FAILED. Without this
                  // guard, a retry of the same (district, operation, target) overwrites the
                  // audit record of a projection that actually committed, so the Console
                  // reports a district degraded while its dashboard serves correct data.
                  setWhere: sql`${aiOperations.finalStatus} <> 'COMPLETED'`,
                  set: {
                    finalStatus: 'FAILED',
                    resultPayload: {
                      error: err instanceof Error ? err.message : String(err),
                    },
                    updatedAt: new Date(),
                  },
                });
            } catch (telemetryErr) {
              console.warn('Failed to record projection failure telemetry:', telemetryErr);
            }

            throw err;
          } finally {
            if (job.data?.issueId) {
              await clearPendingRetryFlag(db, job.data.issueId);
            }
          }
        }
      }




export async function registerTopicProjectionJobHandler(
  boss: PgBoss,
  deps: TopicProjectionJobDeps,
): Promise<void> {
  // 1. Process individual topic projection recalculation jobs
  await boss.work<TelegramTopicProjectionJobData>(
    TELEGRAM_TOPIC_PROJECTION_QUEUE,
    { newJobCheckInterval: 50 } as any,
    (jobs) => processTopicProjectionJobs(jobs, deps),
  );

  // 2. Periodic recurring cron sweep every 2 minutes for unprojected or stale topics
  await boss.schedule(
    TELEGRAM_TOPIC_PROJECTION_RECONCILE_CRON_QUEUE,
    '*/2 * * * *',
    {},
    { tz: 'UTC' },
  );

  await boss.work(
    TELEGRAM_TOPIC_PROJECTION_RECONCILE_CRON_QUEUE,
    async () => {
      await reconcileUnprojectedTopics(deps.db, deps.boss);
    },
  );
}
