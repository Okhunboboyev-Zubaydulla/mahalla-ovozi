import type PgBoss from 'pg-boss';
import type { DbClient } from '../../../adapters/db/client.js';
import {
  DISTRICT_SUBSCRIPTION_EXPIRY_QUEUE,
  DISTRICT_SUBSCRIPTION_EXPIRY_CRON_QUEUE,
  DistrictSubscriptionExpiryJobData,
} from '../../../adapters/jobs/boss-client.js';
import {
  expireDistrictGrace,
  processOverdueGraceSubscriptions,
} from '../subscriptions-service.js';

export interface SubscriptionExpiryJobDeps {
  db: DbClient;
  boss?: PgBoss;
}

export async function processSubscriptionExpiryJobs(
  jobs: PgBoss.Job<DistrictSubscriptionExpiryJobData>[],
  deps: SubscriptionExpiryJobDeps,
): Promise<void> {
  const { db } = deps;
  for (const job of jobs) {
    const { districtId } = job.data;
    try {
      await expireDistrictGrace(db, districtId);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'SUBSCRIPTION_EXPIRY_JOB_FAILED',
          districtId,
          error: (err as Error).message,
        }),
      );
      throw err;
    }
  }
}

export async function registerSubscriptionExpiryJobHandler(
  boss: PgBoss,
  deps: SubscriptionExpiryJobDeps,
): Promise<void> {
  // 1. Process delayed individual expiry jobs
  await boss.work<DistrictSubscriptionExpiryJobData>(
    DISTRICT_SUBSCRIPTION_EXPIRY_QUEUE,
    async (jobs) => {
      await processSubscriptionExpiryJobs(jobs, deps);
    },
  );

  // 2. Periodic recurring cron sweep every 1 minute as fallback
  await boss.schedule(
    DISTRICT_SUBSCRIPTION_EXPIRY_CRON_QUEUE,
    '* * * * *',
    {},
    { tz: 'UTC' },
  );

  await boss.work(
    DISTRICT_SUBSCRIPTION_EXPIRY_CRON_QUEUE,
    async () => {
      await processOverdueGraceSubscriptions(deps.db);
    },
  );
}
