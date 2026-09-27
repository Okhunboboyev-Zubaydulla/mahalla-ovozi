import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

export const signInRateLimits = pgTable(
  'sign_in_rate_limits',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull().unique(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    firstFailedAt: timestamp('first_failed_at', { withTimezone: true }),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rate_limits_key_idx').on(table.key),
    index('rate_limits_locked_until_idx').on(table.lockedUntil),
  ]
);

export type SignInRateLimit = typeof signInRateLimits.$inferSelect;
export type NewSignInRateLimit = typeof signInRateLimits.$inferInsert;
