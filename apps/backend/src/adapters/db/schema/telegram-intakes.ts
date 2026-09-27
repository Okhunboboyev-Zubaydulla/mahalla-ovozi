import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, jsonb, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { districts } from './districts.js';

export type TelegramIntakeSource = 'BOT_API' | 'USERBOT';

export const telegramIntakeRecords = pgTable(
  'telegram_intake_records',
  {
    id: text('id').primaryKey(),
    districtId: text('district_id')
      .notNull()
      .references(() => districts.id, { onDelete: 'cascade' }),
    mahallaName: text('mahalla_name').notNull(),
    source: text('source').$type<TelegramIntakeSource>().notNull().default('BOT_API'),
    /**
     * Bot identity attribution (BOT_API-only).
     * Strictly required (NOT NULL) when source = 'BOT_API'; strictly null when source = 'USERBOT'.
     * Enforced at the database level by telegram_intakes_bot_id_source_consistency_check.
     * Historical BOT_API records preserve this attribution.
     */
    telegramBotId: text('telegram_bot_id'),
    telegramChatId: text('telegram_chat_id').notNull(),
    telegramMessageId: text('telegram_message_id').notNull(),
    updateId: text('update_id'),
    telegramUserId: text('telegram_user_id'),
    originalTimestamp: timestamp('original_timestamp', { withTimezone: true }).notNull(),
    calendarDay: text('calendar_day').notNull(), // 'YYYY-MM-DD' in Asia/Tashkent
    rawPayload: jsonb('raw_payload').notNull(),
    status: text('status').notNull().default('PENDING'),
    batchId: text('batch_id'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Source check constraint: explicit source discriminator
    check(
      'telegram_intakes_source_check',
      sql`${table.source} IN ('BOT_API', 'USERBOT')`,
    ),
    // Bot ID consistency constraint: BOT_API requires bot identity, USERBOT must not have bot identity
    check(
      'telegram_intakes_bot_id_source_consistency_check',
      sql`(${table.source} = 'BOT_API' AND ${table.telegramBotId} IS NOT NULL) OR (${table.source} = 'USERBOT' AND ${table.telegramBotId} IS NULL)`,
    ),
    // Status check constraint: explicit finite states
    check(
      'telegram_intakes_status_check',
      sql`${table.status} IN ('PENDING', 'PROCESSING', 'ACCEPTED', 'EXCLUDED', 'IRRELEVANT', 'FAILED')`,
    ),
    // Deduplication constraint: exactly 1 record per district + chat + message
    uniqueIndex('telegram_intakes_district_chat_msg_idx').on(
      table.districtId,
      table.telegramChatId,
      table.telegramMessageId,
    ),
    // Scoped query index for topic clustering & daily snapshot assembly
    index('telegram_intakes_district_day_mahalla_idx').on(
      table.districtId,
      table.calendarDay,
      table.mahallaName,
    ),
    // Query index for district chronological lookups
    index('telegram_intakes_district_created_idx').on(
      table.districtId,
      table.createdAt,
    ),
    // Query index for burst buffer lookups
    index('telegram_intakes_burst_unprocessed_idx').on(
      table.districtId,
      table.telegramChatId,
      table.telegramUserId,
      table.processedAt,
    ),
    // Index for status queries
    index('telegram_intakes_district_status_idx').on(table.districtId, table.status),
  ],
);

export type TelegramIntakeRecord = typeof telegramIntakeRecords.$inferSelect;
export type NewTelegramIntakeRecord = typeof telegramIntakeRecords.$inferInsert;
