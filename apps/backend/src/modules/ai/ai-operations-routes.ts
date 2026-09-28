import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import {
  ListAiOperationsQuerySchema,
  ListGlobalAiOperationsQuerySchema,
  GetAiHealthMetricsQuerySchema,
} from '@mahalla-ovozi/api-contracts';
import type { DbClient } from '../../adapters/db/client.js';
import {
  createRequireProductOwner,
  createRequireDistrictAccess,
} from '../auth/require-auth.js';
import {
  aiOperationQueryService,
  InvalidDistrictScopeError,
  OperationNotFoundError,
  PrivacyBoundaryViolationError,
} from './ai-operation-query-service.js';

export interface AiOperationsRouteDeps {
  db: DbClient;
  pool?: pg.Pool;
  boss?: PgBoss;
}

function handleAiOperationError(err: unknown, reply: FastifyReply, req?: FastifyRequest) {
  if (err instanceof InvalidDistrictScopeError) {
    return reply.status(400).send({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }
  if (err instanceof OperationNotFoundError) {
    return reply.status(404).send({
      error: {
        code: (err as any).code || 'NOT_FOUND',
        message: err.message,
      },
    });
  }
  if (err instanceof PrivacyBoundaryViolationError) {
    req?.log?.error({ err }, 'Privacy boundary violation detected');
    return reply.status(500).send({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  req?.log?.error({ err }, 'Unhandled AI operations error');
  return reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Серверда кутилмаган хатолик юз берди.',
    },
  });
}

export function registerAiOperationsRoutes(
  fastify: FastifyInstance,
  depsOrDb: AiOperationsRouteDeps | DbClient,
): void {
  const db = 'db' in depsOrDb ? depsOrDb.db : depsOrDb;

  // 1. District-scoped routes
  fastify.register(async (scope) => {
    scope.addHook('preHandler', createRequireDistrictAccess(db));

    // GET /api/v1/districts/:districtId/ai-operations
    scope.get(
      '/api/v1/districts/:districtId/ai-operations',
      async (
        req: FastifyRequest<{
          Params: { districtId: string };
          Querystring: Record<string, unknown>;
        }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: {
              code: 'INVALID_DISTRICT_SCOPE',
              message: 'Туман идентификатори талаб қилинади ва бўш бўлмаслиги керак.',
            },
          });
        }

        const parseResult = ListAiOperationsQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Қидирув параметрлари нотўғри.',
            },
          });
        }

        const query = parseResult.data;
        try {
          const result = await aiOperationQueryService.listDistrictOperations(db, districtId, {
            mahallaName: query.mahallaName,
            calendarDay: query.calendarDay,
            operationType: query.operationType,
            finalStatus: query.finalStatus,
            targetId: query.targetId,
            startDate: query.startDate ? new Date(query.startDate) : undefined,
            endDate: query.endDate ? new Date(query.endDate) : undefined,
            cursor: query.cursor,
            limit: query.limit,
            direction: query.direction,
          });

          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleAiOperationError(err, reply, req);
        }
      },
    );

    // GET /api/v1/districts/:districtId/ai-operations/:operationId
    scope.get(
      '/api/v1/districts/:districtId/ai-operations/:operationId',
      async (
        req: FastifyRequest<{
          Params: { districtId: string; operationId: string };
        }>,
        reply: FastifyReply,
      ) => {
        const { districtId, operationId } = req.params;
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: {
              code: 'INVALID_DISTRICT_SCOPE',
              message: 'Туман идентификатори талаб қилинади ва бўш бўлмаслиги керак.',
            },
          });
        }
        if (!operationId || typeof operationId !== 'string' || operationId.trim() === '') {
          return reply.status(404).send({
            error: {
              code: 'OPERATION_NOT_FOUND',
              message: 'AI амалиёти топилмади.',
            },
          });
        }

        try {
          const details = await aiOperationQueryService.getDistrictOperationDetails(
            db,
            districtId,
            operationId,
          );
          return reply.status(200).send({ operation: details });
        } catch (err: unknown) {
          return handleAiOperationError(err, reply, req);
        }
      },
    );
  });

  // 2. Global admin routes (Product Owner only)
  fastify.register(async (scope) => {
    scope.addHook('preHandler', createRequireProductOwner(db));

    // GET /api/v1/admin/ai-operations
    scope.get(
      '/api/v1/admin/ai-operations',
      async (
        req: FastifyRequest<{ Querystring: Record<string, unknown> }>,
        reply: FastifyReply,
      ) => {
        const parseResult = ListGlobalAiOperationsQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Қидирув параметрлари нотўғри.',
            },
          });
        }

        const query = parseResult.data;
        try {
          const result = await aiOperationQueryService.listGlobalOperations(db, {
            districtId: query.districtId,
            mahallaName: query.mahallaName,
            calendarDay: query.calendarDay,
            operationType: query.operationType,
            finalStatus: query.finalStatus,
            targetId: query.targetId,
            startDate: query.startDate ? new Date(query.startDate) : undefined,
            endDate: query.endDate ? new Date(query.endDate) : undefined,
            cursor: query.cursor,
            limit: query.limit,
            direction: query.direction,
          });

          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleAiOperationError(err, reply, req);
        }
      },
    );

    // GET /api/v1/admin/ai-operations/health-metrics
    scope.get(
      '/api/v1/admin/ai-operations/health-metrics',
      async (
        req: FastifyRequest<{ Querystring: Record<string, unknown> }>,
        reply: FastifyReply,
      ) => {
        const parseResult = GetAiHealthMetricsQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Қидирув параметрлари нотўғри.',
            },
          });
        }

        const query = parseResult.data;
        try {
          const metrics = await aiOperationQueryService.getSystemHealthAiMetrics(db, {
            districtId: query.districtId,
            timeframe:
              query.from || query.to
                ? {
                    from: query.from ? new Date(query.from) : undefined,
                    to: query.to ? new Date(query.to) : undefined,
                  }
                : undefined,
          });

          return reply.status(200).send({ metrics });
        } catch (err: unknown) {
          return handleAiOperationError(err, reply, req);
        }
      },
    );

    // GET /api/v1/admin/ai-operations/:operationId
    scope.get(
      '/api/v1/admin/ai-operations/:operationId',
      async (
        req: FastifyRequest<{ Params: { operationId: string } }>,
        reply: FastifyReply,
      ) => {
        const { operationId } = req.params;
        if (!operationId || typeof operationId !== 'string' || operationId.trim() === '') {
          return reply.status(404).send({
            error: {
              code: 'OPERATION_NOT_FOUND',
              message: 'AI амалиёти топилмади.',
            },
          });
        }

        try {
          const details = await aiOperationQueryService.getGlobalOperationDetails(
            db,
            operationId,
          );
          return reply.status(200).send({ operation: details });
        } catch (err: unknown) {
          return handleAiOperationError(err, reply, req);
        }
      },
    );
  });
}
