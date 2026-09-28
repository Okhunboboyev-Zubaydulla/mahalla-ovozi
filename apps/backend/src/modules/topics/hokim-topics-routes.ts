import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  HokimTopicBoardQuerySchema,
  HokimLaneQuerySchema,
  TopicEvidenceQuerySchema,
  HokimTopicStatisticsQuerySchema,
  HokimTopicBoardSearchBodySchema,
  HokimLaneSearchBodySchema,
  HokimTopicStatisticsSearchBodySchema,
  decodeKeysetCursor,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import { createRequireHokim } from '../auth/require-hokim.js';
import {
  queryHokimBoard,
  queryHokimLaneBatch,
  queryDistrictMahallas,
  queryHokimStatistics,
  decodeTopicKeysetCursor,
  InvalidCursorError,
} from './topic-query-engine.js';
import {
  getTopicEvidence,
  TopicNotFoundError,
  decodeEvidenceKeysetCursor,
} from './topic-evidence-service.js';
import { isDistrictScopedActor, type DistrictScopedActor } from '@mahalla-ovozi/api-contracts';

/**
 * Resolves the authenticated actor to a district-scoped actor, or answers the
 * request and returns null.
 *
 * Every route in this file operates on a single district, so the district scope
 * is a precondition rather than something each handler re-checks. Answering here
 * keeps the 401/403 envelopes identical across all eight routes and lets the
 * compiler carry the narrowing instead of an inline cast at each call site.
 */
function resolveDistrictActor(
  req: FastifyRequest,
  reply: FastifyReply,
): DistrictScopedActor | null {
  if (!req.actor) {
    reply.status(401).send({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Сессия топилмади ёки муддати тугаган.',
      },
    });
    return null;
  }

  if (!isDistrictScopedActor(req.actor)) {
    reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'Ушбу амални бажариш учун туман кўрсатилиши шарт.',
      },
    });
    return null;
  }

  return req.actor;
}

