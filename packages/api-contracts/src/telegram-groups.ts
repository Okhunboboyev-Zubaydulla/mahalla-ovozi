import { z } from 'zod';
import { DistrictIdSchema } from './common.js';

export const TelegramGroupStatusSchema = z.enum(['PENDING', 'TESTING', 'VALID', 'FAILED']);
export type TelegramGroupStatus = z.infer<typeof TelegramGroupStatusSchema>;

export const GroupTransportSchema = z.enum(['BOT_API', 'USERBOT']);
export type GroupTransport = z.infer<typeof GroupTransportSchema>;

export const TelegramGroupMappingSchema = z.object({
  id: z.string().min(1),
  districtId: DistrictIdSchema,
  mahallaName: z.string().min(1),
  telegramChatId: z.string().min(1),
  telegramChatTitle: z.string().min(1),
  telegramChatUsername: z.string().nullable(),
  status: TelegramGroupStatusSchema,
  transport: GroupTransportSchema.default('BOT_API'),
  botMembershipStatus: z.string().nullable(),
  privacyModeDisabled: z.boolean(),
  testMessageReceivedAt: z.string().datetime().nullable(),
  lastValidatedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TelegramGroupMapping = z.infer<typeof TelegramGroupMappingSchema>;

export const ListTelegramGroupsResponseSchema = z.object({
  groups: z.array(TelegramGroupMappingSchema),
});
export type ListTelegramGroupsResponse = z.infer<typeof ListTelegramGroupsResponseSchema>;

export const TELEGRAM_GROUP_CHAT_ID_REGEX = /^-(?:100\d{9,13}|[1-9]\d{5,13})$/;

export const CreateTelegramGroupRequestSchema = z.object({
  mahallaName: z
    .string({
      required_error: 'Маҳалла номи киритилиши шарт.',
      invalid_type_error: 'Маҳалла номи матн бўлиши керак.',
    })
    .trim()
    .min(1, 'Маҳалла номи киритилиши шарт.')
    .max(100, 'Маҳалла номи 100 та белгидан ошмаслиги керак.'),
  telegramChatId: z
    .string({
      required_error: 'Telegram гуруҳ Chat ID киритилиши шарт.',
      invalid_type_error: 'Telegram гуруҳ Chat ID матн бўлиши керак.',
    })
    .trim()
    .min(1, 'Telegram гуруҳ Chat ID киритилиши шарт.')
    .max(50, 'Chat ID 50 та белгидан ошмаслиги керак.')
    .regex(
      TELEGRAM_GROUP_CHAT_ID_REGEX,
      'Telegram гуруҳ Chat ID манфий рақамли форматда бўлиши шарт (масалан: -1001234567890 ёки -123456789).',
    ),
  transport: GroupTransportSchema.optional().default('BOT_API'),
});
export type CreateTelegramGroupRequest = z.input<typeof CreateTelegramGroupRequestSchema>;

export const CreateTelegramGroupResponseSchema = z.object({
  group: TelegramGroupMappingSchema,
});
export type CreateTelegramGroupResponse = z.infer<typeof CreateTelegramGroupResponseSchema>;

export const UpdateTelegramGroupRequestSchema = z
  .object({
    mahallaName: z
      .string({
        invalid_type_error: 'Маҳалла номи матн бўлиши керак.',
      })
      .trim()
      .min(1, 'Маҳалла номи бўш бўлмаслиги керак.')
      .max(100, 'Маҳалла номи 100 та белгидан ошмаслиги керак.')
      .optional(),
    telegramChatId: z
      .string({
        invalid_type_error: 'Telegram гуруҳ Chat ID матн бўлиши керак.',
      })
      .trim()
      .min(1, 'Telegram гуруҳ Chat ID бўш бўлмаслиги керак.')
      .max(50, 'Chat ID 50 та белгидан ошмаслиги керак.')
      .regex(
        TELEGRAM_GROUP_CHAT_ID_REGEX,
        'Telegram гуруҳ Chat ID манфий рақамли форматда бўлиши шарт (масалан: -1001234567890 ёки -123456789).',
      )
      .optional(),
    transport: GroupTransportSchema.optional(),
  })
  .refine(
    (data) =>
      data.mahallaName !== undefined ||
      data.telegramChatId !== undefined ||
      data.transport !== undefined,
    {
      message: 'Камида битта майдон киритилиши керак.',
      path: ['mahallaName'],
    },
  );
export type UpdateTelegramGroupRequest = z.infer<typeof UpdateTelegramGroupRequestSchema>;

export const UpdateTelegramGroupResponseSchema = z.object({
  group: TelegramGroupMappingSchema,
});
export type UpdateTelegramGroupResponse = z.infer<typeof UpdateTelegramGroupResponseSchema>;

export const DeleteTelegramGroupResponseSchema = z.object({
  success: z.boolean(),
  deletedGroupId: z.string(),
});
export type DeleteTelegramGroupResponse = z.infer<typeof DeleteTelegramGroupResponseSchema>;

export const StartGroupTestResponseSchema = z.object({
  session: z.object({
    status: z.string(),
    expiresAt: z.string().datetime(),
  }),
});
export type StartGroupTestResponse = z.infer<typeof StartGroupTestResponseSchema>;

export const GetGroupTestStatusResponseSchema = z.object({
  status: z.enum(['PENDING', 'SUCCESS', 'TIMEOUT', 'FAILED']),
  testMessageReceivedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
});
export type GetGroupTestStatusResponse = z.infer<typeof GetGroupTestStatusResponseSchema>;

export const SimulateTestMessageRequestSchema = z.object({
  message: z.record(z.unknown()),
});
export type SimulateTestMessageRequest = z.infer<typeof SimulateTestMessageRequestSchema>;

export const SimulateTestMessageResponseSchema = z.object({
  success: z.boolean(),
  accepted: z.boolean(),
  reason: z.string().optional(),
});
export type SimulateTestMessageResponse = z.infer<typeof SimulateTestMessageResponseSchema>;
