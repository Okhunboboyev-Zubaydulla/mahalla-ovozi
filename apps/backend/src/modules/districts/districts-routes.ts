import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  CreateDistrictRequestSchema,
  UpdateDistrictRequestSchema,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import { getClientInfo } from '../auth/client-info.js';
import {
  listDistricts,
  getDistrictById,
  createDistrict,
  updateDistrict,
  DistrictNameExistsError,
} from './districts-service.js';
import {
  getOnboardingReadiness,
  confirmStandingDisclosure,
  activateDistrict,
  DistrictNotFoundError,
  DistrictAlreadyActiveError,
  DistrictNotReadyForActivationError,
  DistrictInvalidStatusError,
} from './district-onboarding-engine.js';
import { DistrictAlreadyDeletedError } from '../subscriptions/district-deletion-service.js';

export function registerDistrictRoutes(fastify: FastifyInstance, db: DbClient): void {
  // P3-D & P3-E: Encapsulate district routes in a plugin scope so requireProductOwner only applies here
  fastify.register(async (scope) => {
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireProductOwner(db));

    // 1. List all districts
    scope.get('/api/v1/districts', async (_req: FastifyRequest, reply: FastifyReply) => {
      const districtsList = await listDistricts(db);
      return reply.status(200).send({ districts: districtsList });
    });

    // 2. Create district
    scope.post(
      '/api/v1/districts',
      async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
        const parseResult = CreateDistrictRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Туман маълумотлари нотўғри.',
            },
          });
        }

        try {
          const district = await createDistrict(
            db,
            parseResult.data,
            req.actor,
            getClientInfo(req)
          );
          // P3-G: Returns HTTP 201 Created on success
          return reply.status(201).send({ district });
        } catch (err: unknown) {
          return handleDistrictError(err, reply);
        }
      }
    );

    // Update district
    scope.patch(
      '/api/v1/districts/:districtId',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply
      ) => {
        const { districtId } = req.params;
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'Туман идентификатори талаб қилинади.' },
          });
        }

        const parseResult = UpdateDistrictRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Туман маълумотлари нотўғри.',
            },
          });
        }

        try {
          const district = await updateDistrict(
            db,
            districtId,
            parseResult.data,
            req.actor,
            getClientInfo(req)
          );
          return reply.status(200).send({ district });
        } catch (err: unknown) {
          return handleDistrictError(err, reply);
        }
      }
    );

    // 3. Get district by ID
    scope.get(
      '/api/v1/districts/:districtId',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'Туман идентификатори талаб қилинади.' },
          });
        }

        try {
          const district = await getDistrictById(db, districtId);
          return reply.status(200).send({ district });
        } catch (err: unknown) {
          return handleDistrictError(err, reply);
        }
      }
    );

    // 4. Get district activation readiness
    scope.get(
      '/api/v1/districts/:districtId/readiness',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'Туман идентификатори талаб қилинади.' },
          });
        }

        try {
          const readiness = await getOnboardingReadiness(db, districtId);
          return reply.status(200).send({ readiness });
        } catch (err: unknown) {
          return handleDistrictError(err, reply);
        }
      }
    );

    // 5. Confirm district external disclosure
    scope.post(
      '/api/v1/districts/:districtId/disclosure-confirmation',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'Туман идентификатори талаб қилинади.' },
          });
        }

        if (!req.actor) {
          return reply.status(401).send({
            error: { code: 'UNAUTHENTICATED', message: 'Авторизациядан ўтилмаган.' },
          });
        }

        try {
          const result = await confirmStandingDisclosure(
            db,
            districtId,
            req.actor,
            getClientInfo(req)
          );
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleDistrictError(err, reply);
        }
      }
    );

    // 6. Activate district
    scope.post(
      '/api/v1/districts/:districtId/activate',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'Туман идентификатори талаб қилинади.' },
          });
        }

        if (!req.actor) {
          return reply.status(401).send({
            error: { code: 'UNAUTHENTICATED', message: 'Авторизациядан ўтилмаган.' },
          });
        }

        try {
          const result = await activateDistrict(
            db,
            districtId,
            req.actor,
            getClientInfo(req)
          );
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleDistrictError(err, reply);
        }
      }
    );
  });
}

function handleDistrictError(err: unknown, reply: FastifyReply) {
  if (err instanceof DistrictNotFoundError) {
    return reply.status(404).send({
      error: { code: err.code, message: 'Туман топилмади.' },
    });
  }

  if (err instanceof DistrictNameExistsError) {
    return reply.status(409).send({
      error: { code: err.code, message: 'Бу номдаги туман аллақачон мавжуд.' },
    });
  }

  if (err instanceof DistrictNotReadyForActivationError) {
    return reply.status(409).send({
      error: { code: err.code, message: err.message, blockers: err.blockers },
    });
  }

  if (
    err instanceof DistrictAlreadyActiveError ||
    err instanceof DistrictInvalidStatusError ||
    err instanceof DistrictAlreadyDeletedError
  ) {
    return reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message },
    });
  }

  throw err;
}


