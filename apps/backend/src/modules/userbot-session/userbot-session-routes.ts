import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  CreateUserbotSessionRequestSchema,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import { getDistrictById, DistrictNotFoundError } from '../districts/districts-service.js';
import {
  createDistrictUserbotSession,
  getDistrictUserbotSession,
  disableDistrictUserbotSession,
  enableDistrictUserbotSession,
  PublicDistrictUserbotSession,
  UserbotSessionNotFoundError,
  SessionBannedError,
  UserbotSessionDisabledError,
  ConflictError,
} from './userbot-session-service.js';

function formatPublicSession(session: PublicDistrictUserbotSession) {
  return {
    id: session.id,
    districtId: session.districtId,
    phoneNumber: session.phoneNumber,
    apiId: session.apiId,
    status: session.status,
    hasSession: session.hasSession,
    lastSeenAt: session.lastSeenAt
      ? session.lastSeenAt instanceof Date
        ? session.lastSeenAt.toISOString()
        : String(session.lastSeenAt)
      : null,
    createdAt:
      session.createdAt instanceof Date
        ? session.createdAt.toISOString()
        : String(session.createdAt),
    updatedAt:
      session.updatedAt instanceof Date
        ? session.updatedAt.toISOString()
        : String(session.updatedAt),
  };
}

function handleUserbotSessionError(err: unknown, reply: FastifyReply) {
  if (
    err instanceof DistrictNotFoundError ||
    (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'DISTRICT_NOT_FOUND')
  ) {
    return reply.status(404).send({
      error: {
        code: 'DISTRICT_NOT_FOUND',
        message: err instanceof Error ? err.message : 'District not found.',
      },
    });
  }

  if (
    err instanceof UserbotSessionNotFoundError ||
    (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'USERBOT_SESSION_NOT_FOUND')
  ) {
    return reply.status(404).send({
      error: {
        code: 'USERBOT_SESSION_NOT_FOUND',
        message: err instanceof Error ? err.message : 'Userbot session not found.',
      },
    });
  }

  if (
    err instanceof SessionBannedError ||
    (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'USERBOT_SESSION_BANNED')
  ) {
    return reply.status(409).send({
      error: {
        code: 'USERBOT_SESSION_BANNED',
        message: err instanceof Error ? err.message : 'Userbot session is banned.',
      },
    });
  }

  if (
    err instanceof UserbotSessionDisabledError ||
    (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'USERBOT_SESSION_DISABLED')
  ) {
    return reply.status(409).send({
      error: {
        code: 'USERBOT_SESSION_DISABLED',
        message: err instanceof Error ? err.message : 'Userbot session is disabled.',
      },
    });
  }

  if (
    err instanceof ConflictError ||
    (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'CONFLICT')
  ) {
    return reply.status(409).send({
      error: {
        code: 'CONFLICT',
        message: err instanceof Error ? err.message : 'Conflict.',
      },
    });
  }

  throw err;
}

export function registerUserbotSessionRoutes(fastify: FastifyInstance, db: DbClient): void {
  fastify.register(async (scope) => {
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireProductOwner(db));

    // POST /api/v1/districts/:districtId/userbot-session
    scope.post(
      '/api/v1/districts/:districtId/userbot-session',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = CreateUserbotSessionRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Validation error',
            },
          });
        }

        try {
          await getDistrictById(db, districtId);

          const actorId = (req.actor as { actorId?: string; id?: string } | undefined)?.actorId ?? req.actor?.id ?? null;
          const actorRole = (req.actor as { actorRole?: string; role?: string } | undefined)?.actorRole ?? req.actor?.role ?? null;

          const session = await createDistrictUserbotSession(db, {
            districtId,
            phoneNumber: parseResult.data.phoneNumber,
            apiId: parseResult.data.apiId,
            apiHash: parseResult.data.apiHash,
            actorId,
            actorRole,
          });

          return reply.status(201).send({ session: formatPublicSession(session) });
        } catch (err: unknown) {
          return handleUserbotSessionError(err, reply);
        }
      },
    );

    // GET /api/v1/districts/:districtId/userbot-session
    scope.get(
      '/api/v1/districts/:districtId/userbot-session',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        try {
          await getDistrictById(db, districtId);
          const session = await getDistrictUserbotSession(db, districtId);
          return reply.status(200).send({
            session: session ? formatPublicSession(session) : null,
          });
        } catch (err: unknown) {
          return handleUserbotSessionError(err, reply);
        }
      },
    );

    // POST /api/v1/districts/:districtId/userbot-session/disable
    scope.post(
      '/api/v1/districts/:districtId/userbot-session/disable',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        try {
          const actor = req.actor
            ? {
                actorId: (req.actor as { actorId?: string; id?: string }).actorId ?? req.actor.id,
                actorRole: (req.actor as { actorRole?: string; role?: string }).actorRole ?? req.actor.role,
              }
            : undefined;
          const session = await disableDistrictUserbotSession(db, districtId, actor);
          return reply.status(200).send({ session: formatPublicSession(session) });
        } catch (err: unknown) {
          return handleUserbotSessionError(err, reply);
        }
      },
    );

    // POST /api/v1/districts/:districtId/userbot-session/enable
    scope.post(
      '/api/v1/districts/:districtId/userbot-session/enable',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        try {
          const actor = req.actor
            ? {
                actorId: (req.actor as { actorId?: string; id?: string }).actorId ?? req.actor.id,
                actorRole: (req.actor as { actorRole?: string; role?: string }).actorRole ?? req.actor.role,
              }
            : undefined;
          const session = await enableDistrictUserbotSession(db, districtId, actor);
          return reply.status(200).send({ session: formatPublicSession(session) });
        } catch (err: unknown) {
          return handleUserbotSessionError(err, reply);
        }
      },
    );
  });
}
