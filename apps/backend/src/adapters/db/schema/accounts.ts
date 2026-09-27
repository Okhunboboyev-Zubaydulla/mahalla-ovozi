import { sql } from 'drizzle-orm';
import { pgTable, text, boolean, integer, timestamp, check, uniqueIndex, AnyPgColumn } from 'drizzle-orm/pg-core';
import { districts } from './districts.js';


export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    districtId: text('district_id').references((): AnyPgColumn => districts.id, {
      onDelete: 'cascade',
    }),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    credentialVersion: integer('credential_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Role check constraint
    check('accounts_role_check', sql`${table.role} IN ('PRODUCT_OWNER', 'DISTRICT_HOKIM')`),
    // Status check constraint
    check('accounts_status_check', sql`${table.status} IN ('ACTIVE', 'DISABLED')`),
    // Role-district consistency check constraint
    check(
      'accounts_role_district_check',
      sql`(${table.role} = 'PRODUCT_OWNER' AND ${table.districtId} IS NULL) OR (${table.role} = 'DISTRICT_HOKIM' AND ${table.districtId} IS NOT NULL)`
    ),
    // Partial unique index enforcing strict single active Hokim per district invariant (AC 12)
    uniqueIndex('accounts_active_district_hokim_idx')
      .on(table.districtId)
      .where(sql`${table.role} = 'DISTRICT_HOKIM' AND ${table.status} = 'ACTIVE'`),
  ]
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
