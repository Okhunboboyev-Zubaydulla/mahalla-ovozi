import { pgTable, text, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { districts } from './districts.js';
import { topics } from './topics.js';
import { telegramIntakeRecords } from './telegram-intakes.js';
import { aiOperations } from './ai.js';

export const acceptedEvidence = pgTable(
  'accepted_evidence',
  {
    id: text('id').primaryKey(), // 'evi_<uuid>'
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'restrict' }), // Strict referential safety: never cascade delete legal civic evidence
    districtId: text('district_id')
      .notNull()
      .references(() => districts.id, { onDelete: 'cascade' }),
    mahallaName: text('mahalla_name').notNull(),
    calendarDay: text('calendar_day').notNull(), // 'YYYY-MM-DD' in Asia/Tashkent
    intakeRecordId: text('intake_record_id')
      .notNull()
      .references(() => telegramIntakeRecords.id),
    telegramChatId: text('telegram_chat_id').notNull(),
    telegramMessageId: text('telegram_message_id').notNull(),
    telegramUserId: text('telegram_user_id'),
    originalTimestamp: timestamp('original_timestamp', { withTimezone: true }).notNull(),
    verbatimText: text('verbatim_text').notNull(),
    contentType: text('content_type').notNull(), // 'TEXT' | 'MEDIA_CAPTION'
    userMetadata: jsonb('user_metadata'), // Whitelisted: telegramUserId, username, firstName, lastName
    replyMetadata: jsonb('reply_metadata'), // { replyToMessageId, replyToUserId, replyToIsForwarded, replyToIsBot }
    aiOperationId: text('ai_operation_id').references(() => aiOperations.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Deduplication constraint: exactly 1 evidence record per district + chat + message
    uniqueIndex('accepted_evidence_district_chat_msg_idx').on(
      table.districtId,
      table.telegramChatId,
      table.telegramMessageId,
    ),
    // Scoped query index for topic clustering & daily snapshot assembly
    index('accepted_evidence_district_mahalla_day_idx').on(
      table.districtId,
      table.mahallaName,
      table.calendarDay,
    ),
    // Index for retrieving all evidence belonging to a Topic
    index('accepted_evidence_topic_id_idx').on(table.topicId),
    // Composite index for deterministic snapshot ordering
    index('accepted_evidence_ordering_idx').on(
      table.districtId,
      table.mahallaName,
      table.calendarDay,
      table.originalTimestamp,
      table.telegramMessageId,
      table.id,
    ),
    // Composite index for TopicEvidence keyset pagination
    index('accepted_evidence_topic_keyset_idx').on(
      table.topicId,
      table.districtId,
      table.originalTimestamp,
      table.telegramMessageId,
      table.id,
    ),
  ],
);

export type AcceptedEvidence = typeof acceptedEvidence.$inferSelect;
export type NewAcceptedEvidence = typeof acceptedEvidence.$inferInsert;
