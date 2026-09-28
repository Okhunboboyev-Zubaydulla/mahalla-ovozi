import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  SignInRequestSchema,
  FirstSignInPasswordChangeRequestSchema,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { validateAndTouchSession, revokeSessionByToken, COOKIE_NAME } from './session-manager.js';
import { verifyStateChangingOrigin } from './origin-guard.js';
import {
  signIn,
  changeFirstLoginPassword,
  InvalidCredentialsError,
  RateLimitedError,
  DistrictNotActiveError,
  CredentialConcurrencyConflictError,
  InvalidPasswordPolicyError,
} from './auth-service.js';

export function registerAuthRoutes(fastify: FastifyInstance, db: DbClient) {
  fastify.addHook('preHandler', verifyStateChangingOrigin);

  // 1. Sign In
  fastify.post('/api/v1/auth/sign-in', async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
    const parseResult = SignInRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Фойдаланувчи номи ёки парол талаблари нотўғри.',
        },
      });
    }

    try {
      let ip = req.ip;
      if (!ip) {
        req.log.warn(
          { url: req.url, method: req.method },
          'Missing req.ip in signIn request, falling back to 127.0.0.1',
        );
        ip = '127.0.0.1';
      }

      const result = await signIn(db, {
        username: parseResult.data.username,
        password: parseResult.data.password,
        ip,
        userAgent: req.headers['user-agent'],
      });

      // B4: __Host- prefixed cookies require Secure=true per RFC 6265bis §4.1.3 when on HTTPS.
      reply.setCookie(COOKIE_NAME, result.sessionToken, {
        path: '/',
        httpOnly: true,
        secure: req.protocol === 'https',
        sameSite: 'strict',
        expires: result.expiresAt,
      });

      return reply.status(200).send({
        actor: result.actor,
        session: { expiresAt: result.expiresAt.toISOString() },
      });
    } catch (err) {
      if (err instanceof RateLimitedError) {
        if (err.retryAfterSeconds) {
          reply.header('Retry-After', err.retryAfterSeconds.toString());
        }
        return reply.status(429).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof InvalidCredentialsError) {
        return reply.status(401).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof DistrictNotActiveError) {
        return reply.status(403).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // 2. Sign Out
  fastify.post('/api/v1/auth/sign-out', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawToken = req.cookies[COOKIE_NAME];
    if (rawToken) {
      await revokeSessionByToken(db, rawToken);
    }

    reply.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'strict', secure: req.protocol === 'https' });
    return reply.status(200).send({ success: true });
  });

  // 3. Current Session
  fastify.get('/api/v1/auth/session', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawToken = req.cookies[COOKIE_NAME];
    if (!rawToken) {
      return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Сессия топилмади ёки муддати тугаган.' } });
    }

    const validation = await validateAndTouchSession(db, rawToken);
    if (!validation.isValid || !validation.account || !validation.session) {
      reply.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'strict', secure: req.protocol === 'https' });
      return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Сессия топилмади ёки муддати тугаган.' } });
    }

    return reply.status(200).send({
      actor: {
        id: validation.account.id,
        role: validation.account.role,
        username: validation.account.username,
        districtId: validation.account.districtId ?? null,
        mustChangePassword: validation.account.mustChangePassword,
      },
      session: {
        expiresAt: validation.session.expiresAt.toISOString(),
      },
    });
  });

  // 4. Change First Login Temporary Password (DISTRICT_HOKIM only)
  fastify.post('/api/v1/auth/change-first-login-password', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawToken = req.cookies[COOKIE_NAME];
    if (!rawToken) {
      return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Сессия топилмади ёки муддати тугаган.' } });
    }

    const validation = await validateAndTouchSession(db, rawToken);
    if (!validation.isValid || !validation.account || !validation.session) {
      reply.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'strict', secure: req.protocol === 'https' });
      return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Сессия топилмади ёки муддати тугаган.' } });
    }

    const { account, session } = validation;

    if (account.role !== 'DISTRICT_HOKIM') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Ушбу амал фақат туман ҳокими ҳисоби учун мўлжалланган.' } });
    }

    if (!account.mustChangePassword) {
      return reply.status(400).send({ error: { code: 'INVALID_ACTION', message: 'Ушбу аккаунт учун паролни мажбурий ўзгартириш талаб қилинмайди.' } });
    }

    const parseResult = FirstSignInPasswordChangeRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: parseResult.error.errors[0]?.message || 'Киритилган маълумотлар нотўғри.',
        },
      });
    }

    try {
      const result = await changeFirstLoginPassword(db, {
        account,
        session,
        currentPassword: parseResult.data.currentPassword,
        newPassword: parseResult.data.newPassword,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return reply.status(200).send({ success: true, actor: result.actor });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        return reply.status(401).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof InvalidPasswordPolicyError) {
        return reply.status(400).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof CredentialConcurrencyConflictError) {
        return reply.status(409).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });
}
