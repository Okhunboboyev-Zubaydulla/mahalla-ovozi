import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import PgBoss from 'pg-boss';
import * as schema from '../db/schema/index.js';
import { resolveDatabaseUrl } from '../db/client.js';
import type {
  BossQueueMap,
  BossQueueName,
} from './job-types.js';

// Re-export everything from job-types.ts for backward compatibility —
// all existing consumers of boss-client.ts continue to work unchanged.
export * from './job-types.js';

export const DEFAULT_QUEUE_CONFIGS: Record<string, Omit<PgBoss.SendOptions, 'db'>> = {
  'telegram-burst-debounce': {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInMinutes: 10,
    retentionDays: 1,
  },
  'telegram-content-qualification': {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInMinutes: 10,
    retentionDays: 1,
  },
  'telegram-semantic-relevance': {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInMinutes: 10,
    retentionDays: 1,
  },
  'telegram-topic-assignment': {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInMinutes: 10,
    retentionDays: 1,
  },
  'telegram-topic-projection': {
    retryLimit: 5,
    retryDelay: 15,
    retryBackoff: true,
    expireInMinutes: 15,
    retentionDays: 1,
  },
  'telegram-topic-retention': {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: false,
    expireInMinutes: 30,
    retentionDays: 3,
  },
  'district-subscription-expiry': {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInMinutes: 10,
    retentionDays: 2,
  },
  'district-live-deletion': {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInMinutes: 15,
    retentionDays: 3,
  },
  'district-backup-expiry': {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInMinutes: 15,
    retentionDays: 3,
  },
};

export function createBossClient(options?: { connectionString?: string; schema?: string }): PgBoss {
  // Same resolver as createDbPool (L2-P01-01): one place decides the database target, so the
  // pool and the queue can never disagree about which database they are talking to.
  const connectionString = resolveDatabaseUrl(options?.connectionString);

  return new PgBoss({
    connectionString,
    schema: options?.schema || 'pgboss',
    max: 10,
  });
}

/**
 * Ensures all required pg-boss queues exist in pgboss.queue.
 * Mandatory in pg-boss 10.x before sending or working on queues.
 * This operation is idempotent.
 */
export async function initBossQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue('telegram-burst-debounce');
  await boss.createQueue('telegram-content-qualification');
  await boss.createQueue('telegram-semantic-relevance');
  await boss.createQueue('telegram-topic-assignment');
  await boss.createQueue('telegram-topic-projection', { name: 'telegram-topic-projection', policy: 'short' });
  await boss.updateQueue('telegram-topic-projection', { name: 'telegram-topic-projection', policy: 'short' });
  await boss.createQueue('telegram-topic-projection-reconcile-cron');
  await boss.createQueue('telegram-topic-retention');
  await boss.createQueue('district-subscription-expiry');
  await boss.createQueue('district-subscription-expiry-cron');
  await boss.createQueue('district-live-deletion');
  await boss.createQueue('district-live-deletion-cron');
  await boss.createQueue('district-backup-expiry');
  await boss.createQueue('district-backup-expiry-cron');
}

/**
 * Standard singleton key generators for pg-boss deduplication and ordering.
 */
