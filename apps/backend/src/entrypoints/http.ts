import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyCompress from '@fastify/compress';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { serializeApiError, serializeNotFoundError } from '../modules/errors/api-error-envelope.js';
import { createDbPool, createDbClient, DbClient } from '../adapters/db/client.js';
import { registerAuthRoutes } from '../modules/auth/auth-routes.js';
import { registerDistrictRoutes } from '../modules/districts/districts-routes.js';
import { registerTelegramBotRoutes } from '../modules/telegram-bot/telegram-bot-routes.js';
import { registerTelegramGroupRoutes } from '../modules/telegram-groups/telegram-groups-routes.js';
import { registerHokimAccountRoutes } from '../modules/hokim-accounts/hokim-accounts-routes.js';
import { registerTelegramIntakeRoutes } from '../modules/telegram-intake/telegram-intake-routes.js';
import { registerAiOperationsRoutes } from '../modules/ai/ai-operations-routes.js';
import { registerHokimTopicsRoutes } from '../modules/topics/hokim-topics-routes.js';
import { registerHealthRoutes } from '../modules/health/health-routes.js';
import { registerIssueRoutes } from '../modules/issues/issue-routes.js';
import { registerAuditRoutes } from '../modules/audit/audit-routes.js';
import { registerDistrictTopicsRoutes } from '../modules/topics/district-topics-routes.js';
import { registerAdminSignalsRoutes } from '../modules/topics/admin-signals-routes.js';
import { registerDistrictAnalysisSettingsRoutes } from '../modules/ai/district-analysis-settings-routes.js';
import { registerSubscriptionRoutes } from '../modules/subscriptions/subscriptions-routes.js';
import { registerUserbotSessionRoutes } from '../modules/userbot-session/userbot-session-routes.js';
import type { BackupRetentionVerifier } from '../modules/subscriptions/ports/backup-retention-verifier.js';
import type { ExternalTombstoneStore } from '../adapters/storage/external-tombstone-store.js';
import { createBossClient, initBossQueues } from '../adapters/jobs/boss-client.js';
import type PgBoss from 'pg-boss';
import pg from 'pg';

// Plain HTTP error with statusCode + code fields — Fastify's error handler maps these correctly.
class ForbiddenOriginError extends Error {
  statusCode = 403;
  code = 'FORBIDDEN_ORIGIN';
  constructor() { super('Ноқонуний сўров манбаи.'); }
}

export interface HttpServerContext {
  db: DbClient;
  pool: pg.Pool;
  boss: PgBoss;
  backupVerifier?: BackupRetentionVerifier;
  tombstoneStore?: ExternalTombstoneStore;
}

/**
 * Registers all domain route plugins into the Fastify HTTP server.
 */
export function registerAllDomainRoutes(
  server: FastifyInstance,
  ctx: HttpServerContext,
): void {
  registerAuthRoutes(server, ctx.db);
  registerDistrictRoutes(server, ctx.db);
  registerTelegramBotRoutes(server, ctx.db);
  registerTelegramGroupRoutes(server, ctx.db);
  registerHokimAccountRoutes(server, ctx.db);
  registerTelegramIntakeRoutes(server, { pool: ctx.pool, boss: ctx.boss, db: ctx.db });
  registerAiOperationsRoutes(server, { db: ctx.db, pool: ctx.pool, boss: ctx.boss });
  registerHokimTopicsRoutes(server, ctx.db);
  registerHealthRoutes(server, {
    db: ctx.db,
    pool: ctx.pool,
    boss: ctx.boss,
    tombstoneStore: ctx.tombstoneStore,
  });
  registerIssueRoutes(server, { db: ctx.db, pool: ctx.pool, boss: ctx.boss });
  registerAuditRoutes(server, ctx.db);
  registerDistrictTopicsRoutes(server, ctx.db);
  registerAdminSignalsRoutes(server, { db: ctx.db, pool: ctx.pool, boss: ctx.boss });
  registerDistrictAnalysisSettingsRoutes(server, ctx.db);
  registerSubscriptionRoutes(server, {
    db: ctx.db,
    pool: ctx.pool,
    boss: ctx.boss,
    backupVerifier: ctx.backupVerifier,
    tombstoneStore: ctx.tombstoneStore,
  });
  registerUserbotSessionRoutes(server, ctx.db);
}

