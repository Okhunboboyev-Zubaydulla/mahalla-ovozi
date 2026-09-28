import { eq } from 'drizzle-orm';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ActorContextSchema } from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { COOKIE_NAME, validateAndTouchSession } from './session-manager.js';
import { districts } from '../../adapters/db/schema/index.js';

export interface RequireAuthOptions {
  allowedRoles?: readonly string[];
  requireDistrictId?: boolean;
  allowMatchingDistrictOnly?: boolean;
}

/**
 * Canonical Fastify authentication and authorization preHandler guard (AD-9).
 * - Extracts and verifies session token from HTTP-only cookie.
 * - Touches session activity timestamp.
 * - Handles automated cookie clearance on invalid/expired sessions.
 * - Enforces role-based permissions and strict tenant/district isolation.
 */
export function createRequireAuth(db: DbClient, options: RequireAuthOptions = {}) {
  return async function requireAuth(
    req: FastifyRequest<{ Params?: { districtId?: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const rawToken = req.cookies[COOKIE_NAME];
    if (!rawToken) {
      reply.status(401).send({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Сессия топилмади ёки муддати тугаган.',
        },
      });
      return;
    }

    const validation = await validateAndTouchSession(db, rawToken);
    if (!validation.isValid || !validation.account || !validation.session) {
      reply.clearCookie(COOKIE_NAME, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: req.protocol === 'https',
      });
      reply.status(401).send({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Сессия топилмади ёки муддати тугаган.',
        },
      });
      return;
    }

    const { account } = validation;

    // Enforce temporary password change barrier (F2.1)
    if (account.mustChangePassword) {
      reply.status(403).send({
        error: {
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'Тизимдан фойдаланиш учун аввал бошланғич паролни ўзгартиришингиз шарт.',
        },
      });
      return;
    }

    // 1. Role validation
    if (options.allowedRoles && options.allowedRoles.length > 0) {
      if (!options.allowedRoles.includes(account.role)) {
        reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Ушбу амални бажариш учун ҳуқуқ етарли эмас.',
          },
        });
        return;
      }
    }

    // 2. District ID requirement and live status check (for DISTRICT_HOKIM)
    if (account.role === 'DISTRICT_HOKIM') {
      if (!account.districtId) {
        reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Ушбу амални бажариш учун ҳуқуқ етарли эмас.',
          },
        });
        return;
      }

      const [district] = await db
        .select({
          status: districts.status,
          accessEligible: districts.accessEligible,
        })
        .from(districts)
        .where(eq(districts.id, account.districtId))
        .limit(1);

      if (!district || district.accessEligible === false) {
        reply.status(403).send({
          error: {
            code: 'DISTRICT_NOT_ACTIVE',
            message: 'Ушбу туман хизмати фаол эмас.',
          },
        });
        return;
      }

      if (district.status === 'SUSPENDED') {
        reply.status(403).send({
          error: {
            code: 'DISTRICT_SUSPENDED',
            message: 'Ушбу туман хизмати вақтинча тўхтатилган (Suspended).',
          },
        });
        return;
      }

      if (district.status === 'CANCELLED') {
        reply.status(403).send({
          error: {
            code: 'DISTRICT_CANCELLED',
            message: 'Ушбу туман бекор қилинган (Cancelled).',
          },
        });
        return;
      }

      if (district.status === 'SETUP_INCOMPLETE') {
        reply.status(403).send({
          error: {
            code: 'DISTRICT_NOT_ACTIVE',
            message: 'Ушбу туман хизмати фаол эмас (Setup Incomplete).',
          },
        });
        return;
      }
    }

    // 3. Strict tenant matching if requested
    if (options.allowMatchingDistrictOnly && account.role === 'DISTRICT_HOKIM') {
      const requestedDistrictId = req.params?.districtId;
      if (!requestedDistrictId || account.districtId !== requestedDistrictId) {
        reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Ушбу туман маълумотларини кўриш учун рухсат йўқ.',
          },
        });
        return;
      }
    }

    // Attach the validated actor context for downstream route handlers.
    // Built from the account row but validated against the shared contract schema,
    // so `req.actor` is the one actor type rather than the raw database row.
    // The accounts table constrains role and status via CHECK, so a parse failure
    // here means a corrupt row: fail loudly instead of leaking a malformed actor
    // into tenant-scoped queries.
    const actorResult = ActorContextSchema.safeParse({
      id: account.id,
      role: account.role,
      username: account.username,
      districtId: account.districtId,
      mustChangePassword: account.mustChangePassword,
    });

    if (!actorResult.success) {
      reply.status(500).send({
        error: {
          code: 'ACTOR_CONTEXT_INVALID',
          message: 'Фойдаланувчи контекстини шакллантиришда хатолик юз берди.',
        },
      });
      return;
    }

    req.actor = actorResult.data;
  };
}

export function createRequireProductOwner(db: DbClient) {
  return createRequireAuth(db, { allowedRoles: ['PRODUCT_OWNER'] });
}

export function createRequireHokim(db: DbClient) {
  return createRequireAuth(db, {
    allowedRoles: ['DISTRICT_HOKIM'],
    requireDistrictId: true,
  });
}

export function createRequireDistrictAccess(db: DbClient) {
  return createRequireAuth(db, {
    allowedRoles: ['PRODUCT_OWNER', 'DISTRICT_HOKIM'],
    allowMatchingDistrictOnly: true,
  });
}