export function registerHokimTopicsRoutes(fastify: FastifyInstance, db: DbClient): void {
  fastify.register(async (instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireHokim(db));

    // 1. Get district mahallas list (sorted uz-Cyrl)
    scope.get(
      '/api/v1/hokim/topics/mahallas',
      async (req, reply) => {
        const actor = resolveDistrictActor(req, reply);
        if (!actor) {
          return;
        }

        try {
          const mahallas = await queryDistrictMahallas(db, actor.districtId);
          return reply.status(200).send({ mahallas });
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : 'Маҳаллалар рўйхатини юклашда хатолик юз берди.';
          return reply.status(400).send({
            error: {
              code: 'MAHALLAS_QUERY_ERROR',
              message,
            },
          });
        }
      },
    );

    // 2. Get today's or filtered 5-lane topic board
    scope.get(
      '/api/v1/hokim/topics/board',
      {
        schema: {
          querystring: HokimTopicBoardQuerySchema,
        },
      },
      async (req, reply) => {
        const actor = resolveDistrictActor(req, reply);
        if (!actor) {
          return;
        }

        try {
          const board = await queryHokimBoard(
            db,
            actor,
            req.query,
          );
          return reply.status(200).send(board);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Мавзулар тахтасини юклашда хатолик юз берди.';
          return reply.status(400).send({
            error: {
              code: 'TOPIC_BOARD_ERROR',
              message,
            },
          });
        }
      },
    );

    // 3. Get paginated batch for a specific lane
    scope.get(
      '/api/v1/hokim/topics/lane',
      {
        schema: {
          querystring: HokimLaneQuerySchema,
        },
      },
      async (req, reply) => {
        const actor = resolveDistrictActor(req, reply);
        if (!actor) {
          return;
        }

        const { cursor } = req.query;

        if (cursor && (!decodeKeysetCursor(cursor) || !decodeTopicKeysetCursor(cursor))) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_CURSOR',
              message: 'Курсор нотўғри ёки муддати ўтган.',
            },
          });
        }

        try {
          const laneBatch = await queryHokimLaneBatch(db, {
            actorContext: actor,
            ...req.query,
          });

          return reply.status(200).send(laneBatch);
        } catch (err: unknown) {
          if (err instanceof InvalidCursorError) {
            return reply.status(400).send({
              error: {
                code: 'INVALID_CURSOR',
                message: err.message,
              },
            });
          }
          const message = err instanceof Error ? err.message : 'Йўналиш маълумотларини юклашда хатолик юз берди.';
          return reply.status(400).send({
            error: {
              code: 'LANE_QUERY_ERROR',
              message,
            },
          });
        }
      },
    );

    // 4. Get complete retained evidence for a specific topic (AC 1-6)
    scope.get(
      '/api/v1/hokim/topics/:id/evidence',
      {
        schema: {
          querystring: TopicEvidenceQuerySchema,
        },
      },
      async (req, reply) => {
        const actor = resolveDistrictActor(req, reply);
        if (!actor) {
          return;
        }

        const topicId = (req.params as { id: string }).id;
        if (!topicId || typeof topicId !== 'string') {
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
          const evidenceResponse = await getTopicEvidence(
            db,
            actor,
            topicId,
            req.query,
          );

          return reply.status(200).send(evidenceResponse);
        } catch (err: unknown) {
          if (
            err instanceof TopicNotFoundError ||
            (typeof err === 'object' && err !== null && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404)
          ) {
            const message =
              err instanceof Error ? err.message : 'Мавзу топилмади ёки ушбу туманга тегишли эмас.';
            return reply.status(404).send({
              error: {
                code: 'NOT_FOUND',
                message,
              },
            });
          }
          const message =
            err instanceof Error ? err.message : 'Далилларни юклашда хатолик юз берди.';
          return reply.status(400).send({
            error: {
              code: 'EVIDENCE_QUERY_ERROR',
              message,
            },
          });
        }
      },
    );

    // 5. Get compact neutral statistics for active scope
    scope.get(
      '/api/v1/hokim/topics/statistics',
      {
        schema: {
          querystring: HokimTopicStatisticsQuerySchema,
        },
      },
      async (req, reply) => {
        const actor = resolveDistrictActor(req, reply);
        if (!actor) {
          return;
        }

        try {
          const statistics = await queryHokimStatistics(
            db,
            actor,
            req.query,
          );
          return reply.status(200).send(statistics);
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : 'Статистика маълумотларини юклашда хатолик юз берди.';
          return reply.status(400).send({
            error: {
              code: 'STATISTICS_QUERY_ERROR',
              message,
            },
          });
        }
      },
    );

    // 6. Search 5-lane topic board via validated POST request body (AD-09, AD-10)
    scope.post(
      '/api/v1/hokim/topics/board/search',
      {
        schema: {
          body: HokimTopicBoardSearchBodySchema,
        },
      },
      async (req, reply) => {
        const actor = resolveDistrictActor(req, reply);
        if (!actor) {
          return;
        }

        try {
          const board = await queryHokimBoard(
            db,
            actor,
            req.body,
          );
          return reply.status(200).send(board);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Мавзулар бўйича қидирувда хатолик юз берди.';
          return reply.status(400).send({
            error: {
              code: 'TOPIC_BOARD_SEARCH_ERROR',
              message,
            },
          });
        }
      },
    );

    // 7. Search paginated batch for a specific lane via validated POST request body (AD-09, AD-10)
    scope.post(
      '/api/v1/hokim/topics/lane/search',
      {
        schema: {
          body: HokimLaneSearchBodySchema,
        },
      },
      async (req, reply) => {
        const actor = resolveDistrictActor(req, reply);
        if (!actor) {
          return;
        }

        const { cursor } = req.body;

        if (cursor && (!decodeKeysetCursor(cursor) || !decodeTopicKeysetCursor(cursor))) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_CURSOR',
              message: 'Курсор нотўғри ёки муддати ўтган.',
            },
          });
        }

        try {
          const laneBatch = await queryHokimLaneBatch(db, {
            actorContext: actor,
            ...req.body,
          });

          return reply.status(200).send(laneBatch);
        } catch (err: unknown) {
          if (err instanceof InvalidCursorError) {
            return reply.status(400).send({
              error: {
                code: 'INVALID_CURSOR',
                message: err.message,
              },
            });
          }
          const message = err instanceof Error ? err.message : 'Йўналиш бўйича қидирувда хатолик юз берди.';
          return reply.status(400).send({
            error: {
              code: 'LANE_SEARCH_ERROR',
              message,
            },
          });
        }
      },
    );

    // 8. Search compact neutral statistics for active scope via validated POST request body (AD-09, AD-10)
    scope.post(
      '/api/v1/hokim/topics/statistics/search',
      {
        schema: {
          body: HokimTopicStatisticsSearchBodySchema,
        },
      },
      async (req, reply) => {
        const actor = resolveDistrictActor(req, reply);
        if (!actor) {
          return;
        }

        try {
          const statistics = await queryHokimStatistics(
            db,
            actor,
            req.body,
          );
          return reply.status(200).send(statistics);
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : 'Статистика бўйича қидирувда хатолик юз берди.';
          return reply.status(400).send({
            error: {
              code: 'STATISTICS_SEARCH_ERROR',
              message,
            },
          });
        }
      },
    );
  });
}


