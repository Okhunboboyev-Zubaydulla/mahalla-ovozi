import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import type { GroupTransport } from '@mahalla-ovozi/api-contracts';
import { districts } from './districts.js';

export const districtTelegramGroups = pgTable(
  'district_telegram_groups',
  {
    id: text('id').primaryKey(),
    districtId: text('district_id')
      .notNull()
      .references(() => districts.id, { onDelete: 'cascade' }),
    mahallaName: text('mahalla_name').notNull(),
    telegramChatId: text('telegram_chat_id').notNull(),
    telegramChatTitle: text('telegram_chat_title').notNull(),
    telegramChatUsername: text('telegram_chat_username'),
    status: text('status').notNull().default('PENDING'),
    transport: text('transport').$type<GroupTransport>().notNull().default('BOT_API'),
    botMembershipStatus: text('bot_membership_status'),
    privacyModeDisabled: boolean('privacy_mode_disabled').notNull().default(false),
    // Operator decision: the group stays connected and mapped, but messages arriving from it
    // are discarded at the intake front door. Orthogonal to `status` (transport health) and
    // to `transport` (how the group is read).
    isPaused: boolean('is_paused').notNull().default(false),
    // Cumulative lifetime count of messages dropped while the group was paused. Never reset
    // by a resume, so a group paused by mistake stays visibly wrong across pause cycles.
    isPausedSkippedCount: integer('is_paused_skipped_count').notNull().default(0),
    // The lifetime counter's value captured at the instant the current pause episode began.
    // The resume audit reports (isPausedSkippedCount - this value), so the episode figure stays
    // correct across repeated pause/resume cycles while the lifetime counter itself is never reset.
    isPausedEpisodeStartSkippedCount: integer('is_paused_episode_start_skipped_count')
      .notNull()
      .default(0),
    testMessageReceivedAt: timestamp('test_message_received_at', { withTimezone: true }),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Status check constraint
    check(
      'district_telegram_groups_status_check',
      sql`${table.status} IN ('PENDING', 'TESTING', 'VALID', 'FAILED')`,
    ),
    // Transport check constraint
    check(
      'district_telegram_groups_transport_check',
      sql`${table.transport} IN ('BOT_API', 'USERBOT')`,
    ),
    // Enforces global Telegram chat identity uniqueness across all districts (AC 3)
    uniqueIndex('district_telegram_groups_chat_id_idx').on(table.telegramChatId),
    // Enforces case-insensitive uniqueness on mahallaName within a district (AC 2)
    uniqueIndex('district_telegram_groups_district_mahalla_lower_idx').on(
      table.districtId,
      sql`LOWER(${table.mahallaName})`,
    ),
    // District lookup index
    index('district_telegram_groups_district_id_idx').on(table.districtId),
  ],
);

export type { GroupTransport };
export type DistrictTelegramGroup = typeof districtTelegramGroups.$inferSelect;
export type NewDistrictTelegramGroup = typeof districtTelegramGroups.$inferInsert;
