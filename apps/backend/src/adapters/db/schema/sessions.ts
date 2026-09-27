import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    credentialVersion: integer('credential_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('sessions_token_hash_idx').on(table.tokenHash),
    index('sessions_account_id_idx').on(table.accountId),
  ]
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
