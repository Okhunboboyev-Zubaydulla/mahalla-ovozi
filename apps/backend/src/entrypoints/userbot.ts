import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';
import { createDbPool, createDbClient, type DbClient } from '../adapters/db/client.js';
import { UserbotConnectionManager } from '../modules/userbot/userbot-connection-manager.js';
import type { UserbotClientFactory } from '../modules/userbot/userbot-client-port.js';
import { logger } from '../utils/logger.js';

import type PgBoss from 'pg-boss';

let activeManagerInstance: UserbotConnectionManager | null = null;
let internalPool: pg.Pool | null = null;

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
 */
export async function startUserbotService(
  options?: StartUserbotServiceOptions,
): Promise<UserbotConnectionManager> {
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

  const manager = new UserbotConnectionManager({
    db,
    pool,
    boss: options?.boss,
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
 * Stops the standalone MTProto Userbot service gracefully.
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
