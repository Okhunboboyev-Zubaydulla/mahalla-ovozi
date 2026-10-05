import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, check, integer, boolean } from 'drizzle-orm/pg-core';
import { districts } from './districts.js';

export const districtTelegramUserbotSessions = pgTable(
  'district_telegram_userbot_sessions',
  {
    id: text('id').primaryKey(),
    districtId: text('district_id')
      .notNull()
      .references(() => districts.id, { onDelete: 'cascade' }),
    phoneNumber: text('phone_number').notNull(),
    apiId: text('api_id').notNull(),
    apiHashEncrypted: text('api_hash_encrypted'),
    apiHashIv: text('api_hash_iv'),
    apiHashTag: text('api_hash_tag'),
    apiHashKeyVersion: text('api_hash_key_version').notNull().default('v1'),
    sessionEncrypted: text('session_encrypted'),
    sessionIv: text('session_iv'),
    sessionTag: text('session_tag'),
    sessionKeyVersion: text('session_key_version').notNull().default('v1'),
    status: text('status').notNull().default('PENDING'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastSuccessfulConnectionAt: timestamp('last_successful_connection_at', { withTimezone: true }),
    inboundUpdateCounter: integer('inbound_update_counter').notNull().default(0),
    isStale: boolean('is_stale').notNull().default(false),
    updatePosition: text('update_position'),
    updatePositionAdvancedAt: timestamp('update_position_advanced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'district_userbot_sessions_status_check',
      sql`${table.status} IN ('PENDING', 'ACTIVE', 'BANNED', 'DISABLED')`,
    ),
    uniqueIndex('district_telegram_userbot_sessions_district_id_idx').on(table.districtId),
  ],
);

export type DistrictTelegramUserbotSession = typeof districtTelegramUserbotSessions.$inferSelect;
export type NewDistrictTelegramUserbotSession = typeof districtTelegramUserbotSessions.$inferInsert;
