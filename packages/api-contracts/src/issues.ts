import { z } from 'zod';
import {
  ComponentScopeEnumSchema,
  ComponentTypeEnumSchema,
  HealthStatusEnumSchema,
} from './health.js';

/**
 * Three canonical issue severity levels (Story 4.2 AC 2, AC 3).
 * Uzbek Cyrillic: Critical -> Муҳим, Warning -> Огоҳлантириш, Information -> Маълумот
 */
export const IssueSeverityEnumSchema = z.enum([
  'Critical',
  'Warning',
  'Information',
]);
export type IssueSeverity = z.infer<typeof IssueSeverityEnumSchema>;

/**
 * Two canonical lifecycle statuses for operational issues (Story 4.2 AC 1, AC 9).
 */
export const IssueStatusEnumSchema = z.enum(['ACTIVE', 'RESOLVED']);
export type IssueStatus = z.infer<typeof IssueStatusEnumSchema>;

/**
 * Canonical operational issue categories (Story 4.2 AC 1, AC 5).
 */
export const IssueCategoryEnumSchema = z.enum([
  'DATABASE_CONNECTION_ERROR',
  'QUEUE_UNAVAILABLE',
  'QUEUE_BACKLOG_DELAY',
  'STORAGE_UNAVAILABLE',
  'WEB_APP_UNAVAILABLE',
  'BOT_TOKEN_INVALID',
  'BOT_DISCONNECTED',
  'TELEGRAM_GROUP_DISCONNECTED',
  'MESSAGE_INTAKE_DELAY',
  'TOPIC_PROCESSING_DELAY',
  'AI_SERVICE_DEGRADED',
  'RETENTION_JOB_DELAY',
  'DISTRICT_RETENTION_DELAY',
  'SUBSCRIPTION_PAUSED_NOTICE',
  'OPERATIONAL_MAINTENANCE_NOTICE',
  'BACKUP_EXPIRY_DELAY',
  'LIFECYCLE_DELETION',
  'DISASTER_RECOVERY',
]);
export type IssueCategory = z.infer<typeof IssueCategoryEnumSchema>;

/**
 * Query schema for filtering operational issues list.
 *
 * ARCHITECTURAL NOTE ON PAGINATION:
 * While time-series and event feeds (audit, AI operations, topics, signals) use
 * keyset/cursor-based pagination for high-volume append-mostly datasets, operational issues
 * use offset-based pagination (limit/offset) by design.
 * Operational issues represent a strictly bounded, low-cardinality state list
 * (typically < 100 active issues per district/global scope), frequently sorted
 * and filtered by multiple mutable dimensions (status, severity, category, component).
 * Offset pagination provides straightforward page jumping and direct offset access
 * for dashboard operational views without the cursor coordination overhead required by keyset pagination.
 */
export const OperationalIssuesQuerySchema = z.object({
  districtId: z.string().optional(),
  status: IssueStatusEnumSchema.optional(),
  severity: IssueSeverityEnumSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
});
export type OperationalIssuesQuery = z.infer<typeof OperationalIssuesQuerySchema>;

/**
 * Canonical operational issue entity contract.
 */
export const OperationalIssueSchema = z.object({
  id: z.string(),
  logicalKey: z.string(),
  scope: ComponentScopeEnumSchema,
  districtId: z.string().min(1).nullable(),
  districtName: z.string().nullable(),
  component: ComponentTypeEnumSchema,
  issueCategory: IssueCategoryEnumSchema,
  severity: IssueSeverityEnumSchema,
  status: IssueStatusEnumSchema,
  healthStatus: HealthStatusEnumSchema,
  sanitizedTitle: z.string(),
  sanitizedDescription: z.string(),
  recommendedAction: z.string(),
  targetRoute: z.string().nullable(),
  startedAt: z.string().datetime(),
  latestCheckAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  isRetryEligible: z.boolean(),
  retryCount: z.number().int().nonnegative().optional(),
  pendingRetry: z.boolean().optional(),
  lastRetryAt: z.string().datetime().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type OperationalIssue = z.infer<typeof OperationalIssueSchema>;

/**
 * List response schema for operational issues endpoint (`/api/v1/issues`).
 */
export const OperationalIssuesListResponseSchema = z.object({
  issues: z.array(OperationalIssueSchema),
  totalActive: z.number().int().nonnegative(),
  criticalCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  infoCount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  evaluatedAt: z.string().datetime(),
});
export type OperationalIssuesListResponse = z.infer<
  typeof OperationalIssuesListResponseSchema
>;

/**
 * Issue audit event entry schema for detail panel timeline.
 */
export const IssueAuditEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  actorId: z.string().nullable(),
  actorRole: z.string().nullable(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type IssueAuditEvent = z.infer<typeof IssueAuditEventSchema>;

/**
 * Detailed operational issue response schema (`/api/v1/issues/:issueId`).
 */
export const OperationalIssueDetailResponseSchema = z.object({
  issue: OperationalIssueSchema,
  auditEvents: z.array(IssueAuditEventSchema),
});
export type OperationalIssueDetailResponse = z.infer<
  typeof OperationalIssueDetailResponseSchema
>;

// ---------------------------------------------------------------------------
// Retry Contracts (absorbed from retry.ts)
// Retry is operational issue resolution — domain origin does not change ownership.
// ---------------------------------------------------------------------------

/**
 * Supported operation types eligible for safe manual retry (Story 4.3 AC 1, AC 2, AC 6).
 */
export const RetryableOperationTypeEnumSchema = z.enum([
  'TELEGRAM_CONTENT_QUALIFICATION',
  'TELEGRAM_SEMANTIC_RELEVANCE',
  'TELEGRAM_TOPIC_ASSIGNMENT',
  'TELEGRAM_TOPIC_PROJECTION',
  'TELEGRAM_TOPIC_RETENTION',
  'HEALTH_CHECK_SYNC',
]);
export type RetryableOperationType = z.infer<typeof RetryableOperationTypeEnumSchema>;

/**
 * Standard error codes returned for rejected retry requests (Story 4.3 AC 2, AC 6).
 */
export const RetryErrorCodeEnumSchema = z.enum([
  'OPERATION_INELIGIBLE',
  'DUPLICATE_RETRY_IN_PROGRESS',
  'OPERATION_ALREADY_COMPLETED',
  'OPERATION_NOT_FOUND',
  'DISTRICT_ACCESS_REVOKED',
]);
export type RetryErrorCode = z.infer<typeof RetryErrorCodeEnumSchema>;

/**
 * Request payload for manual retry execution (`POST /api/v1/issues/:issueId/retry` or `POST /api/v1/retry/jobs`).
 */
export const RetryOperationRequestSchema = z.object({
  issueId: z.string().optional(),
  operationType: RetryableOperationTypeEnumSchema.optional(),
  targetId: z.string().optional(),
  reason: z.string().max(500).optional(),
});
export type RetryOperationRequest = z.infer<typeof RetryOperationRequestSchema>;

/**
 * Response payload returned when a retry request is accepted into the background queue.
 */
export const RetryOperationResponseSchema = z.object({
  accepted: z.boolean(),
  retryTrackingId: z.string(),
  operationType: z.string(),
  targetId: z.string(),
  queuedAt: z.string().datetime(),
  message: z.string(),
});
export type RetryOperationResponse = z.infer<typeof RetryOperationResponseSchema>;

