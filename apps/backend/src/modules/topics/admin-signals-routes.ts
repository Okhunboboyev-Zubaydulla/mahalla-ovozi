import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import type { DbClient } from '../../adapters/db/client.js';
import {
  ListSignalsQuerySchema,
  PromoteSignalRequestSchema,
  ReclassifyEvidenceRequestSchema,
  UpdateEvidenceTextRequestSchema,
  DeleteEvidenceRequestSchema,
  CreateManualSignalRequestSchema,
  BatchDeleteSignalsRequestSchema,
} from '@mahalla-ovozi/api-contracts';
import { createRequireProductOwner } from '../auth/require-auth.js';
import {
  listSignals,
  getSignalDetail,
  promoteSignal,
  reclassifyEvidence,
  updateEvidenceText,
  deleteEvidence,
  createManualSignal,
  batchDeleteSignals,
  SignalNotFoundError,
  SignalAlreadyAcceptedError,
} from './topic-evidence-management-service.js';

export interface AdminSignalsRoutesDeps {
  db: DbClient;
  pool?: pg.Pool;
  boss?: PgBoss;
}

function handleSignalError(err: unknown, reply: FastifyReply, req?: FastifyRequest) {
  if (err instanceof SignalNotFoundError) {
    return reply.status(404).send({
      error: {
        code: 'SIGNAL_NOT_FOUND',
        message: err.message,
      },
    });
  }
  if (err instanceof SignalAlreadyAcceptedError) {
    return reply.status(409).send({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  req?.log.error({ err }, 'Admin signal operation failed');
  return reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : 'Кутилмаган хатолик юз берди.',
    },
  });
}

export function registerAdminSignalsRoutes(
  fastify: FastifyInstance,
  deps: AdminSignalsRoutesDeps,
): void {
  const { db, pool, boss } = deps;

  fastify.register(async (instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();
    scope.addHook('preHandler', createRequireProductOwner(db));

    // GET /api/v1/admin/signals
    scope.get(
      '/api/v1/admin/signals',
      {
        schema: {
          querystring: ListSignalsQuerySchema,
        },
      },
      async (req, reply) => {
        try {
          const result = await listSignals(db, req.query);
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleSignalError(err, reply, req as FastifyRequest);
        }
      },
    );

    // GET /api/v1/admin/signals/:id
    scope.get(
      '/api/v1/admin/signals/:id',
      async (req, reply) => {
        const { id } = req.params as { id: string };
        if (!id || typeof id !== 'string' || id.trim() === '') {
          return reply.status(404).send({
            error: {
              code: 'SIGNAL_NOT_FOUND',
              message: 'Сигнал топилмади.',
            },
          });
        }

        try {
          const details = await getSignalDetail(db, id.trim());
          return reply.status(200).send(details);
        } catch (err: unknown) {
          return handleSignalError(err, reply, req as FastifyRequest);
        }
      },
    );

    // POST /api/v1/admin/signals/:id/promote
    scope.post(
      '/api/v1/admin/signals/:id/promote',
      {
        schema: {
          body: PromoteSignalRequestSchema,
        },
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };

        if (!pool || !boss) {
          return reply.status(500).send({
            error: {
              code: 'SERVER_MISCONFIGURED',
              message: 'Сервер навбат тизимига уланмаган.',
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

        try {
          const actor = req.actor;
          const result = await promoteSignal(pool, boss, db, {
            intakeId: id.trim(),
            lanes: req.body.lanes,
            changeReason: req.body.changeReason,
            actorId: actor.id,
            actorRole: actor.role,
          });

          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleSignalError(err, reply, req as FastifyRequest);
        }
      },
    );

    // POST /api/v1/admin/signals/:id/reclassify
    scope.post(
      '/api/v1/admin/signals/:id/reclassify',
      {
        schema: {
          body: ReclassifyEvidenceRequestSchema,
        },
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };

        if (!pool || !boss) {
          return reply.status(500).send({
            error: {
              code: 'SERVER_MISCONFIGURED',
              message: 'Сервер навбат тизимига уланмаган.',
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

        try {
          const actor = req.actor;
          const result = await reclassifyEvidence(pool, boss, db, {
            evidenceId: id.trim(),
            lanes: req.body.lanes,
            changeReason: req.body.changeReason,
            actorId: actor.id,
            actorRole: actor.role,
          });

          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleSignalError(err, reply, req as FastifyRequest);
        }
      },
    );

    // PATCH /api/v1/admin/signals/:id/evidence
    scope.patch(
      '/api/v1/admin/signals/:id/evidence',
      {
        schema: {
          body: UpdateEvidenceTextRequestSchema,
        },
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };

        if (!pool || !boss) {
          return reply.status(500).send({
            error: {
              code: 'SERVER_MISCONFIGURED',
              message: 'Сервер навбат тизимига уланмаган.',
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

        try {
          const actor = req.actor;
          const result = await updateEvidenceText(pool, boss, db, {
            evidenceId: id.trim(),
            verbatimText: req.body.verbatimText,
            changeReason: req.body.changeReason,
            actorId: actor.id,
            actorRole: actor.role,
          });

          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleSignalError(err, reply, req as FastifyRequest);
        }
      },
    );

    // DELETE /api/v1/admin/signals/:id/evidence
    scope.delete(
      '/api/v1/admin/signals/:id/evidence',
      {
        schema: {
          body: DeleteEvidenceRequestSchema,
        },
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };

        if (!pool || !boss) {
          return reply.status(500).send({
            error: {
              code: 'SERVER_MISCONFIGURED',
              message: 'Сервер навбат тизимига уланмаган.',
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

        try {
          const actor = req.actor;
          const result = await deleteEvidence(pool, boss, db, {
            evidenceId: id.trim(),
            changeReason: req.body.changeReason,
            actorId: actor.id,
            actorRole: actor.role,
          });

          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleSignalError(err, reply, req as FastifyRequest);
        }
      },
    );

    // POST /api/v1/admin/signals/manual
    scope.post(
      '/api/v1/admin/signals/manual',
      {
        schema: {
          body: CreateManualSignalRequestSchema,
        },
      },
      async (req, reply) => {
        if (!pool || !boss) {
          return reply.status(500).send({
            error: {
              code: 'SERVER_MISCONFIGURED',
              message: 'Сервер навбат тизимига уланмаган.',
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

        try {
          const actor = req.actor;
          const result = await createManualSignal(pool, boss, db, {
            ...req.body,
            actorId: actor.id,
            actorRole: actor.role,
          });

          return reply.status(201).send(result);
        } catch (err: unknown) {
          return handleSignalError(err, reply, req as FastifyRequest);
        }
      },
    );

    // POST /api/v1/admin/signals/batch-delete
    scope.post(
      '/api/v1/admin/signals/batch-delete',
      {
        schema: {
          body: BatchDeleteSignalsRequestSchema,
        },
      },
      async (req, reply) => {
        if (!pool || !boss) {
          return reply.status(500).send({
            error: {
              code: 'SERVER_MISCONFIGURED',
              message: 'Сервер навбат тизимига уланмаган.',
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

        try {
          const actor = req.actor;
          const result = await batchDeleteSignals(pool, boss, db, {
            ids: req.body.ids,
            changeReason: req.body.changeReason,
            actorId: actor.id,
            actorRole: actor.role,
          });

          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleSignalError(err, reply, req as FastifyRequest);
        }
      },
    );
  });
}
