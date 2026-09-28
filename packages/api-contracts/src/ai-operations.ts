import { z } from 'zod';
import {
  createKeysetPageSchema,
  type KeysetPage,
  type KeysetCursorPayload,
} from './pagination.js';
import { IsoDateStringSchema, DistrictIdSchema } from './common.js';

export const AiOperationErrorCodeSchema = z.enum([
  'RATE_LIMIT_EXCEEDED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_SERVER_ERROR',
  'NETWORK_ERROR',
  'INVALID_OUTPUT_SYNTAX',
  'INVALID_OUTPUT_SEMANTICS',
  'CONTEXT_LIMIT_EXCEEDED',
  'PROVIDER_REFUSAL',
  'AUTHENTICATION_ERROR',
  'STALE_SNAPSHOT',
  'PROFILE_NOT_FOUND',
  'CIRCUIT_OPEN',
]);
export type AiOperationErrorCode = z.infer<typeof AiOperationErrorCodeSchema>;

export const AiOperationTypeSchema = z.enum([
  'SEMANTIC_RELEVANCE',
  'TOPIC_MATCHING',
  'TOPIC_DERIVED_PROJECTION',
]);
export type AiOperationType = z.infer<typeof AiOperationTypeSchema>;

export const AiOperationStatusSchema = z.enum([
  'COMPLETED_RELEVANT',
  'COMPLETED_IRRELEVANT',
  'COMPLETED_MATCHED',
  'COMPLETED_NEW_TOPIC',
  'COMPLETED',
  'FAILED_EXPLICIT',
  'STALE',
]);
export type AiOperationStatus = z.infer<typeof AiOperationStatusSchema>;

export const AiProviderAttemptStatusSchema = z.enum([
  'SUCCESS',
  'ERROR',
  'TIMEOUT',
  'REFUSAL',
]);
export type AiProviderAttemptStatus = z.infer<typeof AiProviderAttemptStatusSchema>;

export const AiProviderAttemptSchema = z.object({
  id: z.string().min(1),
  operationId: z.string().min(1),
  attemptNumber: z.number().int().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  providerRequestId: z.string().nullable().optional(),
  durationMs: z.number().int().min(0),
  inputTokens: z.number().int().nullable().optional(),
  outputTokens: z.number().int().nullable().optional(),
  cachedTokens: z.number().int().nullable().optional(),
  estimatedCostUsd: z.string().nullable().optional(),
  status: AiProviderAttemptStatusSchema,
  errorCode: AiOperationErrorCodeSchema.nullable().optional(),
  sanitizedErrorMessage: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
});
export type AiProviderAttemptDto = z.infer<typeof AiProviderAttemptSchema>;

export const AiProfileSummarySchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
  operationType: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  promptVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  temperature: z.number().min(0),
  maxOutputTokens: z.number().int().min(1),
  timeoutMs: z.number().int().min(1),
  retryPolicy: z.record(z.unknown()).nullable().optional(),
  capabilities: z.record(z.unknown()).nullable().optional(),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
});
export type AiProfileSummaryDto = z.infer<typeof AiProfileSummarySchema>;

export const AiOperationListItemSchema = z.object({
  id: z.string().min(1),
  districtId: DistrictIdSchema,
  mahallaName: z.string().min(1),
  calendarDay: IsoDateStringSchema,
  operationType: AiOperationTypeSchema,
  targetId: z.string().min(1),
  pinnedProfileId: z.string().min(1),
  contextRevision: z.number().int().min(0),
  snapshotFingerprint: z.string().min(1),
  finalStatus: AiOperationStatusSchema,
  attemptCount: z.number().int().min(0),
  totalCostUsd: z.number().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AiOperationListItemDto = z.infer<typeof AiOperationListItemSchema>;

export const AiOperationDetailSchema = z.object({
  operation: z.object({
    id: z.string().min(1),
    districtId: DistrictIdSchema,
    mahallaName: z.string().min(1),
    calendarDay: IsoDateStringSchema,
    operationType: AiOperationTypeSchema,
    targetId: z.string().min(1),
    pinnedProfileId: z.string().min(1),
    contextRevision: z.number().int().min(0),
    snapshotFingerprint: z.string().min(1),
    finalStatus: AiOperationStatusSchema,
    resultPayload: z.record(z.unknown()).nullable().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  profile: AiProfileSummarySchema,
  attempts: z.array(AiProviderAttemptSchema),
});
export type AiOperationDetailDto = z.infer<typeof AiOperationDetailSchema>;

export const AiOperationHealthMetricsSchema = z.object({
  totalOperations: z.number().int().min(0),
  operationsByType: z.record(z.string(), z.number().int().min(0)),
  operationsByStatus: z.record(z.string(), z.number().int().min(0)),
  totalAttempts: z.number().int().min(0),
  attemptsByStatus: z.record(z.string(), z.number().int().min(0)),
  attemptsByErrorCode: z.record(z.string(), z.number().int().min(0)),
  staleSnapshotCount: z.number().int().min(0),
  contextOverflowCount: z.number().int().min(0),
  refusalCount: z.number().int().min(0),
  timeoutCount: z.number().int().min(0),
  validationFailureCount: z.number().int().min(0),
  totalInputTokens: z.number().int().min(0),
  totalOutputTokens: z.number().int().min(0),
  totalCachedTokens: z.number().int().min(0),
  totalEstimatedCostUsd: z.number().min(0),
  avgDurationMs: z.number().min(0),
  p95DurationMs: z.number().min(0),
});
export type AiOperationHealthMetricsDto = z.infer<typeof AiOperationHealthMetricsSchema>;

export const ListAiOperationsQuerySchema = z.object({
  mahallaName: z.string().trim().optional(),
  calendarDay: IsoDateStringSchema.optional(),
  operationType: AiOperationTypeSchema.optional(),
  finalStatus: AiOperationStatusSchema.optional(),
  targetId: z.string().trim().optional(),
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  direction: z.enum(['forward', 'backward']).default('forward'),
});
export type ListAiOperationsQuery = z.infer<typeof ListAiOperationsQuerySchema>;

export const ListGlobalAiOperationsQuerySchema = ListAiOperationsQuerySchema.extend({
  districtId: z.string().trim().optional(),
});
export type ListGlobalAiOperationsQuery = z.infer<typeof ListGlobalAiOperationsQuerySchema>;

export const ListAiOperationsResponseSchema = createKeysetPageSchema(AiOperationListItemSchema);
export type ListAiOperationsResponse = KeysetPage<AiOperationListItemDto>;

export interface AiOperationKeysetCursorPayload extends KeysetCursorPayload {
  id: string;
  createdAt: string;
}

export const GetAiOperationResponseSchema = z.object({
  operation: AiOperationDetailSchema,
});
export type GetAiOperationResponse = z.infer<typeof GetAiOperationResponseSchema>;

export const GetAiHealthMetricsQuerySchema = z.object({
  districtId: z.string().trim().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
export type GetAiHealthMetricsQuery = z.infer<typeof GetAiHealthMetricsQuerySchema>;

export const GetAiHealthMetricsResponseSchema = z.object({
  metrics: AiOperationHealthMetricsSchema,
});
export type GetAiHealthMetricsResponse = z.infer<typeof GetAiHealthMetricsResponseSchema>;
