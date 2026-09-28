import { FastifyInstance, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import {
  DistrictTopicsQuerySchema,
  DistrictTopicsSearchBodySchema,
  TopicEvidenceQuerySchema,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { districts } from '../../adapters/db/schema/index.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import {
  DistrictNotFoundError,
  DistrictRequiredError,
  InvalidCursorError,
  decodeTopicKeysetCursor,
  queryDistrictMahallas,
  queryDistrictTopicsPage,
} from './topic-query-engine.js';
import { InvalidDateRangeError } from '../telegram-intake/timezone-util.js';
import {
  getTopicEvidence,
  TopicNotFoundError,
  decodeEvidenceKeysetCursor,
} from './topic-evidence-service.js';

export function registerDistrictTopicsRoutes(fastify: FastifyInstance, db: DbClient): void {
  fastify.register(async (instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireProductOwner(db));

    // 1. Get district mahallas
    scope.get(
      '/api/v1/districts/:districtId/topics/mahallas',
      async (req, reply) => {
        const { districtId } = req.params as { districtId: string };
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: {
              code: 'DISTRICT_REQUIRED',
              message: 'Туман ID кўрсатилиши шарт.',
            },
          });
        }

        try {
          const mahallas = await queryDistrictMahallas(db, districtId);
          return reply.status(200).send({ mahallas });
        } catch (err: unknown) {
          return handleDistrictTopicsError(err, reply);
        }
      },
    );

    // 2. Get district topics (GET)
    scope.get(
      '/api/v1/districts/:districtId/topics',
      {
        schema: {
          querystring: DistrictTopicsQuerySchema,
        },
      },
      async (req, reply) => {
        const { districtId } = req.params as { districtId: string };
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: {
              code: 'DISTRICT_REQUIRED',
              message: 'Туман ID кўрсатилиши шарт.',
            },
          });
        }

        const { cursor } = req.query;
        if (cursor && !decodeTopicKeysetCursor(cursor)) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_CURSOR',
              message: 'Курсор нотўғри ёки муддати ўтган.',
            },
          });
        }

        try {
          const page = await queryDistrictTopicsPage(db, {
            districtId,
            filter: req.query,
          });
          return reply.status(200).send(page);
        } catch (err: unknown) {
          return handleDistrictTopicsError(err, reply);
        }
      },
    );

    // 3. Search district topics (POST for privacy-safe search term transmission)
    scope.post(
      '/api/v1/districts/:districtId/topics/search',
      {
        schema: {
          body: DistrictTopicsSearchBodySchema,
        },
      },
      async (req, reply) => {
        const { districtId } = req.params as { districtId: string };
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: {
              code: 'DISTRICT_REQUIRED',
              message: 'Туман ID кўрсатилиши шарт.',
            },
          });
        }

        const { cursor } = req.body;
        if (cursor && !decodeTopicKeysetCursor(cursor)) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_CURSOR',
              message: 'Курсор нотўғри ёки муддати ўтган.',
            },
          });
        }

        try {
          const page = await queryDistrictTopicsPage(db, {
            districtId,
            filter: req.body,
          });
          return reply.status(200).send(page);
        } catch (err: unknown) {
          return handleDistrictTopicsError(err, reply);
        }
      },
    );

    // 4. Get district topic evidence (GET)
    scope.get(
      '/api/v1/districts/:districtId/topics/:topicId/evidence',
      {
        schema: {
          querystring: TopicEvidenceQuerySchema,
        },
      },
      async (req, reply) => {
        const { districtId, topicId } = req.params as { districtId: string; topicId: string };
        if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
          return reply.status(400).send({
            error: {
              code: 'DISTRICT_REQUIRED',
              message: 'Туман ID кўрсатилиши шарт.',
            },
          });
        }
        if (!topicId || typeof topicId !== 'string' || topicId.trim() === '') {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Мавзу идентификатори киритилмаган.',
            },
          });
        }

        const { cursor } = req.query;
        if (cursor && !decodeEvidenceKeysetCursor(cursor)) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_CURSOR',
              message: 'Курсор нотўғри ёки муддати ўтган.',
            },
          });
        }

        try {
          const district = await db.query.districts.findFirst({
            where: eq(districts.id, districtId),
          });

          if (!district) {
            throw new DistrictNotFoundError('Туман топилмади.');
          }

          // The Product Owner is not district-bound (their own districtId is null),
          // so the district scope for this evidence read comes from the validated
          // URL param. Assert that scope explicitly instead of relying on the
          // session actor's district.
          const productOwner = req.actor;
          if (!productOwner) {
            return reply.status(401).send({
              error: {
                code: 'UNAUTHENTICATED',
                message: 'Сессия топилмади ёки муддати тугаган.',
              },
            });
          }

          const evidenceResponse = await getTopicEvidence(
            db,
            { ...productOwner, districtId },
            topicId,
            req.query,
          );
          return reply.status(200).send(evidenceResponse);
        } catch (err: unknown) {
          return handleDistrictTopicsError(err, reply);
        }
      },
    );
  });
}

function handleDistrictTopicsError(err: unknown, reply: FastifyReply) {
  if (err instanceof DistrictNotFoundError) {
    return reply.status(404).send({
      error: { code: 'DISTRICT_NOT_FOUND', message: err.message },
    });
  }

  if (err instanceof TopicNotFoundError) {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: err.message },
    });
  }

  if (err instanceof DistrictRequiredError) {
    return reply.status(400).send({
      error: { code: 'DISTRICT_REQUIRED', message: err.message },
    });
  }

  if (err instanceof InvalidCursorError) {
    return reply.status(400).send({
      error: { code: 'INVALID_CURSOR', message: err.message },
    });
  }

  if (err instanceof InvalidDateRangeError) {
    return reply.status(400).send({
      error: { code: 'INVALID_DATE_RANGE', message: err.message },
    });
  }

  if (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as { statusCode: number }).statusCode === 'number'
  ) {
    const statusCode = (err as { statusCode: number }).statusCode;
    const code =
      'code' in err && typeof (err as { code: string }).code === 'string'
        ? (err as { code: string }).code
        : 'ERROR';
    const message = err instanceof Error ? err.message : 'Хатолик юз берди.';
    return reply.status(statusCode).send({
      error: { code, message },
    });
  }

  throw err;
}
