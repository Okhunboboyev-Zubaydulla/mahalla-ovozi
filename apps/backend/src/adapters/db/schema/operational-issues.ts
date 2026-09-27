import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { districts } from './districts.js';

export const operationalIssues = pgTable(
  'operational_issues',
  {
    id: text('id').primaryKey(),
    logicalKey: text('logical_key').notNull(),
    scope: text('scope').notNull(), // 'GLOBAL' | 'DISTRICT'
    districtId: text('district_id').references((): AnyPgColumn => districts.id, {
      onDelete: 'cascade',
    }),
    component: text('component').notNull(),
    issueCategory: text('issue_category').notNull(),
    severity: text('severity').notNull(), // 'Critical' | 'Warning' | 'Information'
    status: text('status').notNull(), // 'ACTIVE' | 'RESOLVED'
    healthStatus: text('health_status').notNull(),
    sanitizedTitle: text('sanitized_title').notNull(),
    sanitizedDescription: text('sanitized_description').notNull(),
    recommendedAction: text('recommended_action').notNull(),
    targetRoute: text('target_route'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    latestCheckAt: timestamp('latest_check_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'operational_issues_scope_check',
      sql`${table.scope} IN ('GLOBAL', 'DISTRICT')`,
    ),
    check(
      'operational_issues_severity_check',
      sql`${table.severity} IN ('Critical', 'Warning', 'Information')`,
    ),
    check(
      'operational_issues_status_check',
      sql`${table.status} IN ('ACTIVE', 'RESOLVED')`,
    ),
    check(
      'operational_issues_scope_district_check',
      sql`(${table.scope} = 'GLOBAL' AND ${table.districtId} IS NULL) OR (${table.scope} = 'DISTRICT' AND ${table.districtId} IS NOT NULL)`,
    ),
    // Partial unique index — ensures at most ONE active issue exists per logical key (AC 1, AC 6)
    uniqueIndex('operational_issues_active_logical_key_uidx')
      .on(table.logicalKey)
      .where(sql`${table.status} = 'ACTIVE'`),
    index('operational_issues_status_severity_idx').on(table.status, table.severity),
    index('operational_issues_district_status_idx').on(table.districtId, table.status),
    index('operational_issues_started_at_idx').on(table.startedAt),
  ],
);

export type OperationalIssueEntity = typeof operationalIssues.$inferSelect;
export type NewOperationalIssueEntity = typeof operationalIssues.$inferInsert;
