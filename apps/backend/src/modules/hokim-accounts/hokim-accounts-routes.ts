import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  CreateHokimAccountRequestSchema,
  ReplaceHokimAccountRequestSchema,
  UpdateHokimUsernameRequestSchema,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import {
  getDistrictHokimAccount,
  createDistrictHokimAccount,
  resetDistrictHokimPassword,
  disableDistrictHokimAccount,
  replaceDistrictHokimAccount,
  updateDistrictHokimUsername,
  DistrictHokimAlreadyExistsError,
  HokimAccountNotFoundError,
  UsernameAlreadyTakenError,
  HokimAccountDisabledError,
  HokimAccountCreationError,
} from './hokim-accounts-service.js';
import { DistrictNotFoundError } from '../districts/districts-service.js';

export function registerHokimAccountRoutes(fastify: FastifyInstance, db: DbClient): void {
  fastify.register(async (scope) => {
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireProductOwner(db));

    // 1. GET /api/v1/districts/:districtId/hokim-account
    scope.get(
      '/api/v1/districts/:districtId/hokim-account',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        try {
          const result = await getDistrictHokimAccount(db, districtId);
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleHokimAccountError(err, reply);
        }
      },
    );

    // 2. POST /api/v1/districts/:districtId/hokim-account (Create)
    scope.post(
      '/api/v1/districts/:districtId/hokim-account',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = CreateHokimAccountRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                parseResult.error.errors[0]?.message ||
                'Фойдаланувчи номи талаблари нотўғри (3-64 белги, лотин ҳарфлари ва рақамлар).',
            },
          });
        }

        try {
          const result = await createDistrictHokimAccount(
            db,
            districtId,
            parseResult.data,
            req.actor!,
            { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
          );
          return reply.status(201).send(result);
        } catch (err: unknown) {
          return handleHokimAccountError(err, reply);
        }
      },
    );

    // 3. POST /api/v1/districts/:districtId/hokim-account/reset-password
    scope.post(
      '/api/v1/districts/:districtId/hokim-account/reset-password',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        try {
          const result = await resetDistrictHokimPassword(
            db,
            districtId,
            req.actor!,
            { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
          );
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleHokimAccountError(err, reply);
        }
      },
    );

    // 4. POST /api/v1/districts/:districtId/hokim-account/disable
    scope.post(
      '/api/v1/districts/:districtId/hokim-account/disable',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        try {
          const result = await disableDistrictHokimAccount(
            db,
            districtId,
            req.actor!,
            { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
          );
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleHokimAccountError(err, reply);
        }
      },
    );

    // 5. POST /api/v1/districts/:districtId/hokim-account/replace
    scope.post(
      '/api/v1/districts/:districtId/hokim-account/replace',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = ReplaceHokimAccountRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                parseResult.error.errors[0]?.message ||
                'Янги фойдаланувчи номи талаблари нотўғри (3-64 белги, лотин ҳарфлари ва рақамлар).',
            },
          });
        }

        try {
          const result = await replaceDistrictHokimAccount(
            db,
            districtId,
            parseResult.data,
            req.actor!,
            { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
          );
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleHokimAccountError(err, reply);
        }
      },
    );

    // 6. PATCH /api/v1/districts/:districtId/hokim-account (Update Username)
    scope.patch(
      '/api/v1/districts/:districtId/hokim-account',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = UpdateHokimUsernameRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                parseResult.error.errors[0]?.message ||
                'Фойдаланувчи номи талаблари нотўғри (3-64 белги, ҳарфлар, рақамлар, бўш жой).',
            },
          });
        }

        try {
          const result = await updateDistrictHokimUsername(
            db,
            districtId,
            parseResult.data,
            req.actor!,
            { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
          );
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleHokimAccountError(err, reply);
        }
      },
    );
  });
}

function handleHokimAccountError(err: unknown, reply: FastifyReply) {
  if (err instanceof DistrictNotFoundError) {
    return reply.status(404).send({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  if (
    err instanceof DistrictHokimAlreadyExistsError ||
    err instanceof HokimAccountNotFoundError ||
    err instanceof UsernameAlreadyTakenError ||
    err instanceof HokimAccountDisabledError ||
    err instanceof HokimAccountCreationError
  ) {
    return reply.status(err.statusCode).send({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  throw err;
}
