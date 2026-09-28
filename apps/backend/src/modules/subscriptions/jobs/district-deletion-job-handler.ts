import type PgBoss from 'pg-boss';
import { eq, and, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { DbClient } from '../../../adapters/db/client.js';
import {
  DISTRICT_LIVE_DELETION_QUEUE,
  DISTRICT_LIVE_DELETION_CRON_QUEUE,
  DISTRICT_BACKUP_EXPIRY_QUEUE,
  DISTRICT_BACKUP_EXPIRY_CRON_QUEUE,
  DistrictLiveDeletionJobData,
  DistrictBackupExpiryJobData,
} from '../../../adapters/jobs/boss-client.js';
import {
  executeDistrictLiveDeletion,
  processOverdueCancelledDistricts,
  verifyDistrictBackupExpiry,
  processOverdueBackupExpiries,
} from '../district-deletion-service.js';
import type { BackupRetentionVerifier } from '../ports/backup-retention-verifier.js';
import { SystemBackupRetentionVerifier } from '../../../adapters/backup/system-backup-verifier.js';
import { operationalIssues } from '../../../adapters/db/schema/index.js';
import { clearPendingRetryFlag } from '../../issues/retry-service.js';

export interface DistrictDeletionJobDeps {
  db: DbClient;
  boss?: PgBoss;
  backupVerifier?: BackupRetentionVerifier;
}

export async function processDistrictDeletionJobs(
  jobs: PgBoss.Job<DistrictLiveDeletionJobData>[],
  deps: DistrictDeletionJobDeps,
): Promise<void> {
  const { db, boss } = deps;
  const errors: Error[] = [];

  for (const job of jobs) {
    const { districtId } = job.data;
    try {
      // Execute live deletion (safe no-op/null return if recovered or reactivated)
      await executeDistrictLiveDeletion(db, districtId, {
        actor: { id: null, role: 'SYSTEM' },
        boss,
      });
    } catch (err) {
      const errorMsg = (err as Error).message;
      console.error(
        JSON.stringify({
          event: 'DISTRICT_LIVE_DELETION_JOB_FAILED',
          districtId,
          error: errorMsg,
        }),
      );

      // Record or update Critical operational issue for System Health diagnostics (AC 3, AC 11)
      try {
        const now = new Date();
        const logicalKey = `del_fail:${districtId}`;

        const [existingIssue] = await db
          .select()
          .from(operationalIssues)
          .where(
            and(
              eq(operationalIssues.logicalKey, logicalKey),
              eq(operationalIssues.status, 'ACTIVE'),
            ),
          )
          .limit(1);

        if (existingIssue) {
          await db
            .update(operationalIssues)
            .set({
              latestCheckAt: now,
              sanitizedDescription: `Туманни ўчириш жараёнида хатолик юз берди: ${errorMsg}`,
              updatedAt: now,
              metadata: {
                ...((existingIssue.metadata as Record<string, unknown>) || {}),
                districtId,
                deletedDistrictId: districtId,
                error: errorMsg,
                errorCode: 'LIVE_DELETION_FAILED',
              },
            })
            .where(eq(operationalIssues.id, existingIssue.id));
        } else {
          await db
            .insert(operationalIssues)
            .values({
              id: `iss_${crypto.randomUUID()}`,
              logicalKey,
              scope: 'GLOBAL',
              districtId: null, // Scoped to system since district row might be mid-state or deleted
              component: 'scheduled_deletion',
              issueCategory: 'LIFECYCLE_DELETION',
              severity: 'Critical',
              status: 'ACTIVE',
              healthStatus: 'UNAVAILABLE',
              sanitizedTitle: 'Туманни жонли тизимдан ўчиришда хатолик юз берди',
              sanitizedDescription: `Туманни ўчириш жараёнида хатолик юз берди (ID: ${districtId}): ${errorMsg}`,
              recommendedAction: 'Ўчириш жараёнини журналлар орқали текшириб, қайта ишга туширинг.',
              metadata: {
                districtId,
                deletedDistrictId: districtId,
                error: errorMsg,
                errorCode: 'LIVE_DELETION_FAILED',
              },
              startedAt: now,
              latestCheckAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: operationalIssues.logicalKey,
              targetWhere: sql`${operationalIssues.status} = 'ACTIVE'`,
              set: {
                latestCheckAt: now,
                sanitizedDescription: `Туманни ўчириш жараёнида хатолик юз берди: ${errorMsg}`,
                metadata: {
                  districtId,
                  deletedDistrictId: districtId,
                  error: errorMsg,
                  errorCode: 'LIVE_DELETION_FAILED',
                },
                updatedAt: now,
              },
            });
        }
      } catch (issueErr) {
        console.error(
          JSON.stringify({
            event: 'DISTRICT_LIVE_DELETION_ISSUE_CREATION_FAILED',
            districtId,
            error: (issueErr as Error).message,
          }),
        );
      }

      errors.push(err as Error);
    } finally {
      if (job.data.issueId) {
        await clearPendingRetryFlag(db, job.data.issueId);
      }
    }
  }

  if (errors.length > 0) {
    throw errors[0];
  }
}

export async function processDistrictBackupExpiryJobs(
  jobs: PgBoss.Job<DistrictBackupExpiryJobData>[],
  deps: DistrictDeletionJobDeps,
): Promise<void> {
  const { db, backupVerifier } = deps;
  const verifier = backupVerifier || new SystemBackupRetentionVerifier();
  const errors: Error[] = [];

  for (const job of jobs) {
    const { districtId } = job.data;
    try {
      await verifyDistrictBackupExpiry(db, verifier, districtId, {
        actor: { id: null, role: 'SYSTEM' },
      });
    } catch (err) {
      const errorMsg = (err as Error).message;
      console.error(
        JSON.stringify({
          event: 'DISTRICT_BACKUP_EXPIRY_JOB_FAILED',
          districtId,
          error: errorMsg,
        }),
      );
      errors.push(err as Error);
    } finally {
      if (job.data.issueId) {
        await clearPendingRetryFlag(db, job.data.issueId);
      }
    }
  }

  if (errors.length > 0) {
    throw errors[0];
  }
}

export async function registerDistrictDeletionJobHandler(
  boss: PgBoss,
  deps: DistrictDeletionJobDeps,
): Promise<void> {
  // 1. Process delayed individual live deletion jobs
  await boss.work<DistrictLiveDeletionJobData>(
    DISTRICT_LIVE_DELETION_QUEUE,
    async (jobs) => {
      await processDistrictDeletionJobs(jobs, deps);
    },
  );

  // 2. Periodic recurring cron sweep every 1 minute as resilient fallback for live deletion (AC 9)
  await boss.schedule(
    DISTRICT_LIVE_DELETION_CRON_QUEUE,
    '* * * * *',
    {},
    { tz: 'UTC' },
  );

  await boss.work(
    DISTRICT_LIVE_DELETION_CRON_QUEUE,
    async () => {
      await processOverdueCancelledDistricts(deps.db, deps.boss);
    },
  );

  // 3. Process delayed individual backup expiry verification jobs (Story 6.5 AC 6)
  await boss.work<DistrictBackupExpiryJobData>(
    DISTRICT_BACKUP_EXPIRY_QUEUE,
    async (jobs) => {
      await processDistrictBackupExpiryJobs(jobs, deps);
    },
  );

  // 4. Periodic recurring cron sweep every 5 minutes as resilient fallback for backup expiry (Story 6.5 AC 6)
  await boss.schedule(
    DISTRICT_BACKUP_EXPIRY_CRON_QUEUE,
    '*/5 * * * *',
    {},
    { tz: 'UTC' },
  );

  await boss.work(
    DISTRICT_BACKUP_EXPIRY_CRON_QUEUE,
    async () => {
      const verifier = deps.backupVerifier || new SystemBackupRetentionVerifier();
      await processOverdueBackupExpiries(deps.db, verifier);
    },
  );
}
