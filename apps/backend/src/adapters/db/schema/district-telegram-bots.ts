import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { districts } from './districts.js';

export const districtTelegramBots = pgTable(
  'district_telegram_bots',
  {
    id: text('id').primaryKey(),
    districtId: text('district_id')
      .notNull()
      .references(() => districts.id, { onDelete: 'cascade' }),
    botId: text('bot_id').notNull(),
    botUsername: text('bot_username'),
    botFirstName: text('bot_first_name').notNull(),
    encryptedToken: text('encrypted_token').notNull(),
    tokenIv: text('token_iv').notNull(),
    tokenTag: text('token_tag').notNull(),
    tokenKeyVersion: text('token_key_version').notNull().default('v1'),
    tokenMasked: text('token_masked').notNull(),
    status: text('status').notNull().default('VALID'),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Status check constraint
    check(
      'district_telegram_bots_status_check',
      sql`${table.status} IN ('VALID', 'INVALID')`,
    ),
    // Enforces 1 bot per district
    uniqueIndex('district_telegram_bots_district_id_idx').on(table.districtId),
    // Enforces cross-district bot identity uniqueness at DB level (AC 5)
    uniqueIndex('district_telegram_bots_bot_id_idx').on(table.botId),
  ],
);

export type DistrictTelegramBot = typeof districtTelegramBots.$inferSelect;
export type NewDistrictTelegramBot = typeof districtTelegramBots.$inferInsert;
