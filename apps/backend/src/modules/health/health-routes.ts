import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import {
  LivenessProbeResponseSchema,
  ReadinessProbeResponseSchema,
  PublicHealthSummaryResponseSchema,
  OverallSystemHealthResponseSchema,
  DistrictHealthResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { DbClient, checkDbHealth } from '../../adapters/db/client.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import { healthService, DistrictNotFoundError } from './health-service.js';
import { HealthConfig } from './health-checker.js';

import { eq, and, or, inArray, sql } from 'drizzle-orm';
import {
  districts,
  districtDeletionRecords,
  operationalIssues,
} from '../../adapters/db/schema/index.js';
import type { ExternalTombstoneStore } from '../subscriptions/ports/external-tombstone-store.port.js';
import { TombstoneStoreCorruptedError } from '../subscriptions/ports/external-tombstone-store.port.js';
import { FileExternalTombstoneStore } from '../../adapters/storage/external-tombstone-store.js';

const DistrictHealthParamsSchema = z.object({
  districtId: z.string().min(1, 'Туман ID киритилиши шарт.'),
});

async function checkBossLiveness(boss?: PgBoss): Promise<boolean> {
  if (!boss) return false;
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Queue probe timeout')), 2000);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const schedulesPromise = (async () => {
      const bossWithSchedules = boss as unknown as { getSchedules?: () => Promise<unknown[]> };
      if (typeof bossWithSchedules.getSchedules === 'function') {
        return await bossWithSchedules.getSchedules();
      }
      return [];
    })();
    try {
      await Promise.race([schedulesPromise, timeoutPromise]);
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function checkRestoreReconciliationHealth(
  db: DbClient,
  tombstoneStore?: ExternalTombstoneStore,
): Promise<'ok' | 'down' | 'unreconciled'> {
  try {
    // 1. Check if an active disaster_restore_reconciliation_failure issue exists in DB
    const [activeIssue] = await db
      .select({ id: operationalIssues.id })
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.logicalKey, 'disaster_restore_reconciliation_failure'),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      )
      .limit(1);

    if (activeIssue) {
      return 'down';
    }

    // 2. Load tombstones from external store
    const store = tombstoneStore || new FileExternalTombstoneStore();
    const extTombstones = await store.loadAllTombstones();

    if (extTombstones.length > 0) {
      const extDistrictIds = extTombstones.map((t) => t.districtId);

      // Check if any deleted district from external tombstone store exists in districts table (resurrected!)
      const resurrected = await db
        .select({ id: districts.id })
        .from(districts)
        .where(inArray(districts.id, extDistrictIds))
        .limit(1);

      if (resurrected.length > 0) {
        return 'unreconciled';
      }
    }

    // 3. Check if any tombstone in DB has unreconciled status (PENDING, FAILED, or null)
    const [unreconciledDbRow] = await db
      .select({ id: districtDeletionRecords.id })
      .from(districtDeletionRecords)
      .where(
        or(
          eq(districtDeletionRecords.restoreReconciliationStatus, 'PENDING'),
          eq(districtDeletionRecords.restoreReconciliationStatus, 'FAILED'),
          sql`${districtDeletionRecords.restoreReconciliationStatus} IS NULL`,
        ),
      )
      .limit(1);

    if (unreconciledDbRow) {
      return 'unreconciled';
    }

    return 'ok';
  } catch (err) {
    if (err instanceof TombstoneStoreCorruptedError) {
      return 'down';
    }
    return 'down';
  }
}

