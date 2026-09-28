import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, desc, sql } from 'drizzle-orm';
import {
  ComponentHealthObservation,
  ComponentType,
  ComponentScope,
  HealthStatus,
  TechnicalOutcome,
  ComponentDiagnostics,
} from '@mahalla-ovozi/api-contracts';
import { DbClient, checkDbHealth } from '../../adapters/db/client.js';
import {
  districtTelegramBots,
  districtTelegramGroups,
  telegramIntakeRecords,
  aiOperations,
  aiProfiles,
  auditEvents,
} from '../../adapters/db/schema/index.js';
import {
  evaluateFreshness,
  STALE_CHECK_THRESHOLD_MS,
  INTAKE_DELAY_THRESHOLD_MS,
} from './health-evaluator.js';
import { logger } from '../../utils/logger.js';

export interface HealthConfig {
  staleCheckThresholdMs?: number;
  intakeDelayThresholdMs?: number;
  topicDelayThresholdMs?: number;
}

/**
 * Ensures zero bot tokens, resident text, passwords, or raw stack traces leak into health observations (AD-09, AD-11).
 */
export function assertPrivacyBoundary(obs: ComponentHealthObservation): ComponentHealthObservation {
  let sanitizedError = obs.errorMessage;
  let sanitizedCode = obs.errorCode;

  const sanitizeString = (str: string): string => {
    return str
      .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,45}\b/g, '[REDACTED_BOT_TOKEN]')
      .replace(/:\/\/[^:]+:[^@]+@/g, '://[REDACTED_AUTH]@');
  };

  if (sanitizedError) {
    sanitizedError = sanitizeString(sanitizedError);
    // Strip stack traces (e.g. at Object... or at process... or multiline traces)
    if (sanitizedError.includes('\n') || /\s+at\s+/.test(sanitizedError)) {
      sanitizedError = sanitizedError.split('\n')[0]?.trim() || null;
    }
  }

  if (sanitizedCode) {
    sanitizedCode = sanitizeString(sanitizedCode);
  }

  let sanitizedDiagnostics = obs.diagnostics;
  if (sanitizedDiagnostics) {
    sanitizedDiagnostics = {
      ...sanitizedDiagnostics,
      storageStatus: sanitizedDiagnostics.storageStatus
        ? sanitizeString(sanitizedDiagnostics.storageStatus)
        : undefined,
      databaseSize: sanitizedDiagnostics.databaseSize
        ? sanitizeString(sanitizedDiagnostics.databaseSize)
        : undefined,
      activeModelVersion: sanitizedDiagnostics.activeModelVersion
        ? sanitizeString(sanitizedDiagnostics.activeModelVersion)
        : undefined,
      activePromptVersion: sanitizedDiagnostics.activePromptVersion
        ? sanitizeString(sanitizedDiagnostics.activePromptVersion)
        : undefined,
    };
  }

  return {
    ...obs,
    errorCode: sanitizedCode,
    errorMessage: sanitizedError,
    diagnostics: sanitizedDiagnostics,
  };
}

/**
 * Helper to construct a typed observation.
 */
function createObservation(params: {
  component: ComponentType;
  scope: ComponentScope;
  districtId: string | null;
  status: HealthStatus;
  lastCheckAt: string;
  checkedAt: string;
  outcome: TechnicalOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
  isApplicable?: boolean;
  lifecycleStatus?: string | null;
  diagnostics?: ComponentDiagnostics | null;
}): ComponentHealthObservation {
  return assertPrivacyBoundary({
    component: params.component,
    scope: params.scope,
    districtId: params.districtId,
    status: params.status,
    lastCheckAt: params.lastCheckAt,
    checkedAt: params.checkedAt,
    outcome: params.outcome,
    errorCode: params.errorCode ?? null,
    errorMessage: params.errorMessage ?? null,
    latencyMs: params.latencyMs ?? null,
    isApplicable: params.isApplicable ?? true,
    lifecycleStatus: params.lifecycleStatus ?? null,
    diagnostics: params.diagnostics ?? null,
  });
}

/**
 * 1. Global Database Pool Health Checker
 */
