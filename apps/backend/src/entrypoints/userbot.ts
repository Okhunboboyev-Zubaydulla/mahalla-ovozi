import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { createDbPool, createDbClient, type DbClient } from '../adapters/db/client.js';
import { createBossClient, initBossQueues } from '../adapters/jobs/boss-client.js';
import { UserbotConnectionManager } from '../modules/userbot/userbot-connection-manager.js';
import type { UserbotClientFactory } from '../modules/userbot/userbot-client-port.js';
import {
  assertUserbotRuntimeComposition,
  describeUserbotRuntimeComposition,
} from '../modules/userbot/userbot-runtime-composition.js';
import { assertEncryptionKeyConfigured } from '../adapters/crypto/token-cipher.js';
import { logger } from '../utils/logger.js';

let activeManagerInstance: UserbotConnectionManager | null = null;
let internalPool: pg.Pool | null = null;
let internalBoss: PgBoss | null = null;

/**
 * A composition failure that reaches the message handler means the process is up but cannot
 * ingest, so it must not keep running and silently discarding what it receives. The escalation is
 * loud and terminal.
 */
function escalateFatalRuntimeError(err: unknown): void {
  logger.error({ err }, 'Fatal userbot runtime error; terminating process');
  process.exit(1);
}

export interface StartUserbotServiceOptions {
  db?: DbClient;
  pool?: pg.Pool;
  boss?: PgBoss;
  clientFactory?: UserbotClientFactory;
  lastSeenIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  pollIntervalMs?: number;
}

/**
 * Starts the standalone MTProto Userbot service.
 *
 * The runtime composes both of its outbound dependencies through the same factories the HTTP
 * and worker entrypoints use, so the three entrypoints compose their dependencies
 * symmetrically. A missing pool or job-queue client is a fatal startup error, never a
 * per-message warning. The manager also receives the process-fatal escalation hook, so a
 * composition failure that only becomes visible while messages are arriving terminates the
 * process instead of being absorbed into a per-message log line.
 */
export async function startUserbotService(
  options?: StartUserbotServiceOptions,
): Promise<UserbotConnectionManager> {
  assertEncryptionKeyConfigured();

  let pool = options?.pool;
  if (!pool) {
    pool = createDbPool();
    internalPool = pool;
  }

  let boss = options?.boss;
  if (!boss) {
    boss = createBossClient();
    internalBoss = boss;
    await boss.start();
    await initBossQueues(boss);
  }

  const db = options?.db ?? createDbClient(pool);

  // Fail fast and loudly before any client is constructed or connected.
  assertUserbotRuntimeComposition({ pool, boss });

  const composition = describeUserbotRuntimeComposition({ pool, boss });
  logger.info(
    {
      hasDatabasePool: composition.hasPool,
      hasJobQueueClient: composition.hasJobQueueClient,
    },
    'Userbot runtime composition resolved',
  );

  const manager = new UserbotConnectionManager({
    db,
    pool,
    boss,
    onFatalRuntimeError: escalateFatalRuntimeError,
    clientFactory: options?.clientFactory,
    lastSeenIntervalMs: options?.lastSeenIntervalMs,
    reconnectBaseDelayMs: options?.reconnectBaseDelayMs,
    reconnectMaxDelayMs: options?.reconnectMaxDelayMs,
    pollIntervalMs: options?.pollIntervalMs,
  });

  activeManagerInstance = manager;

  await manager.start();
  logger.info('Mahalla Ovozi userbot service started successfully');
  return manager;
}

/**
 * Stops the standalone MTProto Userbot service gracefully, releasing both the queue client and
 * the pool so a redeploy never leaves a half-closed connection behind.
 */
export async function stopUserbotService(
  managerInstance?: UserbotConnectionManager,
): Promise<void> {
  const manager = managerInstance || activeManagerInstance;
  if (manager) {
    logger.info('Stopping userbot service gracefully...');
    await manager.stop();
    if (activeManagerInstance === manager) {
      activeManagerInstance = null;
    }
  }

  if (internalBoss) {
    await internalBoss.stop({ graceful: true, timeout: 30000 });
    internalBoss = null;
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
  startUserbotService().catch((err) => {
    logger.error({ err }, 'Failed to start userbot service');
    process.exit(1);
  });

  let isShuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, initiating graceful userbot shutdown...`);
    await stopUserbotService();
    process.exit(0);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}
