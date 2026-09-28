import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ConnectTelegramBotRequestSchema } from '@mahalla-ovozi/api-contracts';
import { DbClient } from '../../adapters/db/client.js';
import { verifyStateChangingOrigin } from '../auth/origin-guard.js';
import { createRequireProductOwner } from '../auth/require-product-owner.js';
import { getClientInfo } from '../auth/client-info.js';
import {
  getDistrictTelegramBot,
  connectDistrictTelegramBot,
  disconnectDistrictTelegramBot,
  BotAlreadyAssignedError,
  TelegramBotNotFoundError,
  DistrictCancelledError,
} from './telegram-bot-service.js';
import {
  DistrictNotFoundError,
  DistrictAlreadyActiveError,
} from '../districts/districts-service.js';
import { TelegramIntegrationError } from './ports/telegram-client-port.js';

export function registerTelegramBotRoutes(fastify: FastifyInstance, db: DbClient): void {
  fastify.register(async (scope) => {
    scope.addHook('preHandler', verifyStateChangingOrigin);
    scope.addHook('preHandler', createRequireProductOwner(db));

    // 1. GET /api/v1/districts/:districtId/telegram-bot
    scope.get(
      '/api/v1/districts/:districtId/telegram-bot',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        try {
          const bot = await getDistrictTelegramBot(db, districtId);
          return reply.status(200).send({ bot });
        } catch (err: unknown) {
          return handleTelegramBotError(err, reply);
        }
      },
    );

    // 2. POST /api/v1/districts/:districtId/telegram-bot
    scope.post(
      '/api/v1/districts/:districtId/telegram-bot',
      async (
        req: FastifyRequest<{ Params: { districtId: string }; Body: unknown }>,
        reply: FastifyReply,
      ) => {
        const { districtId } = req.params;
        const parseResult = ConnectTelegramBotRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: parseResult.error.errors[0]?.message || 'Telegram бот токени нотўғри.',
            },
          });
        }

        try {
          const bot = await connectDistrictTelegramBot(
            db,
            districtId,
            parseResult.data.token,
            req.actor,
            getClientInfo(req),
          );
          return reply.status(200).send({ bot });
        } catch (err: unknown) {
          return handleTelegramBotError(err, reply);
        }
      },
    );

    // 3. DELETE /api/v1/districts/:districtId/telegram-bot
    scope.delete(
      '/api/v1/districts/:districtId/telegram-bot',
      async (req: FastifyRequest<{ Params: { districtId: string } }>, reply: FastifyReply) => {
        const { districtId } = req.params;
        try {
          const result = await disconnectDistrictTelegramBot(
            db,
            districtId,
            req.actor,
            getClientInfo(req),
          );
          return reply.status(200).send({
            success: true,
            disconnectedBotId: result.disconnectedBotId,
          });
        } catch (err: unknown) {
          return handleTelegramBotError(err, reply);
        }
      },
    );
  });
}

function handleTelegramBotError(err: unknown, reply: FastifyReply) {
  if (err instanceof DistrictNotFoundError) {
    return reply.status(404).send({
      error: { code: 'DISTRICT_NOT_FOUND', message: err.message },
    });
  }

  if (err instanceof DistrictAlreadyActiveError) {
    return reply.status(409).send({
      error: { code: 'DISTRICT_ALREADY_ACTIVE', message: err.message },
    });
  }

  if (err instanceof DistrictCancelledError) {
    return reply.status(409).send({
      error: { code: 'DISTRICT_CANCELLED', message: err.message },
    });
  }

  if (err instanceof BotAlreadyAssignedError) {
    return reply.status(409).send({
      error: { code: 'BOT_ALREADY_ASSIGNED', message: err.message },
    });
  }

  if (err instanceof TelegramBotNotFoundError) {
    return reply.status(404).send({
      error: { code: 'TELEGRAM_BOT_NOT_FOUND', message: err.message },
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
