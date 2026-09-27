import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  numeric,
  real,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { districts } from './districts.js';
import { accounts } from './accounts.js';
import type {
  DistrictLocalVocabularyItem,
} from '@mahalla-ovozi/api-contracts';

export const aiProfiles = pgTable('ai_profiles', {
  id: text('id').primaryKey(), // e.g. "prof_rel_2026_08_v1"
  version: integer('version').notNull(),
  operationType: text('operation_type').notNull(), // 'SEMANTIC_RELEVANCE' | 'TOPIC_MATCHING' | 'TOPIC_DERIVED_PROJECTION'
  provider: text('provider').notNull(), // 'OPENAI' | 'GEMINI' | 'DEEPINFRA' | 'OLLAMA'
  modelId: text('model_id').notNull(), // e.g. "gpt-4o-mini-2024-07-18", "gemini-2.0-flash-001"
  promptVersion: text('prompt_version').notNull(),
  schemaVersion: text('schema_version').notNull(),
  temperature: real('temperature').notNull().default(0.0),
  maxOutputTokens: integer('max_output_tokens').notNull().default(500),
  timeoutMs: integer('timeout_ms').notNull().default(10000),
  retryPolicy: jsonb('retry_policy').notNull(), // { maxAttempts: 3, backoffFactor: 2, initialDelayMs: 1000 }
  capabilities: jsonb('capabilities').notNull(), // { structuredOutputs: true, jsonSchemaMode: 'strict' }
  isActive: boolean('is_active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiOperations = pgTable(
  'ai_operations',
  {
    id: text('id').primaryKey(),
    districtId: text('district_id')
      .notNull()
      .references(() => districts.id, { onDelete: 'cascade' }),
    mahallaName: text('mahalla_name').notNull(),
    calendarDay: text('calendar_day').notNull(), // 'YYYY-MM-DD'
    operationType: text('operation_type').notNull(), // 'SEMANTIC_RELEVANCE'
    targetId: text('target_id').notNull(), // intakeId for Story 2.3
    pinnedProfileId: text('pinned_profile_id')
      .notNull()
      .references(() => aiProfiles.id),
    contextRevision: integer('context_revision').notNull().default(0),
    snapshotFingerprint: text('snapshot_fingerprint').notNull(),
    finalStatus: text('final_status').notNull(), // 'COMPLETED_RELEVANT' | 'COMPLETED_IRRELEVANT' | 'FAILED' | 'STALE'
    resultPayload: jsonb('result_payload'), // Sanitized output metadata ({ lanes, exclusionReason, reasoning })
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ai_ops_district_mahalla_day_idx').on(
      table.districtId,
      table.mahallaName,
      table.calendarDay,
    ),
    uniqueIndex('ai_ops_district_op_target_idx').on(
      table.districtId,
      table.operationType,
      table.targetId,
    ),
    index('ai_ops_final_status_idx').on(table.finalStatus),
    index('ai_ops_district_target_idx').on(table.districtId, table.targetId),
  ],
);

export const aiProviderAttempts = pgTable(
  'ai_provider_attempts',
  {
    id: text('id').primaryKey(),
    operationId: text('operation_id')
      .notNull()
      .references(() => aiOperations.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    providerRequestId: text('provider_request_id'),
    durationMs: integer('duration_ms').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedTokens: integer('cached_tokens'),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 10, scale: 6 }),
    status: text('status').notNull(), // 'SUCCESS' | 'ERROR' | 'TIMEOUT' | 'REFUSAL'
    errorCode: text('error_code'), // AiGatewayErrorCode
    sanitizedErrorMessage: text('sanitized_error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ai_attempts_operation_idx').on(table.operationId),
    uniqueIndex('ai_attempts_op_attempt_idx').on(table.operationId, table.attemptNumber),
  ],
);


export const districtAnalysisSettingsVersions = pgTable(
  'district_analysis_settings_versions',
  {
    id: text('id').primaryKey(), // e.g. "dcfg_dist_123_v1"
    districtId: text('district_id')
      .notNull()
      .references(() => districts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    hokimRecognitionTerms: jsonb('hokim_recognition_terms')
      .notNull()
      .$type<string[]>(),
    localVocabularyAdditions: jsonb('local_vocabulary_additions')
      .notNull()
      .$type<DistrictLocalVocabularyItem[]>(),
    isActive: boolean('is_active').notNull().default(false),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    activatedBy: text('activated_by').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    changeReason: text('change_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('district_settings_versions_district_version_idx').on(
      table.districtId,
      table.version,
    ),
    index('district_settings_versions_district_idx').on(table.districtId),
    index('district_settings_versions_active_idx').on(
      table.districtId,
      table.isActive,
    ),
  ],
);

export const districtAnalysisSettingsDrafts = pgTable(
  'district_analysis_settings_drafts',
  {
    id: text('id').primaryKey(), // e.g. "draft_dist_123" or districtId
    districtId: text('district_id')
      .notNull()
      .unique()
      .references(() => districts.id, { onDelete: 'cascade' }),
    baseActiveVersionId: text('base_active_version_id').references(
      () => districtAnalysisSettingsVersions.id,
      { onDelete: 'set null' },
    ),
    hokimRecognitionTerms: jsonb('hokim_recognition_terms')
      .notNull()
      .$type<string[]>(),
    localVocabularyAdditions: jsonb('local_vocabulary_additions')
      .notNull()
      .$type<DistrictLocalVocabularyItem[]>(),
    updatedBy: text('updated_by').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('district_settings_drafts_district_idx').on(table.districtId),
  ],
);

export type AiProfile = typeof aiProfiles.$inferSelect;
export type NewAiProfile = typeof aiProfiles.$inferInsert;
export type AiOperation = typeof aiOperations.$inferSelect;
export type NewAiOperation = typeof aiOperations.$inferInsert;
export type AiProviderAttempt = typeof aiProviderAttempts.$inferSelect;
export type NewAiProviderAttempt = typeof aiProviderAttempts.$inferInsert;
export type DistrictAnalysisSettingsVersion =
  typeof districtAnalysisSettingsVersions.$inferSelect;
export type NewDistrictAnalysisSettingsVersion =
  typeof districtAnalysisSettingsVersions.$inferInsert;
export type DistrictAnalysisSettingsDraft =
  typeof districtAnalysisSettingsDrafts.$inferSelect;
export type NewDistrictAnalysisSettingsDraft =
  typeof districtAnalysisSettingsDrafts.$inferInsert;




