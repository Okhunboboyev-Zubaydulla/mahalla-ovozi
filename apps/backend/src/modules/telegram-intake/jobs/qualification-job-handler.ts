import type PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import type { DbClient } from '../../../adapters/db/client.js';
import {
  districts,
  telegramIntakeRecords,
} from '../../../adapters/db/schema/index.js';
import {
  TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
  TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
  JobSingletonKeys,
  sendQueueJob,
  type TelegramContentQualificationJobData,
  type TelegramSemanticRelevanceJobData,
} from '../../../adapters/jobs/boss-client.js';
import { qualifyTelegramContent } from '../telegram-content-qualification.js';

import { clearPendingRetryFlag } from '../../issues/retry-service.js';

export interface QualificationJobDeps {
  db: DbClient;
  boss: PgBoss;
}

export async function processQualificationJobs(
  jobs: PgBoss.Job<TelegramContentQualificationJobData>[],
  deps: QualificationJobDeps,
): Promise<void> {
  const { db, boss } = deps;
  for (const job of jobs) {
    const { intakeId, districtId, mahallaName, telegramChatId, telegramMessageId } = job.data;
    const startTime = performance.now();

    try {
      // 1. Fetch raw intake record from database
      const [record] = await db
        .select()
        .from(telegramIntakeRecords)
        .where(eq(telegramIntakeRecords.id, intakeId))
        .limit(1);

      if (!record) {
        console.warn(
          JSON.stringify({
            event: 'TELEGRAM_INTAKE_RECORD_NOT_FOUND',
            intakeId,
            districtId,
            telegramChatId,
            telegramMessageId,
          }),
        );
        throw new Error(
          `Telegram intake record ${intakeId} not found in database (district: ${districtId}, chat: ${telegramChatId}, message: ${telegramMessageId})`,
        );
      }

      // 2. Lifecycle Recheck: verify district is ACTIVE and accessEligible !== false (AC 7 & AD-9)
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
            event: 'TELEGRAM_QUALIFICATION_DROPPED_INACTIVE_DISTRICT',
            districtId,
            mahallaName,
            telegramChatId,
            telegramMessageId,
            districtStatus: district?.status ?? 'NOT_FOUND',
            accessEligible: district?.accessEligible ?? false,
            durationMs,
          }),
        );
        continue;
      }

      // 3. Pure Content Qualification Evaluation (AC 1-5, 8, 10)
      const qualification = qualifyTelegramContent(record);
      const durationMs = Math.round(performance.now() - startTime);

      if (qualification.status === 'SUPPORTED') {
        // 4. Enqueue downstream semantic relevance job with deduplicating singleton key (AC 6, 8)
        const candidateData: TelegramSemanticRelevanceJobData = qualification.candidate;
        const singletonKey = JobSingletonKeys.forSemanticRelevance(districtId, telegramChatId, telegramMessageId);

        await sendQueueJob(boss, TELEGRAM_SEMANTIC_RELEVANCE_QUEUE, candidateData, {
          singletonKey,
        });

        // 5. Emit privacy-safe structured telemetry (AD-11 / AC 9)
        console.log(
          JSON.stringify({
            event: 'TELEGRAM_CONTENT_QUALIFIED',
            districtId,
            mahallaName,
            telegramChatId,
            telegramMessageId,
            status: 'SUPPORTED',
            contentType: qualification.candidate.contentType,
            durationMs,
          }),
        );
      } else {
        // Structurally excluded: discard content without enqueuing downstream AI job (AC 3, 4, 9)
        const currentPayload =
          typeof record.rawPayload === 'object' && record.rawPayload !== null
            ? (record.rawPayload as Record<string, unknown>)
            : {};

        await db
          .update(telegramIntakeRecords)
          .set({
            rawPayload: {
              ...currentPayload,
              status: 'EXCLUDED',
              exclusionReason: qualification.reason,
            },
            updatedAt: new Date(),
          })
          .where(eq(telegramIntakeRecords.id, intakeId));

        console.log(
          JSON.stringify({
            event: 'TELEGRAM_CONTENT_EXCLUDED',
            districtId,
            mahallaName,
            telegramChatId,
            telegramMessageId,
            status: 'EXCLUDED',
            reason: qualification.reason,
            durationMs,
          }),
        );
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'TELEGRAM_CONTENT_QUALIFICATION_ERROR',
          intakeId,
          districtId,
          telegramChatId,
          telegramMessageId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      throw err; // Re-throw to trigger pg-boss retry policy for transient errors
    } finally {
      if (job.data?.issueId) {
        await clearPendingRetryFlag(db, job.data.issueId);
      }
    }
  }
}



export async function registerQualificationJobHandler(
  boss: PgBoss,
  deps: QualificationJobDeps,
): Promise<void> {
  await boss.work<TelegramContentQualificationJobData>(
    TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
    { newJobCheckInterval: 50 } as any,
    (jobs) => processQualificationJobs(jobs, deps),
  );
}
