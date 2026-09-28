import crypto from 'node:crypto';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, and, or, lte, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import {
  districts,
  districtSubscriptions,
  districtDeletionRecords,
  topicProjections,
  acceptedEvidence,
  topics,
  aiOperations,
  aiProviderAttempts,
  telegramIntakeRecords,
  districtAnalysisSettingsDrafts,
  districtAnalysisSettingsVersions,
  operationalIssues,
  userDashboardVisits,
  accounts,
  sessions,
  districtTelegramGroups,
  districtTelegramBots,
  auditEvents,
} from '../../adapters/db/schema/index.js';
import {
  DisasterRestoreReconciliationResult,
  DistrictDeletionRecord,
} from '@mahalla-ovozi/api-contracts';
import { formatDistrictDeletionRecord } from '../subscriptions/district-deletion-service.js';
import { recordAuditEvent } from '../audit/audit-service.js';
import type { ExternalTombstoneStore } from '../subscriptions/ports/external-tombstone-store.port.js';
import { FileExternalTombstoneStore } from '../../adapters/storage/external-tombstone-store.js';
import { purgeDistrictExpiredTopicsBatch } from './topic-retention-service.js';

export interface DisasterRestoreReconciliationOptions {
  now?: Date;
  actor?: { id?: string | null; role?: string | null };
  context?: { ipAddress?: string | null; userAgent?: string | null };
  tombstoneStore?: ExternalTombstoneStore;
  dryRun?: boolean;
}

/**
 * Disaster-Recovery Retention Reconciliation Service.
 * Re-evaluates all restored PostgreSQL topics against authoritative real-world time (NOW)
 * and purges all expired topics, their Accepted Evidence, and derived projections
 * before public ingress and worker intake are enabled.
 * Governed by FR-12, AD-11.
 */
