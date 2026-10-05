import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  CreateUserbotSessionRequestSchema,
  District,
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
  UserbotCredentialValidationError,
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
    lastSuccessfulConnectionAt: session.lastSuccessfulConnectionAt
      ? session.lastSuccessfulConnectionAt instanceof Date
        ? session.lastSuccessfulConnectionAt.toISOString()
        : String(session.lastSuccessfulConnectionAt)
      : null,
    inboundUpdateCounter: session.inboundUpdateCounter ?? 0,
    isStale: session.isStale ?? false,
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

export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHENTICATED' as const;
  readonly statusCode = 401;
  constructor(message = 'Сессия топилмади ёки муддати тугаган.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN' as const;
  readonly statusCode = 403;
  constructor(message = 'Ушбу амални бажариш учун ҳуқуқ етарли эмас.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

function handleUserbotSessionError(err: unknown, reply: FastifyReply) {
  if (
    err instanceof UnauthorizedError ||
    (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'UNAUTHENTICATED')
  ) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHENTICATED',
        message: err instanceof Error ? err.message : 'Сессия топилмади ёки муддати тугаган.',
      },
    });
  }

  if (
    err instanceof ForbiddenError ||
    (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'FORBIDDEN')
  ) {
    return reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: err instanceof Error ? err.message : 'Ушбу амални бажариш учун ҳуқуқ етарли эмас.',
      },
    });
  }

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
    err instanceof UserbotCredentialValidationError ||
    (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'VALIDATION_ERROR')
  ) {
    const errorObj = err as { message: string; field?: string };
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: err instanceof Error ? err.message : 'Validation error.',
        validationErrors: errorObj.field
          ? [{ path: [errorObj.field], message: err instanceof Error ? err.message : 'Validation error.' }]
          : undefined,
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

/**
 * Standardized District session scope resolver for userbot session routes.
 *
 * Product Owner Entitlement Invariant:
 * Product Owners possess platform-wide multi-district administration access.
 * The database constraint `accounts_role_district_check` guarantees:
 * `(role = 'PRODUCT_OWNER' AND district_id IS NULL) OR (role = 'DISTRICT_HOKIM' AND district_id IS NOT NULL)`
 * Consequently, Product Owners are never restricted to any single district; every Product Owner
 * is authoritatively entitled to manage userbot sessions for every District on the platform.
 *
 * Information Leakage Prevention:
 * Authentication and authorization are validated before any district database lookup occurs.
 * Unauthenticated callers receive 401 UNAUTHENTICATED, and callers with non-PRODUCT_OWNER roles
 * receive 403 FORBIDDEN before district existence is evaluated. This ensures unauthorized callers
 * can never probe or discern whether a given districtId actually exists on the system.
 */
export async function resolveDistrictSessionScope(
  db: DbClient,
  req: FastifyRequest<{ Params?: { districtId?: string } }>,
): Promise<{ districtId: string; district: District }> {
  // 1. Authentication check
  const actor = req.actor;
  if (!actor) {
    throw new UnauthorizedError();
  }

  // 2. Authorization / Product Owner role check
  if (actor.role !== 'PRODUCT_OWNER') {
    throw new ForbiddenError();
  }

  // 3. District ID parameter check
  const rawDistrictId = req.params?.districtId;
  if (!rawDistrictId || rawDistrictId.trim().length === 0) {
    throw new DistrictNotFoundError(rawDistrictId ?? '');
  }

  // 4. District existence verification
  const district = await getDistrictById(db, rawDistrictId.trim());
  return { districtId: district.id, district };
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
        try {
          const { districtId } = await resolveDistrictSessionScope(db, req);

          const parseResult = CreateUserbotSessionRequestSchema.safeParse(req.body);
          if (!parseResult.success) {
            const firstError = parseResult.error.errors[0];
            return reply.status(400).send({
              error: {
                code: 'VALIDATION_ERROR',
                message: firstError?.message || 'Validation error',
                validationErrors: parseResult.error.errors.map((e) => ({
                  path: e.path.map((p) => (typeof p === 'number' ? p : String(p))),
                  message: e.message,
                  code: e.code,
                })),
              },
            });
          }

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
        try {
          const { districtId } = await resolveDistrictSessionScope(db, req);
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
        try {
          const { districtId } = await resolveDistrictSessionScope(db, req);
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
        try {
          const { districtId } = await resolveDistrictSessionScope(db, req);
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
