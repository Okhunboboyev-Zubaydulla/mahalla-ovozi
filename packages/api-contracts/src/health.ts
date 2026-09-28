import { z } from 'zod';
import { DistrictIdSchema } from './common.js';

/**
 * Six canonical health states defined in Story 4.1 (FR-25, FR-28, AD-11).
 */
export const HealthStatusEnumSchema = z.enum([
  'Healthy',
  'Delayed',
  'Degraded',
  'Unavailable',
  'Quiet',
  'Unknown',
]);
export type HealthStatus = z.infer<typeof HealthStatusEnumSchema>;

/**
 * Component scope declaration (GLOBAL infrastructure vs DISTRICT operational).
 */
export const ComponentScopeEnumSchema = z.enum(['GLOBAL', 'DISTRICT']);
export type ComponentScope = z.infer<typeof ComponentScopeEnumSchema>;

/**
 * Canonical monitored component types registered with the health boundary.
 */
export const ComponentTypeEnumSchema = z.enum([
  'database',
  'processing_queue',
  'storage',
  'web_application',
  'retention_jobs',
  'scheduled_deletion',
  'telegram_bot',
  'telegram_groups',
  'message_intake',
  'ai_operations',
  'district_retention',
]);
export type ComponentType = z.infer<typeof ComponentTypeEnumSchema>;

/**
 * Granular operational diagnostic metrics for components (AC 2).
 */
export const ComponentDiagnosticsSchema = z.object({
  // processing_queue
  queueDepth: z.number().nonnegative().optional(),
  failedJobCount: z.number().nonnegative().optional(),
  oldestQueuedAgeMs: z.number().nonnegative().optional(),
  // database & storage
  waitingConnectionCount: z.number().nonnegative().optional(),
  databaseSize: z.string().optional(),
  storageLatencyMs: z.number().nonnegative().optional(),
  storageStatus: z.string().optional(),
  // telegram_bot & telegram_groups
  connectedGroupsCount: z.number().nonnegative().optional(),
  activeGroupsCount: z.number().nonnegative().optional(),
  failedGroupsCount: z.number().nonnegative().optional(),
  lastValidatedAt: z.string().datetime().optional(),
  // message_intake
  lastMessageReceivedAt: z.string().datetime().optional(),
  intakeLatencyMs: z.number().nonnegative().optional(),
  // ai_operations
  activeModelVersion: z.string().optional(),
  activePromptVersion: z.string().optional(),
  recentSuccessCount: z.number().nonnegative().optional(),
  recentFailureCount: z.number().nonnegative().optional(),
  avgProcessingLatencyMs: z.number().nonnegative().optional(),
}).optional();
export type ComponentDiagnostics = z.infer<typeof ComponentDiagnosticsSchema>;

/**
 * Technical outcome category distinguishing confirmation, failure, and insufficient evidence.
 */
export const TechnicalOutcomeSchema = z.enum([
  'success',
  'failure',
  'insufficient_evidence',
]);
export type TechnicalOutcome = z.infer<typeof TechnicalOutcomeSchema>;

/**
 * Privacy-safe technical health observation contract.
 */
export const ComponentHealthObservationSchema = z.object({
  component: ComponentTypeEnumSchema,
  scope: ComponentScopeEnumSchema,
  districtId: DistrictIdSchema.nullable(),
  status: HealthStatusEnumSchema,
  lastCheckAt: z.string().datetime(),
  checkedAt: z.string().datetime(),
  outcome: TechnicalOutcomeSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  isApplicable: z.boolean(),
  lifecycleStatus: z.string().nullable(),
  diagnostics: ComponentDiagnosticsSchema.nullable().optional(),
});
export type ComponentHealthObservation = z.infer<typeof ComponentHealthObservationSchema>;

/**
 * Public process liveness probe response schema (`/api/v1/health/live`).
 */
export const LivenessProbeResponseSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.string().datetime(),
});
export type LivenessProbeResponse = z.infer<typeof LivenessProbeResponseSchema>;

/**
 * Public dependency readiness probe response schema (`/api/v1/health/ready`).
 */
export const ReadinessProbeResponseSchema = z.object({
  status: z.enum(['ready', 'unready']),
  timestamp: z.string().datetime(),
  checks: z.object({
    database: z.enum(['ok', 'down']),
    queue: z.enum(['ok', 'down']),
    restoreReconciliation: z.enum(['ok', 'down', 'unreconciled']).optional(),
  }),
});
export type ReadinessProbeResponse = z.infer<typeof ReadinessProbeResponseSchema>;

/**
 * Public health summary response schema (`/api/v1/health`).
 */
export const PublicHealthSummaryResponseSchema = z.object({
  status: HealthStatusEnumSchema,
  timestamp: z.string().datetime(),
  version: z.string().optional(),
});
export type PublicHealthSummaryResponse = z.infer<typeof PublicHealthSummaryResponseSchema>;

/**
 * Per-district summary item in overall health aggregation.
 */
export const DistrictHealthSummarySchema = z.object({
  districtId: DistrictIdSchema,
  districtName: z.string(),
  status: HealthStatusEnumSchema,
  lastCheckAt: z.string().datetime(),
  components: z.array(ComponentHealthObservationSchema),
  lifecycleStatus: z.string().nullable(),
});
export type DistrictHealthSummary = z.infer<typeof DistrictHealthSummarySchema>;

/**
 * Application-owned overall product health API response (`/api/v1/health/system`).
 */
export const OverallSystemHealthResponseSchema = z.object({
  status: HealthStatusEnumSchema,
  lastCheckAt: z.string().datetime(),
  evaluatedAt: z.string().datetime(),
  globalComponents: z.array(ComponentHealthObservationSchema),
  districts: z.array(DistrictHealthSummarySchema),
  totalDistricts: z.number().int().nonnegative(),
  activeDistricts: z.number().int().nonnegative(),
});
export type OverallSystemHealthResponse = z.infer<typeof OverallSystemHealthResponseSchema>;

/**
 * District-scoped health API response (`/api/v1/districts/:districtId/health`).
 */
export const DistrictHealthResponseSchema = z.object({
  districtId: DistrictIdSchema,
  districtName: z.string(),
  status: HealthStatusEnumSchema,
  lastCheckAt: z.string().datetime(),
  evaluatedAt: z.string().datetime(),
  components: z.array(ComponentHealthObservationSchema),
  lifecycleStatus: z.string().nullable(),
});
export type DistrictHealthResponse = z.infer<typeof DistrictHealthResponseSchema>;