export const JobSingletonKeys = {
  /** Deduplication key for Telegram burst debounce aggregation. */
  forBurstDebounce(districtId: string, chatId: string, userId?: string | null): string {
    return `burst:${districtId}:${chatId}:${userId || 'anon'}`;
  },

  /** Deduplication key for Telegram message intake qualification. */
  forContentQualification(districtId: string, chatId: string, messageId: string): string {
    return `msg:${districtId}:${chatId}:${messageId}`;
  },

  /** Deduplication key for Semantic Relevance AI evaluation. */
  forSemanticRelevance(districtId: string, chatId: string, messageId: string): string {
    return `rel:${districtId}:${chatId}:${messageId}`;
  },

  /** Deduplication key for Topic Assignment AI evaluation. */
  forTopicAssignment(districtId: string, chatId: string, messageId: string): string {
    return `topic:${districtId}:${chatId}:${messageId}`;
  },

  /** Coalescing key for Topic Projection AI recalculation (AD-7). */
  forTopicProjection(topicId: string, generation: number): string {
    return `proj:${topicId}:${generation}`;
  },

  /** Ordering serialization key for same-day Mahalla civic signal ordering (AD-3). */
  forDistrictMahallaDay(districtId: string, mahallaName: string, calendarDay: string): string {
    return `scope:${districtId}:${mahallaName.trim().toLowerCase()}:${calendarDay}`;
  },

  /** Deduplication key for Global or District retention scans (Story 4.3 Task 3). */
  forRetention(districtId?: string): string {
    return `retention:${districtId || 'global'}`;
  },

  /** Deduplication key for District subscription Grace expiry. */
  forSubscriptionExpiry(districtId: string): string {
    return `sub-expiry:${districtId}`;
  },

  /** Deduplication key for District permanent live deletion. */
  forLiveDeletion(districtId: string): string {
    return `live-del:${districtId}`;
  },

  /** Deduplication key for District protected-backup expiry. */
  forBackupExpiry(districtId: string): string {
    return `backup-exp:${districtId}`;
  },
};

/**
 * Sends a job to a pg-boss queue with default resilient retry/retention options automatically applied.
 * Enforces strict mapping between queue name and payload shape (AD-3).
 */
export async function sendQueueJob<K extends BossQueueName>(
  boss: PgBoss,
  queueName: K,
  data: BossQueueMap[K],
  options?: PgBoss.SendOptions,
): Promise<string | null>;
export async function sendQueueJob<T extends object>(
  boss: PgBoss,
  queueName: string,
  data: T,
  options?: PgBoss.SendOptions,
): Promise<string | null>;
export async function sendQueueJob<T extends object>(
  boss: PgBoss,
  queueName: string,
  data: T,
  options?: PgBoss.SendOptions,
): Promise<string | null> {
  const defaultOpts = DEFAULT_QUEUE_CONFIGS[queueName] || {};
  const mergedOptions: PgBoss.SendOptions = {
    ...defaultOpts,
    ...options,
  };
  return boss.send(queueName, data, mergedOptions);
}

export interface TransactionScope {
  tx: NodePgDatabase<typeof schema>;
  client: pg.PoolClient;
  enqueueJob: {
    <K extends BossQueueName>(
      queueName: K,
      data: BossQueueMap[K],
      options?: Omit<PgBoss.SendOptions, 'db'>,
    ): Promise<string | null>;
    <T extends object>(
      queueName: string,
      data: T,
      options?: Omit<PgBoss.SendOptions, 'db'>,
    ): Promise<string | null>;
  };
}

/**
 * Executes database operations and pg-boss job dispatch atomically within a single
 * PostgreSQL transaction block (BEGIN ... COMMIT). If either the database operations
 * or the pg-boss enqueue fail, the entire transaction is rolled back.
 */
export async function withTransactionalIntake<T>(
  pool: pg.Pool,
  boss: PgBoss,
  callback: (scope: TransactionScope) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let rollbackError: unknown = null;
  try {
    await client.query('BEGIN');
    const tx = drizzle(client, { schema });

    const enqueueJob = async <J extends object>(
      queueName: string,
      data: J,
      options?: Omit<PgBoss.SendOptions, 'db'>,
    ): Promise<string | null> => {
      const defaultOpts = DEFAULT_QUEUE_CONFIGS[queueName] || {};
      return boss.send(queueName, data, {
        ...defaultOpts,
        ...options,
        db: {
          executeSql: async (text: string, values?: unknown[]) => {
            const res = await client.query(text, values as any[]);
            return {
              rows: res.rows,
              rowCount: res.rowCount ?? 0,
            };
          },
        },
      });
    };

    const result = await callback({ tx, client, enqueueJob });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      rollbackError = rbErr;
    }
    throw error;
  } finally {
    client.release(rollbackError ? true : undefined);
  }
}
