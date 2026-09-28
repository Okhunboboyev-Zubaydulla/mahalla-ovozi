import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import type { DbClient } from '../../adapters/db/client.js';
import { createDbClient } from '../../adapters/db/client.js';
import { globalTestSessionManager } from '../telegram-groups/telegram-test-session-store.js';
import { handleIncomingWebhookMessage } from '../telegram-groups/telegram-group-engine.js';
import {
  deriveWebhookSecret,
  verifyTelegramSecretToken,
  sanitizeDriverError,
} from './webhook-security.js';
import {
  processTelegramWebhookUpdate,
  TelegramUpdate,
} from './telegram-intake-service.js';
import type { TelegramMessage } from '../../adapters/telegram/telegram-types.js';

export interface TelegramIntakeRoutesOptions {
  pool: pg.Pool;
  boss: PgBoss;
  db?: DbClient;
}

export function registerTelegramIntakeRoutes(
  fastify: FastifyInstance,
  options: TelegramIntakeRoutesOptions,
): void {
  fastify.post(
    '/api/v1/webhooks/telegram/:botId',
    {
      bodyLimit: 262144, // 256KB max payload limit for Telegram webhook updates
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
      req: FastifyRequest<{ Params: { botId: string }; Body: TelegramUpdate }>,
      reply: FastifyReply,
    ) => {
      const { botId } = req.params;
      const startTime = performance.now();

      // Check for active onboarding test session on this chat
      const raw = req.body as {
        message?: TelegramMessage;
        channel_post?: TelegramMessage;
        edited_message?: TelegramMessage;
        edited_channel_post?: TelegramMessage;
      };

      const rawMsg =
        raw?.message ??
        raw?.channel_post ??
        raw?.edited_message ??
        raw?.edited_channel_post;

      const chatId = rawMsg?.chat?.id != null ? String(rawMsg.chat.id) : null;

      if (chatId) {
        const activeSession = globalTestSessionManager.findActiveSessionByChatId(chatId);
        if (activeSession) {
          try {
            const db = options.db || createDbClient(options.pool);
            const testResult = await handleIncomingWebhookMessage(db, botId, req.body);
            if (testResult.handled) {
              const durationMs = Math.round(performance.now() - startTime);
              if (testResult.accepted) {
                console.log('[telemetry:telegram-intake-test-session]', {
                  event: 'TELEGRAM_TEST_SESSION_ACCEPTED',
                  botId,
                  chatId,
                  groupId: activeSession.groupId,
                  districtId: activeSession.districtId,
                  durationMs,
                  latencyMs: durationMs,
                });

                return reply.status(200).send({
                  ok: true,
                  status: 'ACCEPTED_TEST_SESSION',
                  result: testResult,
                });
              }

              console.log('[telemetry:telegram-intake-test-session]', {
                event: 'TELEGRAM_TEST_SESSION_REJECTED_CONTENT',
                botId,
                chatId,
                groupId: activeSession.groupId,
                reason: testResult.reason,
                durationMs,
                latencyMs: durationMs,
              });

              return reply.status(200).send({
                ok: true,
                status: 'IGNORED_TEST_UPDATE',
                reason: testResult.reason,
              });
            }
          } catch (err: unknown) {
            req.log.error({ err, botId, chatId }, 'Failed processing test session update');
          }
        }
      }

      try {
        const result = await processTelegramWebhookUpdate(
          options.pool,
          options.boss,
          botId,
          req.body,
        );

        const durationMs = Math.round(performance.now() - startTime);

        if (result.status === 'ACCEPTED') {
          // Privacy-safe telemetry logging: strictly no message text, captions, or tokens
          console.log('[telemetry:telegram-intake]', {
            event: 'TELEGRAM_INTAKE',
            botId,
            districtId: result.districtId,
            mahallaName: result.mahallaName,
            chatId: result.chatId,
            messageId: result.messageId,
            status: 'ACCEPTED',
            intakeId: result.intakeId,
            jobId: result.jobId,
            durationMs,
            latencyMs: durationMs,
          });

          return reply.status(200).send({
            ok: true,
            status: 'ACCEPTED',
            intakeId: result.intakeId,
          });
        }

        if (result.status === 'UPDATED') {
          console.log('[telemetry:telegram-intake]', {
            event: 'TELEGRAM_INTAKE_UPDATED',
            botId,
            districtId: result.districtId,
            mahallaName: result.mahallaName,
            chatId: result.chatId,
            messageId: result.messageId,
            status: 'UPDATED',
            intakeId: result.intakeId,
            jobId: result.jobId,
            durationMs,
            latencyMs: durationMs,
          });

          return reply.status(200).send({
            ok: true,
            status: 'UPDATED',
            intakeId: result.intakeId,
          });
        }

        if (result.status === 'DUPLICATE') {
          console.log('[telemetry:telegram-intake]', {
            event: 'TELEGRAM_INTAKE_DUPLICATE',
            botId,
            districtId: result.districtId,
            mahallaName: result.mahallaName,
            chatId: result.chatId,
            messageId: result.messageId,
            status: 'DUPLICATE',
            durationMs,
            latencyMs: durationMs,
          });

          return reply.status(200).send({
            ok: true,
            status: 'DUPLICATE',
          });
        }

        // result.status === 'DROPPED'
        console.log('[telemetry:telegram-intake]', {
          event: 'TELEGRAM_INTAKE_DROPPED',
          botId,
          reason: result.reason,
          chatId: result.chatId,
          messageId: result.messageId,
          status: 'DROPPED',
          durationMs,
          latencyMs: durationMs,
        });

        return reply.status(200).send({
          ok: true,
          status: 'DROPPED',
          reason: result.reason,
        });
      } catch (err: unknown) {
        const durationMs = Math.round(performance.now() - startTime);
        const { errorName, errorMessage } = sanitizeDriverError(err);

        console.error('[telemetry:telegram-intake-error]', {
          event: 'TELEGRAM_INTAKE_ERROR',
          botId,
          errorName,
          errorMessage,
          durationMs,
          latencyMs: durationMs,
        });

        // 500 prompts Telegram to retry delivery for retryable/transient persistence errors
        return reply.status(500).send({
          error: {
            code: 'INTAKE_PERSISTENCE_FAILED',
            message: 'Хабарни қабул қилишда хатолик юз берди.',
          },
        });
      }
    },
  );
}