export function registerHealthRoutes(
  server: FastifyInstance,
  deps: {
    db: DbClient;
    pool: pg.Pool;
    boss?: PgBoss;
    config?: HealthConfig;
    tombstoneStore?: ExternalTombstoneStore;
  },
): void {
  /**
   * 1. Public Unauthenticated Probes (AC 4, AC 10)
   * Registered directly on server to bypass Product Owner auth & origin checks.
   */

  /**
   * GET /api/v1/health/live
   * Fast process liveness probe for container orchestrators.
   */
  server.get(
    '/api/v1/health/live',
    {
      schema: {
        response: {
          200: LivenessProbeResponseSchema,
        },
      },
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).send({
        status: 'ok',
        timestamp: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /api/v1/health/ready
   * Deep dependency readiness probe for DB pool, pg-boss queue capability, and restore reconciliation.
   */
  server.get(
    '/api/v1/health/ready',
    {
      schema: {
        response: {
          200: ReadinessProbeResponseSchema,
          503: ReadinessProbeResponseSchema,
        },
      },
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const nowIso = new Date().toISOString();
      const dbProbe = await checkDbHealth(deps.pool, 2000);
      const isDbOk = dbProbe.isHealthy;
      const isQueueOk = await checkBossLiveness(deps.boss);

      let restoreStatus: 'ok' | 'down' | 'unreconciled' = 'ok';
      if (isDbOk) {
        restoreStatus = await checkRestoreReconciliationHealth(deps.db, deps.tombstoneStore);
      } else {
        restoreStatus = 'down';
      }

      const isReady = isDbOk && isQueueOk && restoreStatus === 'ok';
      const statusCode = isReady ? 200 : 503;

      if (!isReady) {
        reply.header('Retry-After', '5');
        reply.header('Cache-Control', 'no-store');
      }

      return reply.status(statusCode).send({
        status: isReady ? 'ready' : 'unready',
        timestamp: nowIso,
        checks: {
          database: isDbOk ? 'ok' : 'down',
          queue: isQueueOk ? 'ok' : 'down',
          restoreReconciliation: restoreStatus,
        },
      });
    },
  );

  /**
   * GET /api/v1/health
   * High-level service health summary for external proxies and orchestrators.
   */
  server.get(
    '/api/v1/health',
    {
      schema: {
        response: {
          200: PublicHealthSummaryResponseSchema,
          503: PublicHealthSummaryResponseSchema,
        },
      },
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const nowIso = new Date().toISOString();
      const dbProbe = await checkDbHealth(deps.pool, 2000);
      const isQueueOk = await checkBossLiveness(deps.boss);
      const isHealthy = dbProbe.isHealthy && isQueueOk;

      if (!isHealthy) {
        return reply.status(503).send({
          status: 'Unavailable',
          timestamp: nowIso,
          version: '1.0.0',
        });
      }

      return reply.status(200).send({
        status: 'Healthy',
        timestamp: nowIso,
        version: '1.0.0',
      });
    },
  );

  // Encapsulated Fastify plugin scope with Product Owner auth & origin guard
  server.register(async (scope) => {
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireProductOwner(deps.db));

    /**
     * GET /api/v1/health/system
     * Overall system health and all-district summaries for Product Owner.
     */
    scope.get(
      '/api/v1/health/system',
      {
        schema: {
          response: {
            200: OverallSystemHealthResponseSchema,
          },
        },
      },
      async (_req: FastifyRequest, reply: FastifyReply) => {
        const result = await healthService.getOverallSystemHealth(
          deps.db,
          deps.pool,
          deps.boss,
          deps.config,
        );
        return reply.status(200).send(result);
      },
    );

    /**
     * GET /api/v1/districts/:districtId/health
     * District-scoped health observation for Product Owner.
     */
    scope.get(
      '/api/v1/districts/:districtId/health',
      {
        schema: {
          response: {
            200: DistrictHealthResponseSchema,
          },
        },
      },
      async (
        req: FastifyRequest<{ Params: { districtId: string } }>,
        reply: FastifyReply,
      ) => {
        const parseResult = DistrictHealthParamsSchema.safeParse(req.params);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.issues[0]?.message || 'Нотўғри туман ID кўрсатилди.',
              statusCode: 400,
            },
          });
        }

        try {
          const result = await healthService.getDistrictHealth(
            deps.db,
            parseResult.data.districtId,
            deps.pool,
            deps.boss,
            deps.config,
          );
          return reply.status(200).send(result);
        } catch (err) {
          if (err instanceof DistrictNotFoundError) {
            return reply.status(404).send({
              error: {
                code: 'NOT_FOUND',
                message: err.message,
                statusCode: 404,
              },
            });
          }
          throw err;
        }
      },
    );
  });
}
