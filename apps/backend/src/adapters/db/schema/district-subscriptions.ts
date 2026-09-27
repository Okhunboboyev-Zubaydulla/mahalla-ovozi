import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { districts } from './districts.js';

export const districtSubscriptions = pgTable(
  'district_subscriptions',
  {
    id: text('id').primaryKey(),
    districtId: text('district_id')
      .notNull()
      .references(() => districts.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('ACTIVE'),
    statusStartedAt: timestamp('status_started_at', { withTimezone: true }).notNull().defaultNow(),
    scheduledTransitionAt: timestamp('scheduled_transition_at', { withTimezone: true }),
    scheduledTransitionType: text('scheduled_transition_type'),
    externalPaymentReference: text('external_payment_reference'),
    internalNote: text('internal_note'),
    updatedById: text('updated_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('district_subscriptions_district_id_unique').on(table.districtId),
    check(
      'district_subscriptions_status_check',
      sql`${table.status} IN ('SETUP_INCOMPLETE', 'ACTIVE', 'GRACE', 'SUSPENDED', 'CANCELLED')`
    ),
    check(
      'district_subscriptions_scheduled_transition_type_check',
      sql`${table.scheduledTransitionType} IS NULL OR ${table.scheduledTransitionType} IN ('AUTOMATIC_SUSPENSION', 'LIVE_DELETION')`
    ),
    index('district_subscriptions_status_idx').on(table.status),
    index('district_subscriptions_scheduled_transition_idx').on(table.scheduledTransitionAt),
  ]
);

export type DistrictSubscription = typeof districtSubscriptions.$inferSelect;
export type NewDistrictSubscription = typeof districtSubscriptions.$inferInsert;
