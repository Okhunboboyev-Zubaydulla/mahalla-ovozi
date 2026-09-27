import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { fileURLToPath } from 'node:url';

import path from 'node:path';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import {
  createBossClient,
  initBossQueues,
  TELEGRAM_BURST_DEBOUNCE_QUEUE,
  TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
  TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
  TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  TELEGRAM_TOPIC_RETENTION_QUEUE,
  DISTRICT_SUBSCRIPTION_EXPIRY_QUEUE,
  DISTRICT_LIVE_DELETION_QUEUE,
  DISTRICT_BACKUP_EXPIRY_QUEUE,
} from '../adapters/jobs/boss-client.js';
import { createDbPool, createDbClient, type DbClient } from '../adapters/db/client.js';
import { ensureDefaultAiProfiles } from '../adapters/db/seeds.js';
import { AiGateway, type AiGatewayPort } from '../modules/ai/ai-gateway.js';
import type { AiProviderAdapterPort } from '../modules/ai/types.js';
import { HttpProviderAdapter } from '../adapters/ai-providers/http-provider-adapter.js';
import { SemanticRelevanceEvaluator } from '../modules/ai/semantic-relevance-evaluator.js';
import { TopicMatchingEvaluator } from '../modules/topics/topic-matching-evaluator.js';
import { TopicProjectionEvaluator } from '../modules/topics/topic-projection-evaluator.js';
import type { AcceptedEvidenceItem } from '../modules/ai/context-snapshot.js';
import type { BackupRetentionVerifier } from '../modules/subscriptions/ports/backup-retention-verifier.js';
import { SystemBackupRetentionVerifier } from '../adapters/backup/system-backup-verifier.js';

import { registerBurstDebounceJobHandler } from '../modules/telegram-intake/jobs/burst-debounce-job-handler.js';
import { registerQualificationJobHandler } from '../modules/telegram-intake/jobs/qualification-job-handler.js';
import { registerSemanticRelevanceJobHandler } from '../modules/ai/jobs/semantic-relevance-job-handler.js';
import { registerTopicAssignmentJobHandler } from '../modules/topics/jobs/topic-assignment-job-handler.js';
import { registerTopicProjectionJobHandler } from '../modules/topics/jobs/topic-projection-job-handler.js';
import { registerRetentionJobHandler } from '../modules/retention/jobs/retention-job-handler.js';
import { registerSubscriptionExpiryJobHandler } from '../modules/subscriptions/jobs/subscription-expiry-job-handler.js';
import { registerDistrictDeletionJobHandler } from '../modules/subscriptions/jobs/district-deletion-job-handler.js';
import { checkAndHealTelegramWebhooks } from '../modules/telegram-intake/telegram-watchdog.js';

let activeBossInstance: PgBoss | null = null;
let internalPool: pg.Pool | null = null;
let activeWatchdogTimer: NodeJS.Timeout | null = null;

export interface StartWorkerOptions {
  boss?: PgBoss;
  db?: DbClient;
  pool?: pg.Pool;
  aiGateway?: AiGatewayPort;
  backupVerifier?: BackupRetentionVerifier;
  queues?: string[];
  injectedEvidenceResolver?: (
    districtId: string,
    mahallaName: string,
    calendarDay: string,
  ) => Promise<AcceptedEvidenceItem[] | undefined>;
}

export interface WorkerPipelineContext {
  db: DbClient;
  pool: pg.Pool;
  boss: PgBoss;
  aiGateway: AiGatewayPort;
  relevanceEvaluator: SemanticRelevanceEvaluator;
  topicMatchingEvaluator: TopicMatchingEvaluator;
  topicProjectionEvaluator: TopicProjectionEvaluator;
  backupVerifier: BackupRetentionVerifier;
  injectedEvidenceResolver?: (
    districtId: string,
    mahallaName: string,
    calendarDay: string,
  ) => Promise<AcceptedEvidenceItem[] | undefined>;
}

/**
 * Registers all durable job pipeline workers into pg-boss, conditionally filtering by active queues.
 */
