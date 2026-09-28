/**
 * Topic Projection Reconciliation Service.
 * Periodically detects active topics missing derived projections or with stale
 * generations, reviving pg-boss projection jobs and raising operational issue
 * telemetry when topics remain stuck.
 */

import crypto from 'node:crypto';
import { sql, eq, and } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import type { DbClient } from '../../adapters/db/client.js';
import {
  aiOperations,
  operationalIssues,
} from '../../adapters/db/schema/index.js';
import {
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  JobSingletonKeys,
  type TelegramTopicProjectionJobData,
} from '../../adapters/jobs/boss-client.js';

export interface UnprojectedTopicCandidate {
  topicId: string;
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  requiredDerivedGeneration: number;
  appliedDerivedGeneration: number;
  hasProjection: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TopicReconciliationSummary {
  scannedCount: number;
  enqueuedCount: number;
  skippedCount: number;
  issuesRaisedCount: number;
}

export interface ReconcileOptions {
  districtId?: string;
  batchLimit?: number;
  gracePeriodSeconds?: number;
  stuckThresholdMinutes?: number;
}

/**
 * Scans the database for active topics requiring projection reconciliation.
 * Selects topics where no projection exists or applied generation is behind required,
 * for active and access-eligible districts.
 */
export async function findUnprojectedTopics(
  db: DbClient,
  options: { districtId?: string; batchLimit?: number; gracePeriodSeconds?: number } = {},
): Promise<UnprojectedTopicCandidate[]> {
  const batchLimit = options.batchLimit ?? 25;
  const graceSeconds = options.gracePeriodSeconds ?? 30;
  const districtPredicate = options.districtId
    ? sql`AND t.district_id = ${options.districtId}`
    : sql``;

  const query = sql<{
    topicId: string;
    districtId: string;
    mahallaName: string;
    calendarDay: string;
    requiredDerivedGeneration: number;
    appliedDerivedGeneration: number;
    hasProjection: boolean;
    createdAt: string;
    updatedAt: string;
  }>`
    SELECT 
      t.id AS "topicId",
      t.district_id AS "districtId",
      t.mahalla_name AS "mahallaName",
      t.calendar_day AS "calendarDay",
      t.required_derived_generation AS "requiredDerivedGeneration",
      t.applied_derived_generation AS "appliedDerivedGeneration",
      (tp.id IS NOT NULL) AS "hasProjection",
      t.created_at AS "createdAt",
      t.updated_at AS "updatedAt"
    FROM topics t
    INNER JOIN districts d ON d.id = t.district_id
    LEFT JOIN topic_projections tp ON tp.topic_id = t.id
    WHERE t.status = 'ACTIVE'
      AND t.retention_expires_at > NOW()
      ${districtPredicate}
      AND d.status IN ('ACTIVE', 'GRACE')
      AND d.access_eligible IS NOT FALSE
      AND (
        tp.id IS NULL 
        OR t.applied_derived_generation < t.required_derived_generation
      )
      AND t.updated_at <= NOW() - (${graceSeconds} || ' seconds')::interval
    ORDER BY t.created_at ASC
    LIMIT ${batchLimit};
  `;

  const result = await db.execute(query);
  return (result.rows as any[]).map((row) => ({
    topicId: row.topicId,
    districtId: row.districtId,
    mahallaName: row.mahallaName,
    calendarDay: row.calendarDay,
    requiredDerivedGeneration: Number(row.requiredDerivedGeneration),
    appliedDerivedGeneration: Number(row.appliedDerivedGeneration),
    hasProjection: Boolean(row.hasProjection),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }));
}

/**
 * Reconciles unprojected or stale active topics by enqueuing projection jobs into pg-boss.
 * Handles deduplication via JobSingletonKeys and records operational issues for stuck topics.
 */
export async function reconcileUnprojectedTopics(
  db: DbClient,
  boss: PgBoss,
  options: ReconcileOptions = {},
): Promise<TopicReconciliationSummary> {
  const candidates = await findUnprojectedTopics(db, {
    districtId: options.districtId,
    batchLimit: options.batchLimit ?? 25,
    gracePeriodSeconds: options.gracePeriodSeconds ?? 30,
  });

  const summary: TopicReconciliationSummary = {
    scannedCount: candidates.length,
    enqueuedCount: 0,
    skippedCount: 0,
    issuesRaisedCount: 0,
  };

  const stuckThresholdMinutes = options.stuckThresholdMinutes ?? 5;
  const now = new Date();

  for (const candidate of candidates) {
    const targetGeneration = candidate.requiredDerivedGeneration;
    const singletonKey = JobSingletonKeys.forTopicProjection(candidate.topicId, targetGeneration);

    const jobData: TelegramTopicProjectionJobData = {
      topicId: candidate.topicId,
      districtId: candidate.districtId,
      mahallaName: candidate.mahallaName,
      calendarDay: candidate.calendarDay,
      generation: targetGeneration,
    };

    try {
      // Send job with singletonKey; returns null if already created/active in pg-boss
      const jobId = await boss.send(TELEGRAM_TOPIC_PROJECTION_QUEUE, jobData, {
        singletonKey,
        retryLimit: 5,
        retryDelay: 15,
        retryBackoff: true,
      });

      if (jobId) {
        summary.enqueuedCount++;
        console.log(
          JSON.stringify({
            event: 'TELEGRAM_TOPIC_PROJECTION_RECONCILED',
            topicId: candidate.topicId,
            districtId: candidate.districtId,
            mahallaName: candidate.mahallaName,
            generation: targetGeneration,
            jobId,
          }),
        );
      } else {
        summary.skippedCount++;
      }
    } catch (sendErr) {
      console.error(
        JSON.stringify({
          event: 'TELEGRAM_TOPIC_PROJECTION_RECONCILE_ENQUEUE_ERROR',
          topicId: candidate.topicId,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        }),
      );
    }

    // Check if topic is stuck: created > stuckThresholdMinutes ago with failed AI attempt
    const ageMs = now.getTime() - candidate.createdAt.getTime();
    if (ageMs > stuckThresholdMinutes * 60 * 1000) {
      try {
        const [failedAiOp] = await db
          .select({ id: aiOperations.id, updatedAt: aiOperations.updatedAt })
          .from(aiOperations)
          .where(
            and(
              eq(aiOperations.operationType, 'TOPIC_DERIVED_PROJECTION'),
              eq(aiOperations.targetId, `${candidate.topicId}:${targetGeneration}`),
              eq(aiOperations.finalStatus, 'FAILED'),
            ),
          )
          .limit(1);

        if (failedAiOp) {
          const logicalKey = `DISTRICT:${candidate.districtId}:topic_projection:TOPIC_PROCESSING_DELAY:${candidate.topicId}`;
          const issueId = `issue_topic_delay_${crypto.randomUUID()}`;

          await db
            .insert(operationalIssues)
            .values({
              id: issueId,
              logicalKey,
              scope: 'DISTRICT',
              districtId: candidate.districtId,
              component: 'topic_projection',
              issueCategory: 'TOPIC_PROCESSING_DELAY',
              severity: 'Warning',
              status: 'ACTIVE',
              healthStatus: 'Degraded',
              sanitizedTitle: 'Мавзу бўйича хулоса кечикмоқда',
              sanitizedDescription: `${candidate.mahallaName} маҳалласидаги мавзу учун хулоса яратишда кечикиш кузатилмоқда.`,
              recommendedAction: 'Қайта уриниш тугмасини босинг ёки АИ хизмати ҳолатини текширинг',
              targetRoute: null,
              startedAt: failedAiOp.updatedAt ?? candidate.createdAt,
              latestCheckAt: now,
              metadata: {
                topicId: candidate.topicId,
                districtId: candidate.districtId,
                mahallaName: candidate.mahallaName,
                calendarDay: candidate.calendarDay,
                generation: targetGeneration,
              },
            })
            .onConflictDoUpdate({
              target: operationalIssues.logicalKey,
              targetWhere: sql`${operationalIssues.status} = 'ACTIVE'`,
              set: {
                latestCheckAt: now,
                updatedAt: now,
                metadata: {
                  topicId: candidate.topicId,
                  districtId: candidate.districtId,
                  mahallaName: candidate.mahallaName,
                  calendarDay: candidate.calendarDay,
                  generation: targetGeneration,
                },
              },
            });

          summary.issuesRaisedCount++;
        }
      } catch (issueErr) {
        console.warn('Failed to record topic processing delay operational issue:', issueErr);
      }
    }
  }

  // Periodic cleanup: purge any orphan ghost projection jobs whose topics have been deleted
  try {
    await db.execute(sql`
      DELETE FROM pgboss.job j
      WHERE j.name = 'telegram-topic-projection'
        AND j.state IN ('retry', 'created')
        AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.id = (j.data->>'topicId'))
    `);
  } catch (cleanErr) {
    console.warn('Periodic ghost topic projection purge failed:', cleanErr);
  }

  return summary;
}