export async function buildHttpServer(options?: {
  db?: DbClient;
  pool?: pg.Pool;
  boss?: PgBoss;
  backupVerifier?: BackupRetentionVerifier;
  tombstoneStore?: ExternalTombstoneStore;
}): Promise<FastifyInstance> {
  const server = Fastify({
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : {
            level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
          },
    trustProxy: true,
  });

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  // Fastify 5 V8 monomorphic shape optimization: decorate request prototype
  server.decorateRequest('actor', undefined);

  // Robust JSON parser that handles empty bodies gracefully
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || (typeof body === 'string' && body.trim() === '')) {
      done(null, {});
      return;
    }
    try {
      const json = JSON.parse(body.toString());
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Register cookie support
  await server.register(fastifyCookie);

  // Register response compression (brotli/gzip/deflate for payloads >= 1KB) (M-1)
  await server.register(fastifyCompress, {
    global: true,
    threshold: 1024,
  });

  // B11: Restrict CORS to explicitly configured APP_ORIGIN, not all origins.
  // Allowing all origins with credentials: true leaks session info to any site.
  const rawAllowedOrigin = process.env.APP_ORIGIN || 'http://localhost:5173';
  const allowedOrigins = rawAllowedOrigin.split(',').map((o) => o.trim()).filter(Boolean);
  await server.register(fastifyCors, {
    origin: (origin, cb) => {
      // Allow same-origin requests (no Origin header) and configured origin(s)
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
      } else {
        // Use a typed HTTP error so the error handler returns 403, not 500
        cb(new ForbiddenOriginError(), false);
      }
    },
    credentials: true,
  });

  // B8: Sanitized global error handler — logs the full error for observability,
  // then returns a safe generic response to the client (no stack traces exposed).
  server.setErrorHandler((error: unknown, request, reply) => {
    // Log the actual error for debugging via structured Pino logger — never expose it to the client
    request.log.error(
      {
        err: error,
        reqId: request.id,
        method: request.method,
        url: request.url,
      },
      'Unhandled request error',
    );

    // Single producer-side gate for the shared ApiErrorEnvelope contract.
    // Every thrown value is normalised and validated against the schema here, so the
    // browser's api-client.ts:68 parse cannot fail on a malformed envelope.
    const serialized = serializeApiError(error);
    reply.status(serialized.statusCode).send(serialized.body);
  });

  server.setNotFoundHandler((_request, reply) => {
    const serialized = serializeNotFoundError();
    reply.status(serialized.statusCode).send(serialized.body);
  });

  const pool = options?.pool || createDbPool();
  const db = options?.db || createDbClient(pool);
  const boss = options?.boss || createBossClient();

  // Ensure pg-boss queues are bootstrapped
  await boss.start();
  await initBossQueues(boss);

  // Teardown hook for Fastify graceful close
  server.addHook('onClose', async () => {
    await boss.stop({ graceful: true, timeout: 5000 }).catch(() => {});
  });

  // Register domain module routes via unified context
  const context: HttpServerContext = {
    db,
    pool,
    boss,
    backupVerifier: options?.backupVerifier,
    tombstoneStore: options?.tombstoneStore,
  };
  registerAllDomainRoutes(server, context);

  return server;
}

let activeServer: FastifyInstance | null = null;
let activePool: pg.Pool | null = null;

export async function stopHttpServer(serverInstance?: FastifyInstance): Promise<void> {
  const server = serverInstance || activeServer;
  if (server) {
    console.log('[http] Closing HTTP server gracefully...');
    await server.close();
    console.log('[http] HTTP server closed.');
    if (activeServer === server) {
      activeServer = null;
    }
  }

  if (activePool) {
    await activePool.end();
    activePool = null;
  }
}

export async function startServer() {
  const pool = createDbPool();
  const db = createDbClient(pool);
  activePool = pool;
  const server = await buildHttpServer({ db, pool });
  activeServer = server;
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    const address = await server.listen({ port, host });
    console.log('[http] Mahalla Ovozi backend listening', { address });
  } catch (err) {
    console.error('[http] Failed to start server:', err);
    process.exit(1);
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  startServer().catch((err) => {
    console.error('[http] Failed to start server:', err);
    process.exit(1);
  });

  let isShuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[http] Received ${signal}, initiating graceful shutdown...`);
    await stopHttpServer();
    process.exit(0);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}