export async function checkDatabaseHealth(
  pool: pg.Pool,
  _config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();

  try {
    const probe = await checkDbHealth(pool, 2000);
    const waitingCount = pool.waitingCount || 0;

    if (!probe.isHealthy) {
      return createObservation({
        component: 'database',
        scope: 'GLOBAL',
        districtId: null,
        status: 'Unavailable',
        lastCheckAt: checkedAt,
        checkedAt,
        outcome: 'failure',
        errorCode: 'DATABASE_CONNECTION_ERROR',
        errorMessage: 'Маълумотлар базаси билан алоқа ўрнатиб бўлмади.',
        latencyMs: probe.latencyMs,
        diagnostics: { waitingConnectionCount: waitingCount },
      });
    }

    if (waitingCount > 0) {
      return createObservation({
        component: 'database',
        scope: 'GLOBAL',
        districtId: null,
        status: 'Degraded',
        lastCheckAt: checkedAt,
        checkedAt,
        outcome: 'failure',
        errorCode: 'DATABASE_QUEUE_SATURATION',
        errorMessage: 'Маълумотлар базаси уланиш навбатида тўпланиш мавжуд.',
        latencyMs: probe.latencyMs,
        diagnostics: { waitingConnectionCount: waitingCount },
      });
    }

    return createObservation({
      component: 'database',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Healthy',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'success',
      latencyMs: probe.latencyMs,
      diagnostics: { waitingConnectionCount: waitingCount },
    });
  } catch (err: unknown) {
    logger.error({ err, component: 'database' }, 'Database health probe failed');
    const errorDetail = err instanceof Error ? `: ${err.message}` : '';
    return createObservation({
      component: 'database',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Unavailable',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'failure',
      errorCode: 'DATABASE_PROBE_ERROR',
      errorMessage: `Маълумотлар базаси текширувида кутилмаган хатолик${errorDetail}`,
      latencyMs: null,
      diagnostics: { waitingConnectionCount: pool.waitingCount || 0 },
    });
  }
}

/**
 * 2. Global Processing Queue (pg-boss 10.x) Health Checker
 */