export async function registerWorkerPipelines(
  boss: PgBoss,
  ctx: WorkerPipelineContext,
  activeQueues?: string[],
): Promise<void> {
  const shouldWork = (queueName: string) => !activeQueues || activeQueues.includes(queueName);

  if (shouldWork(TELEGRAM_BURST_DEBOUNCE_QUEUE)) {
    await registerBurstDebounceJobHandler(boss, { db: ctx.db, boss: ctx.boss });
  }

  if (shouldWork(TELEGRAM_CONTENT_QUALIFICATION_QUEUE)) {
    await registerQualificationJobHandler(boss, { db: ctx.db, boss: ctx.boss });
  }

  if (shouldWork(TELEGRAM_SEMANTIC_RELEVANCE_QUEUE)) {
    await registerSemanticRelevanceJobHandler(boss, {
      db: ctx.db,
      pool: ctx.pool,
      boss: ctx.boss,
      relevanceEvaluator: ctx.relevanceEvaluator,
      injectedEvidenceResolver: ctx.injectedEvidenceResolver,
    });
  }

  if (shouldWork(TELEGRAM_TOPIC_ASSIGNMENT_QUEUE)) {
    await registerTopicAssignmentJobHandler(boss, {
      db: ctx.db,
      pool: ctx.pool,
      boss: ctx.boss,
      topicMatchingEvaluator: ctx.topicMatchingEvaluator,
      injectedEvidenceResolver: ctx.injectedEvidenceResolver,
    });
  }

  if (shouldWork(TELEGRAM_TOPIC_PROJECTION_QUEUE)) {
    await registerTopicProjectionJobHandler(boss, {
      db: ctx.db,
      pool: ctx.pool,
      boss: ctx.boss,
      topicProjectionEvaluator: ctx.topicProjectionEvaluator,
      injectedEvidenceResolver: ctx.injectedEvidenceResolver,
    });
  }

  if (shouldWork(TELEGRAM_TOPIC_RETENTION_QUEUE)) {
    await registerRetentionJobHandler(boss, { db: ctx.db, pool: ctx.pool, boss: ctx.boss });
  }

  if (shouldWork(DISTRICT_SUBSCRIPTION_EXPIRY_QUEUE)) {
    await registerSubscriptionExpiryJobHandler(boss, { db: ctx.db, boss: ctx.boss });
  }

  if (
    shouldWork(DISTRICT_LIVE_DELETION_QUEUE) ||
    shouldWork(DISTRICT_BACKUP_EXPIRY_QUEUE)
  ) {
    await registerDistrictDeletionJobHandler(boss, {
      db: ctx.db,
      boss: ctx.boss,
      backupVerifier: ctx.backupVerifier,
    });
  }
}

export async function startWorker(options?: StartWorkerOptions): Promise<PgBoss> {
  const boss = options?.boss || createBossClient();
  activeBossInstance = boss;

  let pool = options?.pool;
  let db = options?.db;

  if (!db) {
    if (!pool) {
      pool = createDbPool();
      internalPool = pool;
    }
    db = createDbClient(pool);
  } else if (!pool) {
    pool = createDbPool();
    internalPool = pool;
  }

  boss.on('error', (error) => {
    console.error('[worker:pg-boss] Background queue error:', error);
  });

  await boss.start();
  await initBossQueues(boss);
  await ensureDefaultAiProfiles(db);

  const aiProviderAdapters = new Map<string, AiProviderAdapterPort>([
    ['OPENAI', new HttpProviderAdapter('OPENAI')],
    ['GEMINI', new HttpProviderAdapter('GEMINI')],
    ['DEEPINFRA', new HttpProviderAdapter('DEEPINFRA')],
    ['OLLAMA', new HttpProviderAdapter('OLLAMA')],
  ]);
  const aiGateway: AiGatewayPort = options?.aiGateway || new AiGateway({ db, customAdapters: aiProviderAdapters });
  const relevanceEvaluator = new SemanticRelevanceEvaluator(aiGateway);
  const topicMatchingEvaluator = new TopicMatchingEvaluator(aiGateway);
  const topicProjectionEvaluator = new TopicProjectionEvaluator(aiGateway);
  const backupVerifier: BackupRetentionVerifier =
    options?.backupVerifier || new SystemBackupRetentionVerifier();

  const context: WorkerPipelineContext = {
    db,
    pool,
    boss,
    aiGateway,
    relevanceEvaluator,
    topicMatchingEvaluator,
    topicProjectionEvaluator,
    backupVerifier,
    injectedEvidenceResolver: options?.injectedEvidenceResolver,
  };

  await registerWorkerPipelines(boss, context, options?.queues);

  // Periodic self-healing Telegram webhook watchdog (runs every 60s)
  const watchdogPool = pool;
  const runWatchdog = async () => {
    try {
      await checkAndHealTelegramWebhooks(watchdogPool, {});
    } catch (err: unknown) {
      console.error('[worker:watchdog] Failed to execute telegram webhook watchdog', err);
    }
  };

  const initialTimeout = setTimeout(() => {
    runWatchdog().catch(() => {});
    activeWatchdogTimer = setInterval(() => {
      runWatchdog().catch(() => {});
    }, 60000);
    activeWatchdogTimer.unref();
  }, 5000);
  initialTimeout.unref();

  console.log('[worker] Mahalla Ovozi worker process started successfully');
  return boss;
}

export async function stopWorker(bossInstance?: PgBoss): Promise<void> {
  if (activeWatchdogTimer) {
    clearInterval(activeWatchdogTimer);
    activeWatchdogTimer = null;
  }

  const boss = bossInstance || activeBossInstance;
  if (boss) {
    console.log('[worker] Stopping pg-boss worker gracefully...');
    await boss.stop({ graceful: true, timeout: 30000 });
    console.log('[worker] pg-boss worker stopped.');
    if (activeBossInstance === boss) {
      activeBossInstance = null;
    }
  }

  if (internalPool) {
    await internalPool.end();
    internalPool = null;
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  startWorker().catch((err) => {
    console.error('[worker] Failed to start worker:', err);
    process.exit(1);
  });

  let isShuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[worker] Received ${signal}, initiating graceful shutdown...`);
    await stopWorker();
    process.exit(0);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}
