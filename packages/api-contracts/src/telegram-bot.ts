import { z } from 'zod';
import { DistrictIdSchema } from './common.js';

export const TelegramBotStatusSchema = z.enum(['VALID', 'INVALID']);
export type TelegramBotStatus = z.infer<typeof TelegramBotStatusSchema>;

export const TelegramBotInfoSchema = z.object({
  id: z.string().min(1),
  districtId: DistrictIdSchema,
  botId: z.string().min(1),
  botUsername: z.string().nullable(),
  botFirstName: z.string().min(1),
  tokenMasked: z.string().min(1),
  status: TelegramBotStatusSchema,
  lastValidatedAt: z.string().datetime(), // ISO 8601 UTC
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TelegramBotInfo = z.infer<typeof TelegramBotInfoSchema>;

export const TELEGRAM_BOT_TOKEN_REGEX = /^\d{6,16}:[a-zA-Z0-9_-]{20,50}$/;

export const ConnectTelegramBotRequestSchema = z.object({
  token: z
    .string({
      required_error: 'Telegram бот токени киритилиши шарт.',
      invalid_type_error: 'Telegram бот токени матн кўринишида бўлиши керак.',
    })
    .trim()
    .min(1, 'Telegram бот токени киритилиши шарт.')
    .max(100, 'Telegram бот токени 100 та белгидан ошмаслиги керак.')
    .regex(
      TELEGRAM_BOT_TOKEN_REGEX,
      'Telegram бот токени нотўғри форматда (масалан: 123456789:ABCdefGHIjkl...).',
    ),
});
export type ConnectTelegramBotRequest = z.infer<typeof ConnectTelegramBotRequestSchema>;

export const GetTelegramBotResponseSchema = z.object({
  bot: TelegramBotInfoSchema.nullable(),
});
export type GetTelegramBotResponse = z.infer<typeof GetTelegramBotResponseSchema>;

export const ConnectTelegramBotResponseSchema = z.object({
  bot: TelegramBotInfoSchema,
});
export type ConnectTelegramBotResponse = z.infer<typeof ConnectTelegramBotResponseSchema>;

export const DisconnectTelegramBotResponseSchema = z.object({
  success: z.boolean(),
  disconnectedBotId: z.string(),
});
export type DisconnectTelegramBotResponse = z.infer<typeof DisconnectTelegramBotResponseSchema>;