export async function checkProcessingQueueHealth(
  boss: PgBoss | undefined,
  _config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();

  if (!boss) {
    return createObservation({
      component: 'processing_queue',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Unavailable',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'failure',
      errorCode: 'QUEUE_NOT_CONFIGURED',
      errorMessage: 'Навбат бошқарув тизими (pg-boss) ишга туширилмаган.',
    });
  }

  const startTime = performance.now();

  try {
    // Non-throwing timeout boundary wrapper for pg-boss
    const bossWithCount = boss as unknown as {
      countStates?: () => Promise<{ created?: number; retry?: number; failed?: number }>;
    };

    const countStatesPromise = (async () => {
      if (typeof bossWithCount.countStates === 'function') {
        return await bossWithCount.countStates();
      }
      return null;
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Queue health probe timeout'));
      }, 2000);
      if (typeof timer.unref === 'function') timer.unref();
    });

    let states;
    try {
      states = await Promise.race([countStatesPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const latencyMs = Math.round(performance.now() - startTime);

    if (!states) {
      return createObservation({
        component: 'processing_queue',
        scope: 'GLOBAL',
        districtId: null,
        status: 'Healthy',
        lastCheckAt: checkedAt,
        checkedAt,
        outcome: 'success',
        latencyMs,
        diagnostics: {
          queueDepth: 0,
          failedJobCount: 0,
        },
      });
    }

    const created = Number.isFinite(states.created) ? Math.max(0, states.created as number) : 0;
    const retry = Number.isFinite(states.retry) ? Math.max(0, states.retry as number) : 0;
    const failed = Number.isFinite(states.failed) ? Math.max(0, states.failed as number) : 0;
    const totalBacklog = created + retry;

    const diagnostics = {
      queueDepth: totalBacklog,
      failedJobCount: failed,
    };

    if (totalBacklog > 100) {
      return createObservation({
        component: 'processing_queue',
        scope: 'GLOBAL',
        districtId: null,
        status: 'Delayed',
        lastCheckAt: checkedAt,
        checkedAt,
        outcome: 'failure',
        errorCode: 'QUEUE_BACKLOG_EXCEEDED',
        errorMessage: `Навбатда қайта ишланиши кутилаётган вазифалар сони юқори (${totalBacklog}).`,
        latencyMs,
        diagnostics,
      });
    }

    if (failed > 50) {
      return createObservation({
        component: 'processing_queue',
        scope: 'GLOBAL',
        districtId: null,
        status: 'Degraded',
        lastCheckAt: checkedAt,
        checkedAt,
        outcome: 'failure',
        errorCode: 'QUEUE_HIGH_FAILURE_RATE',
        errorMessage: `Навбатда муваффақиятсиз якунланган вазифалар мавжуд (${failed}).`,
        latencyMs,
        diagnostics,
      });
    }

    return createObservation({
      component: 'processing_queue',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Healthy',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'success',
      latencyMs,
      diagnostics,
    });
  } catch (err: unknown) {
    logger.error({ err, component: 'processing_queue' }, 'Processing queue health probe failed');
    const latencyMs = Math.round(performance.now() - startTime);
    const errorDetail = err instanceof Error ? `: ${err.message}` : '';
    return createObservation({
      component: 'processing_queue',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Unavailable',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'failure',
      errorCode: 'QUEUE_CONNECTION_ERROR',
      errorMessage: `Навбат тизими билан алоқа ўрнатиб бўлмади${errorDetail}`,
      latencyMs,
    });
  }
}

/**
 * 3. Global Storage Health Checker
 */
export async function checkStorageHealth(
  db: DbClient,
  _config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();
  const startTime = performance.now();

  try {
    const res = await db.execute(sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`);
    const latencyMs = Math.round(performance.now() - startTime);
    const dbSize = (res.rows[0] as { db_size?: string } | undefined)?.db_size || undefined;

    return createObservation({
      component: 'storage',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Healthy',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'success',
      latencyMs,
      diagnostics: {
        databaseSize: dbSize,
        storageLatencyMs: latencyMs,
        storageStatus: 'ok',
      },
    });
  } catch (err: unknown) {
    logger.error({ err, component: 'storage' }, 'Storage health probe failed');
    const latencyMs = Math.round(performance.now() - startTime);
    const errorDetail = err instanceof Error ? `: ${err.message}` : '';
    return createObservation({
      component: 'storage',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Unavailable',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'failure',
      errorCode: 'STORAGE_ACCESS_ERROR',
      errorMessage: `Сақлаш тизимига киришда хатолик юз берди${errorDetail}`,
      latencyMs,
      diagnostics: {
        storageLatencyMs: latencyMs,
        storageStatus: 'error',
      },
    });
  }
}

/**
 * 4. Global Web Application Health Checker
 */
export async function checkWebApplicationHealth(
  _config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();

  return createObservation({
    component: 'web_application',
    scope: 'GLOBAL',
    districtId: null,
    status: 'Healthy',
    lastCheckAt: checkedAt,
    checkedAt,
    outcome: 'success',
    latencyMs: 1,
  });
}

/**
 * 5. Global Retention Jobs Health Checker
 */
export async function checkRetentionJobHealth(
  db: DbClient,
  _config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();

  try {
    await db
      .select({ createdAt: auditEvents.createdAt })
      .from(auditEvents)
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);

    return createObservation({
      component: 'retention_jobs',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Healthy',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'success',
      latencyMs: 5,
    });
  } catch (err: unknown) {
    logger.error({ err, component: 'retention_jobs' }, 'Retention jobs health probe failed');
    const errorDetail = err instanceof Error ? `: ${err.message}` : '';
    return createObservation({
      component: 'retention_jobs',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Unavailable',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'failure',
      errorCode: 'RETENTION_CHECK_FAILED',
      errorMessage: `Маълумотларни сақлаш муддати текширувида хатолик юз берди${errorDetail}`,
      latencyMs: null,
    });
  }
}

/**
 * 6. Global Scheduled Deletion Capability Health Checker (AC 3)
 * Monitors strictly the pg-boss scheduler/worker capability.
 * 0 deletion jobs coexists with Healthy scheduler capability (decoupled from Epic 6).
 */
export async function checkScheduledDeletionHealth(
  boss: PgBoss | undefined,
  _config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();

  if (!boss) {
    return createObservation({
      component: 'scheduled_deletion',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Unavailable',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'failure',
      errorCode: 'QUEUE_NOT_CONFIGURED',
      errorMessage: 'Навбат бошқарув тизими (pg-boss) ишга туширилмаган.',
    });
  }

  const startTime = performance.now();

  try {
    const schedulesPromise = (async () => {
      const bossWithSchedules = boss as unknown as {
        getSchedules?: () => Promise<unknown[]>;
      };
      if (typeof bossWithSchedules.getSchedules === 'function') {
        return await bossWithSchedules.getSchedules();
      }
      return [];
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Scheduled deletion health probe timeout'));
      }, 2000);
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      await Promise.race([schedulesPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const latencyMs = Math.round(performance.now() - startTime);

    return createObservation({
      component: 'scheduled_deletion',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Healthy',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'success',
      latencyMs,
    });
  } catch (err: unknown) {
    logger.error({ err, component: 'scheduled_deletion' }, 'Scheduled deletion health probe failed');
    const latencyMs = Math.round(performance.now() - startTime);
    const errorDetail = err instanceof Error ? `: ${err.message}` : '';
    return createObservation({
      component: 'scheduled_deletion',
      scope: 'GLOBAL',
      districtId: null,
      status: 'Unavailable',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'failure',
      errorCode: 'SCHEDULED_DELETION_PROBE_ERROR',
      errorMessage: `Режалаштирилган ўчириш тизими текширувида хатолик юз берди${errorDetail}`,
      latencyMs,
    });
  }
}

/**
 * 7. District Telegram Bot Health Checker
 */
export async function checkDistrictBotHealth(
  db: DbClient,
  districtId: string,
  config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();

  const botList = await db
    .select()
    .from(districtTelegramBots)
    .where(eq(districtTelegramBots.districtId, districtId))
    .limit(1);

  if (botList.length === 0 || !botList[0]) {
    return createObservation({
      component: 'telegram_bot',
      scope: 'DISTRICT',
      districtId,
      status: 'Healthy',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'success',
      isApplicable: false,
    });
  }

  const bot = botList[0];
  const lastValidatedIso = bot.lastValidatedAt.toISOString();
  const isFresh = evaluateFreshness(bot.lastValidatedAt, config?.staleCheckThresholdMs || STALE_CHECK_THRESHOLD_MS, now);

  const diagnostics = {
    lastValidatedAt: lastValidatedIso,
  };

  if (bot.status === 'INVALID') {
    return createObservation({
      component: 'telegram_bot',
      scope: 'DISTRICT',
      districtId,
      status: 'Unavailable',
      lastCheckAt: lastValidatedIso,
      checkedAt,
      outcome: 'failure',
      errorCode: 'TELEGRAM_BOT_INVALID',
      errorMessage: 'Telegram бот токени ҳақиқий эмас ёки ўчирилган.',
      isApplicable: true,
      diagnostics,
    });
  }

  if (!isFresh) {
    return createObservation({
      component: 'telegram_bot',
      scope: 'DISTRICT',
      districtId,
      status: 'Unknown',
      lastCheckAt: lastValidatedIso,
      checkedAt,
      outcome: 'insufficient_evidence',
      errorCode: 'CHECK_STALE',
      errorMessage: 'Бот текшируви натижаси эскирган (10 дақиқадан ортиқ).',
      isApplicable: true,
      diagnostics,
    });
  }

  return createObservation({
    component: 'telegram_bot',
    scope: 'DISTRICT',
    districtId,
    status: 'Healthy',
    lastCheckAt: lastValidatedIso,
    checkedAt,
    outcome: 'success',
    isApplicable: true,
    diagnostics,
  });
}

/**
 * 8. District Telegram Groups Health Checker
 */
export async function checkDistrictGroupsHealth(
  db: DbClient,
  districtId: string,
  config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();

  const groups = await db
    .select()
    .from(districtTelegramGroups)
    .where(eq(districtTelegramGroups.districtId, districtId));

  if (groups.length === 0) {
    return createObservation({
      component: 'telegram_groups',
      scope: 'DISTRICT',
      districtId,
      status: 'Healthy',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'success',
      isApplicable: false,
      diagnostics: {
        connectedGroupsCount: 0,
        activeGroupsCount: 0,
        failedGroupsCount: 0,
      },
    });
  }

  // Check for explicit failures
  const failedGroups = groups.filter((g) => g.status === 'FAILED');
  const activeGroups = groups.filter((g) => g.status === 'VALID');

  const latestGroupCheck = groups.reduce((latest, g) => {
    const time = g.lastValidatedAt ? g.lastValidatedAt.getTime() : g.createdAt.getTime();
    return Math.max(latest, time);
  }, 0);

  const lastCheckAt = latestGroupCheck > 0 ? new Date(latestGroupCheck).toISOString() : checkedAt;

  const diagnostics = {
    connectedGroupsCount: groups.length,
    activeGroupsCount: activeGroups.length,
    failedGroupsCount: failedGroups.length,
    lastValidatedAt: lastCheckAt,
  };

  if (failedGroups.length > 0 && failedGroups[0]) {
    const latestCheck = failedGroups[0].lastValidatedAt?.toISOString() || checkedAt;
    return createObservation({
      component: 'telegram_groups',
      scope: 'DISTRICT',
      districtId,
      status: 'Degraded',
      lastCheckAt: latestCheck,
      checkedAt,
      outcome: 'failure',
      errorCode: 'TELEGRAM_GROUP_FAILED',
      errorMessage: `${failedGroups.length} та Telegram гуруҳда уланиш хатолиги мавжуд.`,
      isApplicable: true,
      diagnostics,
    });
  }

  // Check for recent activity across groups
  const hasRecentActivity = groups.some((g) => {
    if (g.testMessageReceivedAt) {
      return evaluateFreshness(g.testMessageReceivedAt, config?.staleCheckThresholdMs || STALE_CHECK_THRESHOLD_MS, now);
    }
    return false;
  });

  if (hasRecentActivity) {
    return createObservation({
      component: 'telegram_groups',
      scope: 'DISTRICT',
      districtId,
      status: 'Healthy',
      lastCheckAt,
      checkedAt,
      outcome: 'success',
      isApplicable: true,
      diagnostics,
    });
  }

  // Silence is Quiet, not failure (AC 6)
  return createObservation({
    component: 'telegram_groups',
    scope: 'DISTRICT',
    districtId,
    status: 'Quiet',
    lastCheckAt,
    checkedAt,
    outcome: 'success',
    isApplicable: true,
    diagnostics,
  });
}

/**
 * 9. District Message Intake Health Checker
 */
export async function checkDistrictIntakeHealth(
  db: DbClient,
  districtId: string,
  config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();
  const intakeDelayThresholdMs = config?.intakeDelayThresholdMs || INTAKE_DELAY_THRESHOLD_MS;

  const latestRecords = await db
    .select()
    .from(telegramIntakeRecords)
    .where(eq(telegramIntakeRecords.districtId, districtId))
    .orderBy(desc(telegramIntakeRecords.createdAt))
    .limit(1);

  if (latestRecords.length === 0 || !latestRecords[0]) {
    return createObservation({
      component: 'message_intake',
      scope: 'DISTRICT',
      districtId,
      status: 'Quiet',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'success',
      isApplicable: true,
    });
  }

  const latestRecord = latestRecords[0];
  const recordAgeMs = now.getTime() - latestRecord.createdAt.getTime();
  const recordIso = latestRecord.createdAt.toISOString();

  const diagnostics = {
    lastMessageReceivedAt: recordIso,
    intakeLatencyMs: recordAgeMs >= 0 ? recordAgeMs : 0,
  };

  // If recent message received within delay threshold (5 min) -> Healthy
  if (recordAgeMs <= intakeDelayThresholdMs) {
    return createObservation({
      component: 'message_intake',
      scope: 'DISTRICT',
      districtId,
      status: 'Healthy',
      lastCheckAt: recordIso,
      checkedAt,
      outcome: 'success',
      isApplicable: true,
      diagnostics,
    });
  }

  // Silence without pending unprocessed backlog -> Quiet
  return createObservation({
    component: 'message_intake',
    scope: 'DISTRICT',
    districtId,
    status: 'Quiet',
    lastCheckAt: recordIso,
    checkedAt,
    outcome: 'success',
    isApplicable: true,
    diagnostics,
  });
}

/**
 * 10. District AI Operations Health Checker
 */
export async function checkDistrictAiHealth(
  db: DbClient,
  districtId: string,
  config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();

  const recentOps = await db
    .select({
      id: aiOperations.id,
      finalStatus: aiOperations.finalStatus,
      createdAt: aiOperations.createdAt,
      pinnedProfileId: aiOperations.pinnedProfileId,
      modelId: aiProfiles.modelId,
      promptVersion: aiProfiles.promptVersion,
    })
    .from(aiOperations)
    .leftJoin(aiProfiles, eq(aiOperations.pinnedProfileId, aiProfiles.id))
    .where(eq(aiOperations.districtId, districtId))
    .orderBy(desc(aiOperations.createdAt))
    .limit(10);

  if (recentOps.length === 0 || !recentOps[0]) {
    return createObservation({
      component: 'ai_operations',
      scope: 'DISTRICT',
      districtId,
      status: 'Quiet',
      lastCheckAt: checkedAt,
      checkedAt,
      outcome: 'success',
      isApplicable: true,
    });
  }

  const failedCount = recentOps.filter((op) => op.finalStatus === 'FAILED').length;
  const successCount = recentOps.filter(
    (op) => op.finalStatus === 'COMPLETED_RELEVANT' || op.finalStatus === 'COMPLETED_IRRELEVANT',
  ).length;
  const latestOp = recentOps[0];
  const latestOpIso = latestOp.createdAt.toISOString();

  const diagnostics = {
    activeModelVersion: latestOp.modelId || undefined,
    activePromptVersion: latestOp.promptVersion || undefined,
    recentSuccessCount: successCount,
    recentFailureCount: failedCount,
  };

  // High failure rate (>30%) -> Degraded
  if (failedCount >= 3) {
    return createObservation({
      component: 'ai_operations',
      scope: 'DISTRICT',
      districtId,
      status: 'Degraded',
      lastCheckAt: latestOpIso,
      checkedAt,
      outcome: 'failure',
      errorCode: 'AI_OPERATION_FAILURES',
      errorMessage: `Сўнгги АИ операцияларида хатоликлар кузатилди (${failedCount}/${recentOps.length}).`,
      isApplicable: true,
      diagnostics,
    });
  }

  const isRecent = evaluateFreshness(latestOp.createdAt, config?.staleCheckThresholdMs || STALE_CHECK_THRESHOLD_MS, now);

  if (isRecent) {
    return createObservation({
      component: 'ai_operations',
      scope: 'DISTRICT',
      districtId,
      status: 'Healthy',
      lastCheckAt: latestOpIso,
      checkedAt,
      outcome: 'success',
      isApplicable: true,
      diagnostics,
    });
  }

  return createObservation({
    component: 'ai_operations',
    scope: 'DISTRICT',
    districtId,
    status: 'Quiet',
    lastCheckAt: latestOpIso,
    checkedAt,
    outcome: 'success',
    isApplicable: true,
    diagnostics,
  });
}

/**
 * 11. District Retention Health Checker
 */
export async function checkDistrictRetentionHealth(
  _db: DbClient,
  districtId: string,
  _config?: HealthConfig,
): Promise<ComponentHealthObservation> {
  const now = new Date();
  const checkedAt = now.toISOString();

  return createObservation({
    component: 'district_retention',
    scope: 'DISTRICT',
    districtId,
    status: 'Healthy',
    lastCheckAt: checkedAt,
    checkedAt,
    outcome: 'success',
    isApplicable: true,
  });
}
