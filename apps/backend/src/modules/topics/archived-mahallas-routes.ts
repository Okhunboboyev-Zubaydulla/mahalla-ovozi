import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ArchivedMahallaTopicParamsSchema,
  DeleteArchivedMahallaRequestSchema,
} from '@mahalla-ovozi/api-contracts';
import type { DbClient } from '../../adapters/db/client.js';
import { createRequireProductOwner } from '../auth/require-auth.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import {
  ArchivedMahallaConfirmationMismatchError,
  ArchivedMahallaNotArchivedError,
  ArchivedMahallaNotFoundError,
  deleteArchivedMahalla,
  listArchivedMahallas,
} from './archived-mahallas-service.js';

export interface ArchivedMahallasRoutesDeps {
  db: DbClient;
}

function handleArchivedMahallaError(err: unknown, reply: FastifyReply, req: FastifyRequest) {
  if (err instanceof ArchivedMahallaNotFoundError) {
    return reply.status(404).send({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  if (err instanceof ArchivedMahallaNotArchivedError) {
    return reply.status(409).send({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  if (err instanceof ArchivedMahallaConfirmationMismatchError) {
    return reply.status(400).send({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  req.log.error({ err }, 'Archived mahalla operation failed');
  return reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : 'Кутилмаган хатолик юз берди.',
    },
  });
}

export function registerArchivedMahallasRoutes(
  fastify: FastifyInstance,
  deps: ArchivedMahallasRoutesDeps,
): void {
  const { db } = deps;

  fastify.register(async (instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireProductOwner(db));

    // GET /api/v1/admin/archived-mahallas
    scope.get(
      '/api/v1/admin/archived-mahallas',
      async (req, reply) => {
        try {
          const items = await listArchivedMahallas(db);
          return reply.status(200).send({ items });
        } catch (err: unknown) {
          return handleArchivedMahallaError(err, reply, req as FastifyRequest);
        }
      },
    );

    // DELETE /api/v1/admin/archived-mahallas/:topicId
    scope.delete(
      '/api/v1/admin/archived-mahallas/:topicId',
      {
        schema: {
          params: ArchivedMahallaTopicParamsSchema,
          body: DeleteArchivedMahallaRequestSchema,
        },
      },
      async (req, reply) => {
        try {
          const result = await deleteArchivedMahalla(
            db,
            req.params.topicId,
            req.body.confirmMahallaName,
          );
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleArchivedMahallaError(err, reply, req as FastifyRequest);
        }
      },
    );
  });
}
