import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import {
  OperationalIssuesQuerySchema,
  OperationalIssuesQuery,
  RetryOperationRequestSchema,
  RetryOperationRequest,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import {
  issueService,
  OperationalIssueNotFoundError,
} from './issue-service.js';
import {
  retryService,
  DuplicateRetryInProgressError,
  OperationIneligibleError,
} from './retry-service.js';
import { createBossClient } from '../../adapters/jobs/boss-client.js';

const DistrictIssueParamsSchema = z.object({
  districtId: z.string().min(1, 'Туман ID киритилиши шарт.'),
});

const IssueDetailParamsSchema = z.object({
  issueId: z.string().min(1, 'Муаммо ID киритилиши шарт.'),
});

const RetryIssueBodySchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .optional();

export function registerIssueRoutes(
  server: FastifyInstance,
  deps: {
    db: DbClient;
    pool: pg.Pool;
    boss?: PgBoss;
  },
): void {
  // Encapsulated Fastify plugin scope with Product Owner auth & origin guard (Story 4.2 AC 1, AC 5)
  server.register(async (scope) => {
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireProductOwner(deps.db));

    /**
     * GET /api/v1/issues
     * Returns list of operational issues with optional filters for Product Owner.
     */
    scope.get(
      '/api/v1/issues',
      async (
        req: FastifyRequest<{ Querystring: OperationalIssuesQuery }>,
        reply: FastifyReply,
      ) => {
        const parseResult = OperationalIssuesQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                parseResult.error.issues[0]?.message ||
                'Нотўғри қидирув параметрлари киритилди.',
              statusCode: 400,
            },
          });
        }

        const result = await issueService.getOperationalIssues(
          deps.db,
          parseResult.data,
        );
        return reply.status(200).send(result);
      },
    );

    /**
     * GET /api/v1/issues/:issueId
     * Returns operational issue detail and audit timeline for Product Owner.
     */
    scope.get(
      '/api/v1/issues/:issueId',
      async (
        req: FastifyRequest<{ Params: { issueId: string } }>,
        reply: FastifyReply,
      ) => {
        const paramResult = IssueDetailParamsSchema.safeParse(req.params);
        if (!paramResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                paramResult.error.issues[0]?.message ||
                'Муаммо ID нотўғри кўрсатилди.',
              statusCode: 400,
            },
          });
        }

        try {
          const result = await issueService.getOperationalIssueDetail(
            deps.db,
            paramResult.data.issueId,
          );
          return reply.status(200).send(result);
        } catch (err) {
          if (err instanceof OperationalIssueNotFoundError) {
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

    /**
     * GET /api/v1/districts/:districtId/issues
     * Returns district-scoped operational issues for Product Owner.
     */
    scope.get(
      '/api/v1/districts/:districtId/issues',
      async (
        req: FastifyRequest<{
          Params: { districtId: string };
          Querystring: OperationalIssuesQuery;
        }>,
        reply: FastifyReply,
      ) => {
        const paramResult = DistrictIssueParamsSchema.safeParse(req.params);
        if (!paramResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                paramResult.error.issues[0]?.message ||
                'Нотўғри туман ID кўрсатилди.',
              statusCode: 400,
            },
          });
        }

        const queryResult = OperationalIssuesQuerySchema.safeParse(req.query);
        if (!queryResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                queryResult.error.issues[0]?.message ||
                'Нотўғри қидирув параметрлари киритилди.',
              statusCode: 400,
            },
          });
        }

        const result = await issueService.getOperationalIssues(deps.db, {
          ...queryResult.data,
          districtId: paramResult.data.districtId,
        });
        return reply.status(200).send(result);
      },
    );

    /**
     * POST /api/v1/issues/:issueId/retry
     * Triggers manual retry for an operational issue (Story 4.3 AC 1, AC 2, AC 3).
     */
    scope.post(
      '/api/v1/issues/:issueId/retry',
      async (
        req: FastifyRequest<{
          Params: { issueId: string };
          Body?: { reason?: string };
        }>,
        reply: FastifyReply,
      ) => {
        const paramResult = IssueDetailParamsSchema.safeParse(req.params);
        if (!paramResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                paramResult.error.issues[0]?.message ||
                'Муаммо ID нотўғри кўрсатилди.',
              statusCode: 400,
            },
          });
        }

        const bodyResult = RetryIssueBodySchema.safeParse(req.body);
        if (!bodyResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                bodyResult.error.issues[0]?.message ||
                'Нотўғри сўров маълумотлари.',
              statusCode: 400,
            },
          });
        }

        if (!req.actor) {
          return reply.status(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Аутентификация талаб қилинади.',
              statusCode: 401,
            },
          });
        }

        const actor = {
          id: req.actor.id,
          role: req.actor.role,
        };

        const boss = deps.boss || createBossClient();

        try {
          const result = await retryService.retryOperationalIssue(
            deps.pool,
            boss,
            paramResult.data.issueId,
            actor,
            bodyResult.data,
          );
          return reply.status(202).send(result);
        } catch (err) {
          if (err instanceof OperationalIssueNotFoundError) {
            return reply.status(404).send({
              error: {
                code: err.code,
                message: err.message,
                statusCode: 404,
              },
            });
          }
          if (err instanceof DuplicateRetryInProgressError) {
            return reply.status(409).send({
              error: {
                code: err.code,
                message: err.message,
                statusCode: 409,
              },
            });
          }
          if (err instanceof OperationIneligibleError) {
            return reply.status(422).send({
              error: {
                code: err.code,
                message: err.message,
                statusCode: 422,
              },
            });
          }
          throw err;
        }
      },
    );

    /**
     * POST /api/v1/retry/jobs
     * Triggers manual retry for a background job directly (Story 4.3 AC 2, AC 3).
     */
    scope.post(
      '/api/v1/retry/jobs',
      async (
        req: FastifyRequest<{ Body: RetryOperationRequest }>,
        reply: FastifyReply,
      ) => {
        const bodyResult = RetryOperationRequestSchema.safeParse(req.body);
        if (!bodyResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                bodyResult.error.issues[0]?.message ||
                'Нотўғри қайта ишга тушириш параметрлари.',
              statusCode: 400,
            },
          });
        }

        if (!req.actor) {
          return reply.status(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Аутентификация талаб қилинади.',
              statusCode: 401,
            },
          });
        }

        const actor = {
          id: req.actor.id,
          role: req.actor.role,
        };

        const boss = deps.boss || createBossClient();

        try {
          const result = await retryService.retryBackgroundJob(
            deps.pool,
            boss,
            bodyResult.data,
            actor,
          );
          return reply.status(202).send(result);
        } catch (err) {
          if (err instanceof DuplicateRetryInProgressError) {
            return reply.status(409).send({
              error: {
                code: err.code,
                message: err.message,
                statusCode: 409,
              },
            });
          }
          if (err instanceof OperationIneligibleError) {
            return reply.status(422).send({
              error: {
                code: err.code,
                message: err.message,
                statusCode: 422,
              },
            });
          }
          throw err;
        }
      },
    );
  });
}
