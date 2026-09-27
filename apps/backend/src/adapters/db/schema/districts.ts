import { sql } from 'drizzle-orm';
import { pgTable, text, boolean, timestamp, index, uniqueIndex, check, AnyPgColumn } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';

export const districts = pgTable(
  'districts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    region: text('region'),
    status: text('status').notNull().default('SETUP_INCOMPLETE'),
    accessEligible: boolean('access_eligible').notNull().default(true),
    analysisConfigProfileId: text('analysis_config_profile_id').notNull().default('baseline_v1'),
    disclosureConfirmedAt: timestamp('disclosure_confirmed_at', { withTimezone: true }),
    disclosureConfirmedById: text('disclosure_confirmed_by_id').references((): AnyPgColumn => accounts.id, {
      onDelete: 'set null',
    }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    activatedById: text('activated_by_id').references((): AnyPgColumn => accounts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Status check constraint matching database migration
    check(
      'districts_status_check',
      sql`${table.status} IN ('SETUP_INCOMPLETE', 'ACTIVE', 'GRACE', 'SUSPENDED', 'CANCELLED')`
    ),
    // Functional unique index — enforces case-insensitive name uniqueness at DB level (P2-A)
    uniqueIndex('districts_name_lower_idx').on(sql`LOWER(${table.name})`),
    // Name index for text search lookups
    index('districts_name_idx').on(table.name),
  ]
);

export type District = typeof districts.$inferSelect;
export type NewDistrict = typeof districts.$inferInsert;
