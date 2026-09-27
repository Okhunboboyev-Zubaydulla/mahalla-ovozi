import { pgTable, text, timestamp, integer, boolean, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { districts } from './districts.js';
import { topics } from './topics.js';
import { acceptedEvidence } from './accepted-evidence.js';
import { aiProfiles, aiOperations } from './ai.js';
import type { QualifyingLane } from '@mahalla-ovozi/api-contracts';

export const topicProjections = pgTable(
  'topic_projections',
  {
    id: text('id').primaryKey(), // 'prj_<uuid>'
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    districtId: text('district_id')
      .notNull()
      .references(() => districts.id, { onDelete: 'cascade' }),
    mahallaName: text('mahalla_name').notNull(),
    calendarDay: text('calendar_day').notNull(), // 'YYYY-MM-DD' in Asia/Tashkent
    summary: text('summary').notNull(),
    latestUpdate: text('latest_update'),
    lanes: jsonb('lanes').$type<QualifyingLane[]>().notNull(),
    primaryLane: text('primary_lane').notNull(), // 'WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE' | 'HOKIM_RELATED'
    anchorEvidenceId: text('anchor_evidence_id')
      .notNull()
      .references(() => acceptedEvidence.id, { onDelete: 'restrict' }),
    anchorQuote: text('anchor_quote').notNull(),
    latestMeaningfulActivityTimestamp: timestamp('latest_meaningful_activity_timestamp', {
      withTimezone: true,
    }).notNull(),
    attribution: text('attribution').notNull(),
    isHokimRelated: boolean('is_hokim_related').notNull().default(false),
    generation: integer('generation').notNull(),
    aiProfileId: text('ai_profile_id')
      .notNull()
      .references(() => aiProfiles.id),
    aiOperationId: text('ai_operation_id').references(() => aiOperations.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 1:1 dedicated constraint keyed on topicId
    uniqueIndex('topic_projections_topic_id_idx').on(table.topicId),
    // Scoped query index for day/district lookups
    index('topic_projections_district_day_idx').on(table.districtId, table.calendarDay),
    // Scoped query index for mahalla/day lookups
    index('topic_projections_district_mahalla_day_idx').on(
      table.districtId,
      table.mahallaName,
      table.calendarDay,
    ),
  ],
);

export type TopicProjection = typeof topicProjections.$inferSelect;
export type NewTopicProjection = typeof topicProjections.$inferInsert;