export async function reconcileRestoredRetention(
  pool: pg.Pool,
  boss: PgBoss,
  db: DbClient,
  districtId?: string,
  nowInput?: Date,
): Promise<{
  districtsReconciled: number;
  districtsEvaluated: number;
  districtsSucceeded: number;
  districtsFailed: number;
  totalTopicsPurged: number;
  totalEvidencePurged: number;
  totalProjectionsPurged: number;
  errors: Array<{ districtId: string; error: string }>;
  durationMs: number;
}> {
  const startTime = performance.now();
  const now = nowInput ?? new Date();

  let targetDistrictIds: string[] = [];
  const cleanDistrictId = typeof districtId === 'string' ? districtId.trim() : '';

  if (cleanDistrictId) {
    targetDistrictIds = [cleanDistrictId];
  } else {
    const allDistricts = await db.select({ id: districts.id }).from(districts);
    targetDistrictIds = allDistricts.map((d) => d.id);
  }

  let totalTopicsPurged = 0;
  let totalEvidencePurged = 0;
  let totalProjectionsPurged = 0;
  let districtsSucceeded = 0;
  let districtsFailed = 0;
  const errors: Array<{ districtId: string; error: string }> = [];

  const BATCH_SIZE = 500;
  const MAX_ITERATIONS = 2000;

  for (const currentDistrictId of targetDistrictIds) {
    try {
      let hasMore = true;
      let iterations = 0;

      while (hasMore && iterations < MAX_ITERATIONS) {
        iterations++;
        const batchResult = await purgeDistrictExpiredTopicsBatch(
          pool,
          boss,
          db,
          currentDistrictId,
          { limit: BATCH_SIZE },
          now,
        );

        totalTopicsPurged += batchResult.topicsPurged;
        totalEvidencePurged += batchResult.evidencePurged;
        totalProjectionsPurged += batchResult.projectionsPurged;

        if (
          batchResult.topicsEvaluated < BATCH_SIZE ||
          (batchResult.topicsPurged === 0 && batchResult.topicsEvaluated > 0)
        ) {
          hasMore = false;
        } else if (batchResult.topicsEvaluated === 0) {
          hasMore = false;
        } else {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      districtsSucceeded++;
    } catch (districtErr) {
      districtsFailed++;
      const errorMsg = districtErr instanceof Error ? districtErr.message : String(districtErr);
      errors.push({ districtId: currentDistrictId, error: errorMsg });
      console.error(
        JSON.stringify({
          event: 'TELEGRAM_DISASTER_RESTORE_DISTRICT_ERROR',
          districtId: currentDistrictId,
          error: errorMsg,
        }),
      );
    }
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    districtsReconciled: districtsSucceeded,
    districtsEvaluated: targetDistrictIds.length,
    districtsSucceeded,
    districtsFailed,
    totalTopicsPurged,
    totalEvidencePurged,
    totalProjectionsPurged,
    errors,
    durationMs,
  };
}

/**
 * Complete Disaster Restore Reconciliation Coordinator.
 * Orchestrates external tombstone reconciliation, 17-table resurrected district purge,
 * 90-day ordinary retention reapplication, stale pg-boss queue suppression,
 * and fail-closed operational issue lifecycle management.
 * Governed by FR-32, AD-03, AD-09, AD-11.
 */
export async function reconcileDisasterRestore(
  pool: pg.Pool,
  boss: PgBoss,
  db: DbClient,
  options?: DisasterRestoreReconciliationOptions,
): Promise<DisasterRestoreReconciliationResult> {
  const startTime = performance.now();
  const now = options?.now || new Date();
  const store = options?.tombstoneStore || new FileExternalTombstoneStore();
  const isDryRun = Boolean(options?.dryRun);

  const resurrectedDistrictsPurged: string[] = [];
  let staleJobsPurged = 0;
  let tombstonesSynchronized = 0;
  const errors: Array<{ scope: string; error: string }> = [];

  try {
    const externalTombstones = await store.loadAllTombstones();
    const tombstonesToPersist: DistrictDeletionRecord[] = [];

    // If dryRun is requested: simulate without modifying DB, store, or queues
    if (isDryRun) {
      for (const extTombstone of externalTombstones) {
        const [foundDistrict] = await db
          .select({ id: districts.id })
          .from(districts)
          .where(eq(districts.id, extTombstone.districtId))
          .limit(1);
        if (foundDistrict) {
          resurrectedDistrictsPurged.push(extTombstone.districtId);
        }
      }

      const dbTombstones = await db.select().from(districtDeletionRecords);
      for (const dbTomb of dbTombstones) {
        if (!externalTombstones.some((et) => et.districtId === dbTomb.districtId)) {
          tombstonesSynchronized++;
        }
      }
      for (const extTomb of externalTombstones) {
        if (!dbTombstones.some((dt) => dt.districtId === extTomb.districtId)) {
          tombstonesSynchronized++;
        }
      }

      // Count expired topics for surviving districts
      const allDistricts = await db.select({ id: districts.id }).from(districts);
      const retentionThreshold = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      let expiredTopicsCount = 0;
      let expiredEvidenceCount = 0;
      let expiredProjectionsCount = 0;

      for (const d of allDistricts) {
        if (resurrectedDistrictsPurged.includes(d.id)) continue;
        const [expTopics] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(topics)
          .where(and(eq(topics.districtId, d.id), lte(topics.createdAt, retentionThreshold)));
        expiredTopicsCount += expTopics?.count || 0;
      }

      const allDeletedDistrictIds = Array.from(
        new Set([
          ...externalTombstones.map((t) => t.districtId),
          ...dbTombstones.map((t) => t.districtId),
          ...resurrectedDistrictsPurged,
        ]),
      );

      if (allDeletedDistrictIds.length > 0) {
        try {
          const countRes = await pool.query(
            `SELECT count(*)::int as count FROM pgboss.job
             WHERE state IN ('created', 'retry', 'active')
               AND data->>'districtId' = ANY($1::text[])`,
            [allDeletedDistrictIds],
          );
          staleJobsPurged = countRes.rows[0]?.count || 0;
        } catch {
          // pgboss.job table might not exist in mock env
        }
      }

      const durationMs = Math.round(performance.now() - startTime);
      return {
        success: true,
        resurrectedDistrictsPurged,
        districtsEvaluated: allDistricts.length,
        expiredTopicsPurged: expiredTopicsCount,
        expiredEvidencePurged: expiredEvidenceCount,
        expiredProjectionsPurged: expiredProjectionsCount,
        staleJobsPurged,
        tombstonesSynchronized,
        errors: [],
        durationMs,
      };
    }

    // -------------------------------------------------------------------------
    // STEP 1: External Tombstone Reconciliation & Resurrected District Purging (AC 2, AC 3)
    // -------------------------------------------------------------------------
    for (const extTombstone of externalTombstones) {
      // Check if this deleted district was resurrected in the restored PostgreSQL database
      const [foundDistrict] = await db
        .select({ id: districts.id, name: districts.name })
        .from(districts)
        .where(eq(districts.id, extTombstone.districtId))
        .limit(1);

      if (foundDistrict) {
        // Resurrected district detected! Execute 17-table purge in dedicated transaction with row locks
        await db.transaction(async (tx) => {
          // Lock district row
          await tx.execute(
            sql`SELECT id FROM districts WHERE id = ${extTombstone.districtId} FOR UPDATE`,
          );
          // Lock subscription row if exists
          await tx.execute(
            sql`SELECT id FROM district_subscriptions WHERE district_id = ${extTombstone.districtId} FOR UPDATE`,
          );

          // 17-table cascading purge in strict topological dependency order:
          // 1. topic_projections
          await tx
            .delete(topicProjections)
            .where(eq(topicProjections.districtId, extTombstone.districtId));

          // 2. accepted_evidence
          await tx
            .delete(acceptedEvidence)
            .where(eq(acceptedEvidence.districtId, extTombstone.districtId));

          // 3. topics
          await tx.delete(topics).where(eq(topics.districtId, extTombstone.districtId));

          // 4. ai_provider_attempts
          await tx
            .delete(aiProviderAttempts)
            .where(
              inArray(
                aiProviderAttempts.operationId,
                tx
                  .select({ id: aiOperations.id })
                  .from(aiOperations)
                  .where(eq(aiOperations.districtId, extTombstone.districtId)),
              ),
            );

          // 5. ai_operations
          await tx
            .delete(aiOperations)
            .where(eq(aiOperations.districtId, extTombstone.districtId));

          // 6. telegram_intake_records
          await tx
            .delete(telegramIntakeRecords)
            .where(eq(telegramIntakeRecords.districtId, extTombstone.districtId));

          // 7. district_analysis_settings_drafts
          await tx
            .delete(districtAnalysisSettingsDrafts)
            .where(eq(districtAnalysisSettingsDrafts.districtId, extTombstone.districtId));

          // 8. district_analysis_settings_versions
          await tx
            .delete(districtAnalysisSettingsVersions)
            .where(eq(districtAnalysisSettingsVersions.districtId, extTombstone.districtId));

          // 9. operational_issues (both district-scoped and del_fail/del_sync_fail/del_backup_fail issues)
          await tx
            .delete(operationalIssues)
            .where(
              or(
                eq(operationalIssues.districtId, extTombstone.districtId),
                eq(operationalIssues.logicalKey, `del_fail:${extTombstone.districtId}`),
                eq(operationalIssues.logicalKey, `del_sync_fail:${extTombstone.districtId}`),
                eq(operationalIssues.logicalKey, `del_backup_fail:${extTombstone.districtId}`),
              ),
            );

          // 10. user_dashboard_visits
          await tx
            .delete(userDashboardVisits)
            .where(eq(userDashboardVisits.districtId, extTombstone.districtId));

          // 11. sessions (Hokim user accounts assigned to this district)
          await tx
            .delete(sessions)
            .where(
              inArray(
                sessions.accountId,
                tx
                  .select({ id: accounts.id })
                  .from(accounts)
                  .where(eq(accounts.districtId, extTombstone.districtId)),
              ),
            );

          // 12. accounts (Hokim user accounts assigned to this district)
          await tx.delete(accounts).where(eq(accounts.districtId, extTombstone.districtId));

          // 13. district_telegram_groups
          await tx
            .delete(districtTelegramGroups)
            .where(eq(districtTelegramGroups.districtId, extTombstone.districtId));

          // 14. district_telegram_bots
          await tx
            .delete(districtTelegramBots)
            .where(eq(districtTelegramBots.districtId, extTombstone.districtId));

          // 15. audit_events (District-scoped audit history)
          await tx.delete(auditEvents).where(eq(auditEvents.districtId, extTombstone.districtId));

          // 16. district_subscriptions
          await tx
            .delete(districtSubscriptions)
            .where(eq(districtSubscriptions.districtId, extTombstone.districtId));

          // 17. districts (parent district row)
          await tx.delete(districts).where(eq(districts.id, extTombstone.districtId));

          // Re-insert or update tombstone in district_deletion_records
          await tx
            .insert(districtDeletionRecords)
            .values({
              id: extTombstone.id,
              districtId: extTombstone.districtId,
              districtName: extTombstone.districtName,
              cancelledAt: extTombstone.cancelledAt ? new Date(extTombstone.cancelledAt) : null,
              cancelledById: extTombstone.cancelledById || null,
              cancellationReason: extTombstone.cancellationReason || null,
              scheduledLiveDeletionAt: new Date(extTombstone.scheduledLiveDeletionAt),
              actualLiveDeletionAt: new Date(extTombstone.actualLiveDeletionAt),
              liveDeletionStatus: 'COMPLETED',
              protectedBackupExpiryDeadline: new Date(extTombstone.protectedBackupExpiryDeadline),
              backupExpiryStatus: extTombstone.backupExpiryStatus,
              backupExpiryVerifiedAt: extTombstone.backupExpiryVerifiedAt
                ? new Date(extTombstone.backupExpiryVerifiedAt)
                : null,
              restoreReconciliationStatus: 'RECONCILED',
              restoreReconciliationVerifiedAt: now,
              createdAt: new Date(extTombstone.createdAt),
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: districtDeletionRecords.districtId,
              set: {
                liveDeletionStatus: 'COMPLETED',
                restoreReconciliationStatus: 'RECONCILED',
                restoreReconciliationVerifiedAt: now,
                updatedAt: now,
              },
            });
        });

        resurrectedDistrictsPurged.push(extTombstone.districtId);
      } else {
        // District does not exist in districts. Verify district_deletion_records tombstone presence.
        const [existingDbTombstone] = await db
          .select()
          .from(districtDeletionRecords)
          .where(eq(districtDeletionRecords.districtId, extTombstone.districtId))
          .limit(1);

        if (!existingDbTombstone) {
          // Re-insert missing tombstone row from external store
          await db
            .insert(districtDeletionRecords)
            .values({
              id: extTombstone.id,
              districtId: extTombstone.districtId,
              districtName: extTombstone.districtName,
              cancelledAt: extTombstone.cancelledAt ? new Date(extTombstone.cancelledAt) : null,
              cancelledById: extTombstone.cancelledById || null,
              cancellationReason: extTombstone.cancellationReason || null,
              scheduledLiveDeletionAt: new Date(extTombstone.scheduledLiveDeletionAt),
              actualLiveDeletionAt: new Date(extTombstone.actualLiveDeletionAt),
              liveDeletionStatus: 'COMPLETED',
              protectedBackupExpiryDeadline: new Date(extTombstone.protectedBackupExpiryDeadline),
              backupExpiryStatus: extTombstone.backupExpiryStatus,
              backupExpiryVerifiedAt: extTombstone.backupExpiryVerifiedAt
                ? new Date(extTombstone.backupExpiryVerifiedAt)
                : null,
              restoreReconciliationStatus: 'RECONCILED',
              restoreReconciliationVerifiedAt: now,
              createdAt: new Date(extTombstone.createdAt),
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: districtDeletionRecords.districtId,
              set: {
                liveDeletionStatus: 'COMPLETED',
                restoreReconciliationStatus: 'RECONCILED',
                restoreReconciliationVerifiedAt: now,
                updatedAt: now,
              },
            });
        } else {
          // Update DB tombstone reconciliation status
          await db
            .update(districtDeletionRecords)
            .set({
              restoreReconciliationStatus: 'RECONCILED',
              restoreReconciliationVerifiedAt: now,
              updatedAt: now,
            })
            .where(eq(districtDeletionRecords.districtId, extTombstone.districtId));
        }
      }

      // Collect external tombstone store entry with RECONCILED status
      const reconciledTombstone: DistrictDeletionRecord = {
        ...extTombstone,
        liveDeletionStatus: 'COMPLETED',
        restoreReconciliationStatus: 'RECONCILED',
        restoreReconciliationVerifiedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      tombstonesToPersist.push(reconciledTombstone);
      tombstonesSynchronized++;
    }

    // Bi-directional synchronization: check if database has tombstones missing from external store
    const dbTombstones = await db.select().from(districtDeletionRecords);
    for (const dbTomb of dbTombstones) {
      if (!externalTombstones.some((et) => et.districtId === dbTomb.districtId)) {
        const formattedDbTomb = formatDistrictDeletionRecord(dbTomb);
        tombstonesToPersist.push(formattedDbTomb);
        tombstonesSynchronized++;
        await db
          .update(districtDeletionRecords)
          .set({
            restoreReconciliationStatus: 'RECONCILED',
            restoreReconciliationVerifiedAt: now,
            updatedAt: now,
          })
          .where(eq(districtDeletionRecords.districtId, dbTomb.districtId));
      }
    }

    // Save all updated/synchronized tombstones in a single batch write
    if (tombstonesToPersist.length > 0) {
      await store.saveAllTombstones(tombstonesToPersist);
    }

    // -------------------------------------------------------------------------
    // STEP 2: Reapply Ordinary 90-Day Topic Retention (AC 4)
    // -------------------------------------------------------------------------
    const retentionResult = await reconcileRestoredRetention(pool, boss, db, undefined, now);
    if (retentionResult.errors && retentionResult.errors.length > 0) {
      for (const err of retentionResult.errors) {
        errors.push({ scope: `district:${err.districtId}`, error: err.error });
      }
      throw new Error(
        `Retention reconciliation failed for ${retentionResult.errors.length} district(s): ${retentionResult.errors.map((e) => e.districtId).join(', ')}`,
      );
    }

    // -------------------------------------------------------------------------
    // STEP 3: Stale pg-boss Job Queue & In-Flight Work Suppression (AC 5)
    // -------------------------------------------------------------------------
    const allDeletedDistrictIds = Array.from(
      new Set([
        ...externalTombstones.map((t) => t.districtId),
        ...dbTombstones.map((t) => t.districtId),
        ...resurrectedDistrictsPurged,
      ]),
    );

    if (allDeletedDistrictIds.length > 0) {
      try {
        const cancelResult = await pool.query(
          `UPDATE pgboss.job
           SET state = 'cancelled',
               completed_on = NOW(),
               output = jsonb_build_object(
                 'reason', 'SUPPRESSED_BY_DISASTER_RECONCILIATION',
                 'reconciledAt', NOW()
               )
           WHERE state IN ('created', 'retry', 'active')
             AND data->>'districtId' = ANY($1::text[])`,
          [allDeletedDistrictIds],
        );
        staleJobsPurged = cancelResult.rowCount || 0;
      } catch (jobErr) {
        console.error(
          JSON.stringify({
            event: 'SUPPRESS_PGBOSS_JOBS_FAILED',
            error: (jobErr as Error).message,
          }),
        );
      }
    }

    const durationMs = Math.round(performance.now() - startTime);

    // -------------------------------------------------------------------------
    // STEP 4: Single Global Audit History Event (AC 6)
    // -------------------------------------------------------------------------
    await recordAuditEvent(db, {
      districtId: null,
      actorId: options?.actor?.id || null,
      actorRole: (options?.actor?.role as 'PRODUCT_OWNER' | 'SYSTEM' | null) || 'SYSTEM',
      action: 'DISTRICT_RESTORE_RECONCILED',
      ipAddress: options?.context?.ipAddress || null,
      userAgent: options?.context?.userAgent || null,
      metadata: {
        resurrectedDistrictsPurged,
        districtsEvaluated: retentionResult.districtsEvaluated,
        expiredTopicsPurged: retentionResult.totalTopicsPurged,
        expiredEvidencePurged: retentionResult.totalEvidencePurged,
        expiredProjectionsPurged: retentionResult.totalProjectionsPurged,
        staleJobsPurged,
        tombstonesSynchronized,
        durationMs,
        outcome: 'SUCCESS',
      },
    });

    // -------------------------------------------------------------------------
    // STEP 5: Operational Issue Lifecycle Management (AC 7)
    // Automatically resolve any active disaster_restore_reconciliation_failure issue
    // -------------------------------------------------------------------------
    await db
      .update(operationalIssues)
      .set({
        status: 'RESOLVED',
        healthStatus: 'Healthy',
        resolvedAt: now,
        latestCheckAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(operationalIssues.logicalKey, 'disaster_restore_reconciliation_failure'),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );

    return {
      success: true,
      resurrectedDistrictsPurged,
      districtsEvaluated: retentionResult.districtsEvaluated,
      expiredTopicsPurged: retentionResult.totalTopicsPurged,
      expiredEvidencePurged: retentionResult.totalEvidencePurged,
      expiredProjectionsPurged: retentionResult.totalProjectionsPurged,
      staleJobsPurged,
      tombstonesSynchronized,
      errors,
      durationMs,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Record or update Critical operational issue
    try {
      const [existingIssue] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.logicalKey, 'disaster_restore_reconciliation_failure'),
            eq(operationalIssues.status, 'ACTIVE'),
          ),
        )
        .limit(1);

      if (existingIssue) {
        await db
          .update(operationalIssues)
          .set({
            latestCheckAt: now,
            sanitizedDescription: `Фалокатдан сўнг маълумотларни мувофиқлаштириш жараёнида кутилмаган хатолик юз берди: ${errorMsg}`,
            updatedAt: now,
          })
          .where(eq(operationalIssues.id, existingIssue.id));
      } else {
        await db
          .insert(operationalIssues)
          .values({
            id: `issue_${crypto.randomUUID()}`,
            logicalKey: 'disaster_restore_reconciliation_failure',
            scope: 'GLOBAL',
            districtId: null,
            component: 'scheduled_deletion',
            issueCategory: 'DISASTER_RECOVERY',
            severity: 'Critical',
            status: 'ACTIVE',
            healthStatus: 'UNAVAILABLE',
            sanitizedTitle: 'Фалокатдан сўнг тиклашда маълумотларни мувофиқлаштиришда хатолик юз берди',
            sanitizedDescription: `Фалокатдан сўнг маълумотларни мувофиқлаштириш жараёнида кутилмаган хатолик юз берди: ${errorMsg}`,
            recommendedAction:
              'Фалокатдан сўнг маълумотларни мувофиқлаштириш (reconcile-restore) буйруғини қайта ишга туширинг ва журналларни текширинг.',
            targetRoute: '/system/health',
            startedAt: now,
            latestCheckAt: now,
            resolvedAt: null,
            metadata: { error: errorMsg },
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: operationalIssues.logicalKey,
            targetWhere: sql`${operationalIssues.status} = 'ACTIVE'`,
            set: {
              status: 'ACTIVE',
              healthStatus: 'UNAVAILABLE',
              sanitizedDescription: `Фалокатдан сўнг маълумотларни мувофиқлаштириш жараёнида кутилмаган хатолик юз берди: ${errorMsg}`,
              latestCheckAt: now,
              updatedAt: now,
            },
          });
      }

      await recordAuditEvent(db, {
        districtId: null,
        actorId: options?.actor?.id || null,
        actorRole: (options?.actor?.role as 'PRODUCT_OWNER' | 'SYSTEM' | null) || 'SYSTEM',
        action: 'DISTRICT_RESTORE_RECONCILIATION_FAILED',
        ipAddress: options?.context?.ipAddress || null,
        userAgent: options?.context?.userAgent || null,
        metadata: {
          error: errorMsg,
          resurrectedDistrictsPurged,
          durationMs: Math.round(performance.now() - startTime),
          outcome: 'FAILURE',
        },
      });
    } catch (issueErr) {
      console.error(
        JSON.stringify({
          event: 'RECORD_DISASTER_RECONCILIATION_FAILURE_ISSUE_FAILED',
          error: (issueErr as Error).message,
        }),
      );
    }

    throw error;
  }
}
