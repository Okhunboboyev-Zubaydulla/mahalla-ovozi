import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  SaveDistrictAnalysisSettingsDraftSchema,
  ActivateDistrictAnalysisSettingsRequestSchema,
  RollbackDistrictAnalysisSettingsRequestSchema,
  type SaveDistrictAnalysisSettingsDraftRequest,
  type ActivateDistrictAnalysisSettingsRequest,
  type RollbackDistrictAnalysisSettingsRequest,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { districts } from '../../adapters/db/schema/districts.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import { districtAnalysisSettingsService } from './district-analysis-settings-service.js';

interface DistrictSettingsRouteParams {
  districtId: string;
}

async function findDistrictOr404(
  db: DbClient,
  districtId: string,
  reply: FastifyReply,
): Promise<{ id: string; name: string } | null> {
  const [district] = await db
    .select({ id: districts.id, name: districts.name })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    reply.status(404).send({
      error: {
        code: 'DISTRICT_NOT_FOUND',
        message: 'Туман топилмади.',
        statusCode: 404,
      },
    });
    return null;
  }

  return district;
}

export function registerDistrictAnalysisSettingsRoutes(
  server: FastifyInstance,
  db: DbClient,
): void {
  // Encapsulated Fastify scope with strict Product Owner authorization guard (AC 1, AC 9)
  server.register(async (scope) => {
    scope.addHook('preHandler', createRequireProductOwner(db));

    /**
     * GET /api/v1/ai/settings/districts/:districtId
     * Returns current active district analysis configuration and saved draft if any (AC 1, 2, 3, 4, 9).
     */
    scope.get(
      '/api/v1/ai/settings/districts/:districtId',
      async (
        req: FastifyRequest<{ Params: DistrictSettingsRouteParams }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;

        const district = await findDistrictOr404(db, districtId, reply);
        if (!district) return;

        const [activeConfiguration, draft] = await Promise.all([
          districtAnalysisSettingsService.getActiveConfiguration(db, districtId),
          districtAnalysisSettingsService.getDraft(db, districtId),
        ]);

        return reply.status(200).send({
          districtId: district.id,
          districtName: district.name,
          activeConfiguration,
          draft,
        });
      },
    );

    /**
     * POST /api/v1/ai/settings/districts/:districtId/draft
     * Validates and saves the district analysis settings draft with audit trail (AC 3, 4, 6, 7, 8, 9).
     */
    scope.post(
      '/api/v1/ai/settings/districts/:districtId/draft',
      async (
        req: FastifyRequest<{
          Params: DistrictSettingsRouteParams;
          Body: SaveDistrictAnalysisSettingsDraftRequest;
        }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;

        const district = await findDistrictOr404(db, districtId, reply);
        if (!district) return;

        const parseResult = SaveDistrictAnalysisSettingsDraftSchema.safeParse(
          req.body,
        );

        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                parseResult.error.issues[0]?.message ||
                'Киритилган созламаларда хатолик бор.',
              statusCode: 400,
              validationErrors: parseResult.error.issues.map((issue) => ({
                path: issue.path,
                message: issue.message,
                code: issue.code,
              })),
            },
          });
        }

        if (!req.actor) {
          return reply.status(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Аутентификация талаб қилинади.',
              statusCode: 401,
            },
          });
        }

        const actor = {
          id: req.actor.id,
          role: req.actor.role,
          ipAddress: req.ip || null,
          userAgent:
            typeof req.headers['user-agent'] === 'string'
              ? req.headers['user-agent']
              : null,
        };

        const savedDraft = await districtAnalysisSettingsService.saveDraft(
          db,
          districtId,
          actor,
          parseResult.data,
        );

        return reply.status(200).send({
          draft: savedDraft,
          message: 'Қоралама муваффақиятли сақланди',
        });
      },
    );

    /**
     * POST /api/v1/ai/settings/districts/:districtId/activate
     * Atomically validates, deactivates prior active version, bumps monotonic version,
     * deletes draft, and activates new immutable district analysis settings version (Story 5.3).
     */
    scope.post(
      '/api/v1/ai/settings/districts/:districtId/activate',
      async (
        req: FastifyRequest<{
          Params: DistrictSettingsRouteParams;
          Body: ActivateDistrictAnalysisSettingsRequest;
        }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;

        const district = await findDistrictOr404(db, districtId, reply);
        if (!district) return;

        const parseResult =
          ActivateDistrictAnalysisSettingsRequestSchema.safeParse(req.body);

        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                parseResult.error.issues[0]?.message ||
                'Фаоллаштириш сўровида хатолик бор.',
              statusCode: 400,
              validationErrors: parseResult.error.issues.map((issue) => ({
                path: issue.path,
                message: issue.message,
                code: issue.code,
              })),
            },
          });
        }

        if (!req.actor) {
          return reply.status(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Аутентификация талаб қилинади.',
              statusCode: 401,
            },
          });
        }

        const actor = {
          id: req.actor.id,
          role: req.actor.role,
          ipAddress: req.ip || null,
          userAgent:
            typeof req.headers['user-agent'] === 'string'
              ? req.headers['user-agent']
              : null,
        };

        try {
          const result = await districtAnalysisSettingsService.activateDraft(
            db,
            districtId,
            actor,
            parseResult.data,
          );

          return reply.status(200).send(result);
        } catch (err: any) {
          const statusCode =
            typeof err.statusCode === 'number' ? err.statusCode : 500;
          const code =
            typeof err.code === 'string' ? err.code : 'INTERNAL_SERVER_ERROR';
          const message =
            statusCode < 500 && typeof err.message === 'string'
              ? err.message
              : 'Туман созламаларини фаоллаштиришда хатолик юз берди.';

          return reply.status(statusCode).send({
            error: {
              code,
              message,
              statusCode,
            },
          });
        }
      },
    );

    /**
     * GET /api/v1/ai/settings/districts/:districtId/history
     * Returns immutable history of activated district analysis configuration versions (Story 5.4).
     */
    scope.get(
      '/api/v1/ai/settings/districts/:districtId/history',
      async (
        req: FastifyRequest<{ Params: DistrictSettingsRouteParams }>,
        reply: FastifyReply,
      ) => {
        const districtId = req.params.districtId?.trim();
        if (!districtId) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_DISTRICT_ID',
              message: 'Туман идентификатори кўрсатилиши шарт.',
              statusCode: 400,
            },
          });
        }

        try {
          const district = await findDistrictOr404(db, districtId, reply);
          if (!district) return;

          const history =
            await districtAnalysisSettingsService.getHistory(db, districtId);

          return reply.status(200).send(history);
        } catch (err: any) {
          req.log.error(
            { err, districtId },
            'Failed to fetch district analysis settings history',
          );
          return reply.status(500).send({
            error: {
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Туман созламалари тарихини юклашда хатолик юз берди.',
              statusCode: 500,
            },
          });
        }
      },
    );

    /**
     * POST /api/v1/ai/settings/districts/:districtId/rollback
     * Atomically rolls back to a target historical district configuration as a new future-only version (Story 5.4).
     */
    scope.post(
      '/api/v1/ai/settings/districts/:districtId/rollback',
      async (
        req: FastifyRequest<{
          Params: DistrictSettingsRouteParams;
          Body: RollbackDistrictAnalysisSettingsRequest;
        }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;

        const district = await findDistrictOr404(db, districtId, reply);
        if (!district) return;

        const parseResult =
          RollbackDistrictAnalysisSettingsRequestSchema.safeParse(req.body);

        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                parseResult.error.issues[0]?.message ||
                'Қайтариш сўровида хатолик бор.',
              statusCode: 400,
              validationErrors: parseResult.error.issues.map((issue) => ({
                path: issue.path,
                message: issue.message,
                code: issue.code,
              })),
            },
          });
        }

        if (!req.actor) {
          return reply.status(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Аутентификация талаб қилинади.',
              statusCode: 401,
            },
          });
        }

        const actor = {
          id: req.actor.id,
          role: req.actor.role,
          ipAddress: req.ip || null,
          userAgent:
            typeof req.headers['user-agent'] === 'string'
              ? req.headers['user-agent']
              : null,
        };

        try {
          const result = await districtAnalysisSettingsService.rollback(
            db,
            districtId,
            actor,
            parseResult.data,
          );

          return reply.status(200).send(result);
        } catch (err: any) {
          const statusCode =
            typeof err.statusCode === 'number' ? err.statusCode : 500;
          const code =
            typeof err.code === 'string' ? err.code : 'INTERNAL_SERVER_ERROR';
          const message =
            statusCode < 500 && typeof err.message === 'string'
              ? err.message
              : 'Туман созламаларини қайтаришда хатолик юз берди.';

          return reply.status(statusCode).send({
            error: {
              code,
              message,
              statusCode,
            },
          });
        }
      },
    );
  });
}


