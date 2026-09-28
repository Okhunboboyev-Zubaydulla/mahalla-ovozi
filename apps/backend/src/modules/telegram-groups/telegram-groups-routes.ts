import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  CreateTelegramGroupRequestSchema,
  UpdateTelegramGroupRequestSchema,
  SimulateTestMessageRequestSchema,
} from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import { getClientInfo } from '../auth/client-info.js';
import {
  listDistrictTelegramGroups,
  getDistrictTelegramGroup,
  createDistrictTelegramGroup,
  updateDistrictTelegramGroup,
  deleteDistrictTelegramGroup,
  TelegramGroupNotFoundError,
  MahallaNameAlreadyExistsError,
  GroupAlreadyMappedError,
  GroupAlreadyAssignedError,
  BotNotConnectedError,
  UserbotSessionNotActiveError,
} from './telegram-groups-service.js';
import {
  startGroupTestSession,
  getGroupTestStatus,
  simulateGroupTestMessage,
  handleIncomingWebhookMessage,
} from './telegram-group-engine.js';
import { DistrictNotFoundError } from '../districts/district-onboarding-engine.js';
import {
  TelegramIntegrationError,
  TelegramChatNotFoundError,
  TelegramBotNotMemberError,
  TelegramBotIsAdminError,
  TelegramPrivacyModeEnabledError,
} from '../telegram-bot/ports/telegram-client-port.js';
import { z } from 'zod';
import {
  deriveWebhookSecret,
  verifyTelegramSecretToken,
} from '../telegram-intake/webhook-security.js';

const TelegramIncomingMessageSchema = z
  .object({
    message_id: z.number().optional(),
    date: z.number().optional(),
    chat: z
      .object({
        id: z.union([z.number(), z.string()]),
        type: z.string().optional(),
        title: z.string().optional(),
      })
      .passthrough()
      .optional(),
    from: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        is_bot: z.boolean().optional(),
        first_name: z.string().optional(),
        username: z.string().optional(),
      })
      .passthrough()
      .optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
  })
  .passthrough();

const TelegramTestWebhookPayloadSchema = z
  .object({
    update_id: z.number().optional(),
    message: TelegramIncomingMessageSchema.optional(),
    channel_post: TelegramIncomingMessageSchema.optional(),
    edited_message: TelegramIncomingMessageSchema.optional(),
    edited_channel_post: TelegramIncomingMessageSchema.optional(),
  })
  .passthrough();

export function registerTelegramGroupRoutes(fastify: FastifyInstance, db: DbClient): void {
  // Public Webhook Ingress for Test Session Validation during Onboarding
  fastify.post(
    '/api/v1/telegram/webhook/:botId',
    {
      bodyLimit: 262144, // 256KB payload limit
      preHandler: async (
        req: FastifyRequest<{ Params: { botId: string } }>,
        reply: FastifyReply,
      ) => {
        const { botId } = req.params;
        const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
        const expectedSecret = deriveWebhookSecret(botId);

        if (!verifyTelegramSecretToken(secretHeader, expectedSecret)) {
          return reply.status(401).send({
            error: {
              code: 'UNAUTHORIZED_WEBHOOK',
              message: 'Ноқонуний Telegram webhook сўрови.',
            },
          });
        }
      },
    },
    async (
      req: FastifyRequest<{ Params: { botId: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const { botId } = req.params;

      const parseResult = TelegramTestWebhookPayloadSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Нотуғри Telegram update формати.',
          },
        });
      }

      try {
        const result = await handleIncomingWebhookMessage(db, botId, parseResult.data);
        if (result.handled) {
          return reply.status(200).send({ ok: true, result });
        }
        return reply
          .status(200)
          .send({ ok: true, message: 'Message ignored or not for test session' });
      } catch (err) {
        req.log.error({ err, botId }, 'Failed to process Telegram onboarding test message');
        return reply.status(500).send({
          error: {
            code: 'WEBHOOK_PROCESSING_FAILED',
            message: 'Тест хабарини қабул қилишда хатолик юз берди.',
          },
        });
      }
    },
  );

  // Authenticated Product Owner Routes
  fastify.register(async (scope) => {
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireProductOwner(db));

    // 1. GET /api/v1/districts/:districtId/groups
    scope.get(
      '/api/v1/districts/:districtId/groups',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        try {
          const groups = await listDistrictTelegramGroups(db, districtId);
          return reply.status(200).send({ groups });
        } catch (err: unknown) {
          return handleGroupRouteError(err, reply);
        }
      },
    );

    // 2. GET /api/v1/districts/:districtId/groups/:groupId
    scope.get(
      '/api/v1/districts/:districtId/groups/:groupId',
      async (
        req: FastifyRequest<{ Params: { districtId: string; groupId: string } }>,
        reply: FastifyReply,
      ) => {
        const { districtId, groupId } = req.params;
        try {
          const group = await getDistrictTelegramGroup(db, districtId, groupId);
          return reply.status(200).send({ group });
        } catch (err: unknown) {
          return handleGroupRouteError(err, reply);
        }
      },
    );

    // 3. POST /api/v1/districts/:districtId/groups
    scope.post(
      '/api/v1/districts/:districtId/groups',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = CreateTelegramGroupRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Маълумотлар нотўғри киритилди.',
            },
          });
        }

        try {
          const group = await createDistrictTelegramGroup(
            db,
            districtId,
            parseResult.data,
            req.actor,
            getClientInfo(req),
          );
          return reply.status(201).send({ group });
        } catch (err: unknown) {
          return handleGroupRouteError(err, reply);
        }
      },
    );

    // 4. PUT /api/v1/districts/:districtId/groups/:groupId
    scope.put(
      '/api/v1/districts/:districtId/groups/:groupId',
      async (
        req: FastifyRequest<{ Params: { districtId: string; groupId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId, groupId } = req.params;
        const parseResult = UpdateTelegramGroupRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Маълумотлар нотўғри киритилди.',
            },
          });
        }

        try {
          const group = await updateDistrictTelegramGroup(
            db,
            districtId,
            groupId,
            parseResult.data,
            req.actor,
            getClientInfo(req),
          );
          return reply.status(200).send({ group });
        } catch (err: unknown) {
          return handleGroupRouteError(err, reply);
        }
      },
    );

    // 5. DELETE /api/v1/districts/:districtId/groups/:groupId
    scope.delete(
      '/api/v1/districts/:districtId/groups/:groupId',
      async (
        req: FastifyRequest<{ Params: { districtId: string; groupId: string } }>,
        reply: FastifyReply,
      ) => {
        const { districtId, groupId } = req.params;
        try {
          const result = await deleteDistrictTelegramGroup(
            db,
            districtId,
            groupId,
            req.actor,
            getClientInfo(req),
          );
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleGroupRouteError(err, reply);
        }
      },
    );

    // 6. POST /api/v1/districts/:districtId/groups/:groupId/start-test
    scope.post(
      '/api/v1/districts/:districtId/groups/:groupId/start-test',
      async (
        req: FastifyRequest<{ Params: { districtId: string; groupId: string } }>,
        reply: FastifyReply,
      ) => {
        const { districtId, groupId } = req.params;
        try {
          const result = await startGroupTestSession(db, districtId, groupId, req.actor);
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleGroupRouteError(err, reply);
        }
      },
    );

    // 7. GET /api/v1/districts/:districtId/groups/:groupId/test-status
    scope.get(
      '/api/v1/districts/:districtId/groups/:groupId/test-status',
      async (
        req: FastifyRequest<{ Params: { districtId: string; groupId: string } }>,
        reply: FastifyReply,
      ) => {
        const { districtId, groupId } = req.params;
        try {
          const result = await getGroupTestStatus(
            db,
            districtId,
            groupId,
            req.actor,
            getClientInfo(req),
          );
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleGroupRouteError(err, reply);
        }
      },
    );

    // 8. POST /api/v1/districts/:districtId/groups/:groupId/simulate-test-message (Non-production only)
    scope.post(
      '/api/v1/districts/:districtId/groups/:groupId/simulate-test-message',
      async (
        req: FastifyRequest<{ Params: { districtId: string; groupId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        if (process.env.NODE_ENV === 'production') {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN_IN_PRODUCTION',
              message: 'Симуляция фақат синов муҳитида рухсат этилган.',
            },
          });
        }

        const { districtId, groupId } = req.params;
        const parseResult = SimulateTestMessageRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Симуляция хабари нотўғри форматда.',
            },
          });
        }

        try {
          const result = await simulateGroupTestMessage(
            db,
            districtId,
            groupId,
            parseResult.data.message,
            req.actor,
            getClientInfo(req),
          );
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return handleGroupRouteError(err, reply);
        }
      },
    );
  });
}

