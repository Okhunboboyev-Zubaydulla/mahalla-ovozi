import { z } from 'zod';
import { QualifyingLaneSchema, type QualifyingLane } from './topics.js';
import { createKeysetPageSchema, type KeysetPage } from './pagination.js';
import { IsoDateStringSchema } from './common.js';

export type { QualifyingLane };

export const SignalProcessingStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'REJECTED']);
export type SignalProcessingStatus = z.infer<typeof SignalProcessingStatusSchema>;

export const SignalMessageListItemSchema = z.object({
  id: z.string().min(1), // Unique identifier (evidenceId or intakeId)
  intakeId: z.string().min(1),
  evidenceId: z.string().nullable(),
  districtId: z.string().min(1),
  districtName: z.string().nullable().optional(),
  mahallaName: z.string().min(1),
  calendarDay: IsoDateStringSchema,
  originalTimestamp: z.string().datetime({ offset: true }),
  contentType: z.enum(['TEXT', 'MEDIA_CAPTION']),
  verbatimText: z.string(),
  status: SignalProcessingStatusSchema.default('REJECTED'),
  isRelevant: z.boolean(),
  relevantLanes: z.array(QualifyingLaneSchema),
  exclusionReason: z.string().nullable(),
  reasoning: z.string().nullable(),
  topicId: z.string().nullable(),
  topicSummary: z.string().nullable().optional(),
  aiOperationId: z.string().nullable(),
  aiModelId: z.string().nullable().optional(),
  aiProvider: z.string().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
});
export type SignalMessageListItemDto = z.infer<typeof SignalMessageListItemSchema>;

export const ListSignalsQuerySchema = z.object({
  districtId: z.string().trim().optional(),
  mahallaName: z.string().trim().optional(),
  calendarDay: IsoDateStringSchema.optional(),
  isRelevant: z
    .union([z.boolean(), z.enum(['true', 'false', 'all'])])
    .optional()
    .transform((val) => {
      if (val === true || val === 'true') return true;
      if (val === false || val === 'false') return false;
      return undefined;
    }),
  lane: QualifyingLaneSchema.optional(),
  search: z.string().trim().optional(),
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  direction: z.enum(['forward', 'backward']).default('forward'),
});
export type ListSignalsQuery = z.infer<typeof ListSignalsQuerySchema>;

export const ListSignalsResponseSchema = createKeysetPageSchema(SignalMessageListItemSchema);
export type ListSignalsResponse = KeysetPage<SignalMessageListItemDto>;

export const SignalDetailSchema = z.object({
  signal: SignalMessageListItemSchema,
  telegramChatId: z.string().optional(),
  telegramMessageId: z.string().optional(),
  telegramUserId: z.string().nullable().optional(),
  userMetadata: z.record(z.unknown()).nullable().optional(),
  replyMetadata: z.record(z.unknown()).nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  inputTokens: z.number().int().nullable().optional(),
  outputTokens: z.number().int().nullable().optional(),
  estimatedCostUsd: z.string().nullable().optional(),
});
export type SignalDetailDto = z.infer<typeof SignalDetailSchema>;

export const PromoteSignalRequestSchema = z.object({
  lanes: z.array(QualifyingLaneSchema).min(1, 'Камида битта соҳа танланиши шарт'),
  changeReason: z
    .string()
    .min(3, 'Ўзгартириш сабаби камида 3 та белги бўлиши шарт')
    .max(500),
});
export type PromoteSignalRequest = z.infer<typeof PromoteSignalRequestSchema>;

export const ReclassifyEvidenceRequestSchema = z.object({
  lanes: z.array(QualifyingLaneSchema).min(1, 'Камида битта соҳа танланиши шарт'),
  changeReason: z
    .string()
    .min(3, 'Ўзгартириш сабаби камида 3 та белги бўлиши шарт')
    .max(500),
});
export type ReclassifyEvidenceRequest = z.infer<typeof ReclassifyEvidenceRequestSchema>;

export const UpdateEvidenceTextRequestSchema = z.object({
  verbatimText: z.string().min(1, 'Хабар матни бўш бўлиши мумкин эмас').max(4000),
  changeReason: z
    .string()
    .min(3, 'Ўзгартириш сабаби камида 3 та белги бўлиши шарт')
    .max(500),
});
export type UpdateEvidenceTextRequest = z.infer<typeof UpdateEvidenceTextRequestSchema>;

export const DeleteEvidenceRequestSchema = z.object({
  changeReason: z
    .string()
    .min(3, 'Ўчириш сабаби камида 3 та белги бўлиши шарт')
    .max(500),
});
export type DeleteEvidenceRequest = z.infer<typeof DeleteEvidenceRequestSchema>;

export const CreateManualSignalRequestSchema = z.object({
  districtId: z.string().min(1, 'Туман танланиши шарт'),
  mahallaName: z.string().min(1, 'Маҳалла номи киритилиши шарт'),
  verbatimText: z.string().min(1, 'Хабар матни бўш бўлиши мумкин эмас').max(4000),
  lanes: z.array(QualifyingLaneSchema).min(1, 'Камида битта соҳа танланиши шарт'),
  originalTimestamp: z.string().datetime({ offset: true }).optional(),
  changeReason: z
    .string()
    .min(3, 'Яратиш сабаби камида 3 та белги бўлиши шарт')
    .max(500),
});
export type CreateManualSignalRequest = z.infer<typeof CreateManualSignalRequestSchema>;

export const PromoteSignalResponseSchema = z.object({
  success: z.boolean(),
  intakeId: z.string(),
});
export type PromoteSignalResponse = z.infer<typeof PromoteSignalResponseSchema>;

export const ReclassifyEvidenceResponseSchema = z.object({
  success: z.boolean(),
  evidenceId: z.string(),
  newTopicId: z.string(),
});
export type ReclassifyEvidenceResponse = z.infer<typeof ReclassifyEvidenceResponseSchema>;

export const UpdateEvidenceTextResponseSchema = z.object({
  success: z.boolean(),
  evidenceId: z.string(),
});
export type UpdateEvidenceTextResponse = z.infer<typeof UpdateEvidenceTextResponseSchema>;

export const DeleteEvidenceResponseSchema = z.object({
  success: z.boolean(),
  deletedEvidenceId: z.string(),
  topicDeleted: z.boolean(),
});
export type DeleteEvidenceResponse = z.infer<typeof DeleteEvidenceResponseSchema>;

export const CreateManualSignalResponseSchema = z.object({
  success: z.boolean(),
  intakeId: z.string(),
});
export type CreateManualSignalResponse = z.infer<typeof CreateManualSignalResponseSchema>;

export const BatchDeleteSignalsRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'Камида битта хабар танланиши шарт'),
  changeReason: z
    .string()
    .min(3, 'Ўчириш сабаби камида 3 та белги бўлиши шарт')
    .max(500),
});
export type BatchDeleteSignalsRequest = z.infer<typeof BatchDeleteSignalsRequestSchema>;

export const BatchDeleteSignalsResponseSchema = z.object({
  success: z.boolean(),
  deletedCount: z.number().int().nonnegative(),
  topicsAffected: z.number().int().nonnegative(),
  topicsDeleted: z.number().int().nonnegative(),
});
export type BatchDeleteSignalsResponse = z.infer<typeof BatchDeleteSignalsResponseSchema>;


