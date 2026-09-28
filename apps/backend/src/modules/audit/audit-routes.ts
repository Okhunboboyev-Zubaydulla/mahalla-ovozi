import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AuditHistoryQuerySchema,
  AuditHistoryQuery,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import { auditQueryService } from './audit-query-service.js';

const AuditEventParamsSchema = z.object({
  id: z.string().min(1, 'Аудит ID киритилиши шарт.'),
});

export function registerAuditRoutes(server: FastifyInstance, db: DbClient): void {
  // Encapsulated Fastify scope with Product Owner authorization guard (AC 1, AC 8)
  server.register(async (scope) => {
    scope.addHook('preHandler', createRequireProductOwner(db));

    /**
     * GET /api/v1/audit/events
     * Searchable, multi-parameter filtered, keyset-paginated audit history (AC 1, 2, 3, 7, 8, 9).
     */
    scope.get(
      '/api/v1/audit/events',
      async (
        req: FastifyRequest<{ Querystring: AuditHistoryQuery }>,
        reply: FastifyReply,
      ) => {
        const parseResult = AuditHistoryQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                parseResult.error.issues[0]?.message ||
                'Нотўғри қидирув параметрлари киритилди.',
              statusCode: 400,
              validationErrors: parseResult.error.issues.map((issue) => ({
                path: issue.path,
                message: issue.message,
                code: issue.code,
              })),
            },
          });
        }

        const page = await auditQueryService.queryAuditEvents(
          db,
          parseResult.data,
        );
        return reply.status(200).send(page);
      },
    );

    /**
     * GET /api/v1/audit/events/:id
     * Returns a single audit event detail (AC 4, AC 8).
     */
    scope.get(
      '/api/v1/audit/events/:id',
      async (
        req: FastifyRequest<{ Params: { id: string } }>,
        reply: FastifyReply,
      ) => {
        const paramResult = AuditEventParamsSchema.safeParse(req.params);
        if (!paramResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                paramResult.error.issues[0]?.message ||
                'Аудит ID нотўғри кўрсатилди.',
              statusCode: 400,
            },
          });
        }

        const event = await auditQueryService.getAuditEventById(
          db,
          paramResult.data.id,
        );

        if (!event) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Аудит ёзуви топилмади.',
              statusCode: 404,
            },
          });
        }

        return reply.status(200).send(event);
      },
    );
  });
}