function handleGroupRouteError(err: unknown, reply: FastifyReply) {
  if (err instanceof DistrictNotFoundError) {
    return reply.status(404).send({
      error: { code: 'DISTRICT_NOT_FOUND', message: err.message },
    });
  }

  if (err instanceof TelegramGroupNotFoundError) {
    return reply.status(404).send({
      error: { code: 'TELEGRAM_GROUP_NOT_FOUND', message: err.message },
    });
  }

  if (err instanceof MahallaNameAlreadyExistsError) {
    return reply.status(409).send({
      error: { code: 'MAHALLA_NAME_EXISTS', message: err.message },
    });
  }

  if (err instanceof GroupAlreadyMappedError) {
    return reply.status(409).send({
      error: { code: 'GROUP_ALREADY_MAPPED', message: err.message },
    });
  }

  if (err instanceof GroupAlreadyAssignedError) {
    return reply.status(409).send({
      error: { code: 'GROUP_ALREADY_ASSIGNED', message: err.message },
    });
  }

  if (err instanceof BotNotConnectedError) {
    return reply.status(400).send({
      error: { code: 'TELEGRAM_BOT_NOT_FOUND', message: err.message },
    });
  }

  if (err instanceof UserbotSessionNotActiveError) {
    return reply.status(400).send({
      error: { code: 'USERBOT_SESSION_NOT_ACTIVE', message: err.message },
    });
  }

  if (err instanceof TelegramChatNotFoundError) {
    return reply.status(400).send({
      error: { code: 'BOT_NOT_IN_GROUP', message: err.message },
    });
  }

  if (err instanceof TelegramBotNotMemberError) {
    return reply.status(400).send({
      error: { code: 'BOT_NOT_IN_GROUP', message: err.message },
    });
  }

  if (err instanceof TelegramBotIsAdminError) {
    return reply.status(400).send({
      error: { code: 'BOT_IS_ADMIN_FORBIDDEN', message: err.message },
    });
  }

  if (err instanceof TelegramPrivacyModeEnabledError) {
    return reply.status(400).send({
      error: { code: 'TELEGRAM_PRIVACY_MODE_ENABLED', message: err.message },
    });
  }

  // All TelegramIntegrationError subclasses (TelegramInvalidTokenError,
  // TelegramNetworkTimeoutError, TelegramRateLimitError, TelegramApiError, etc.)
  // carry httpStatus and code on the base class — no need to list each subclass.
  if (err instanceof TelegramIntegrationError) {
    return reply.status(err.httpStatus).send({
      error: { code: err.code, message: err.message },
    });
  }

  throw err;
}
