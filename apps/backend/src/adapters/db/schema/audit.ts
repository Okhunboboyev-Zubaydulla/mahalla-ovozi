import { pgTable, text, timestamp, jsonb, index, AnyPgColumn } from 'drizzle-orm/pg-core';
import { districts } from './districts.js';

export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    districtId: text('district_id').references((): AnyPgColumn => districts.id, {
      onDelete: 'cascade',
    }),
    actorId: text('actor_id'),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_events_created_at_idx').on(table.createdAt),
    index('audit_events_action_idx').on(table.action),
    index('audit_events_actor_id_idx').on(table.actorId),
    index('audit_events_district_created_idx').on(table.districtId, table.createdAt),
    index('audit_events_created_at_id_idx').on(table.createdAt, table.id),
    index('audit_events_district_created_at_id_idx').on(table.districtId, table.createdAt, table.id),
  ]
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
