import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient, DbTransaction } from '../src/adapters/db/client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import {
  districts,
  districtTelegramGroups,
  telegramIntakeRecords,
  aiOperations,
  topics,
  acceptedEvidence,
  topicProjections,
} from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import { createTopicsDataCleaner } from '../src/modules/topics/topics-data-cleaner.js';


/**
 * Integration test for createTopicsDataCleaner (Story 7.1, ADR-001).
 *
 * Verifies that the topics module cleaner correctly deletes all topic-domain
 * rows for a given districtId in strict FK order without touching other modules' tables.
 */
describe('createTopicsDataCleaner', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let aiProfileId: string;

  beforeAll(async () => {
    await runMigrations();
    pool = createDbPool();
    db = createDbClient(pool);
    await ensureDefaultAiProfiles(db);
    const profile = await db.query.aiProfiles.findFirst();
    aiProfileId = profile!.id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  /**
   * Seeds the minimal FK chain required to insert topics, accepted_evidence,
   * and topic_projections for a given district.
   */
  async function seedTopicsForDistrict(tag: string) {
    const districtId = `dist_tc_${tag}_${Date.now()}`;
    const now = new Date();

    await db.insert(districts).values({
      id: districtId,
      name: `TC ${districtId}`,
      region: 'Toshkent',
      status: 'CANCELLED',
    });

    const chatId = `-100${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    await db.insert(districtTelegramGroups).values({
      id: crypto.randomUUID(),
      districtId,
      mahallaName: 'Mahalla 1',
      telegramChatId: chatId,
      telegramChatTitle: 'Mahalla 1 group',
      status: 'VALID',
    });

    const intakeId = `int_tc_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId,
      mahallaName: 'Mahalla 1',
      telegramBotId: `bot_tc_${tag}`,
      telegramChatId: chatId,
      telegramMessageId: '1',
      calendarDay: '2026-08-28',
      originalTimestamp: now,
      rawPayload: { text: 'Test message' },
    });

    const aiOpId = `aiop_tc_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(aiOperations).values({
      id: aiOpId,
      districtId,
      mahallaName: 'Mahalla 1',
      calendarDay: '2026-08-28',
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: intakeId,
      pinnedProfileId: aiProfileId,
      finalStatus: 'COMPLETED_RELEVANT',
      snapshotFingerprint: `fp_${tag}`,
    });

    const topicId = `top_tc_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(topics).values({
      id: topicId,
      districtId,
      mahallaName: 'Mahalla 1',
      calendarDay: '2026-08-28',
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
    });

    const evidenceId = `evi_tc_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(acceptedEvidence).values({
      id: evidenceId,
      topicId,
      districtId,
      mahallaName: 'Mahalla 1',
      calendarDay: '2026-08-28',
      intakeRecordId: intakeId,
      telegramChatId: chatId,
      telegramMessageId: '1',
      originalTimestamp: now,
      verbatimText: 'Water has been out since morning',
      contentType: 'TEXT',
      aiOperationId: aiOpId,
    });

    const projectionId = `prj_tc_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(topicProjections).values({
      id: projectionId,
      topicId,
      districtId,
      mahallaName: 'Mahalla 1',
      calendarDay: '2026-08-28',
      summary: 'Water supply disruption in mahalla',
      lanes: ['WATER'],
      primaryLane: 'WATER',
      anchorEvidenceId: evidenceId,
      anchorQuote: 'Water has been out since morning',
      latestMeaningfulActivityTimestamp: now,
      attribution: 'resident',
      generation: 1,
      aiProfileId,
    });

    return { districtId, topicId, evidenceId, projectionId };
  }

  it('deletes topic_projections, accepted_evidence, and topics for the target district', async () => {
    const { districtId } = await seedTopicsForDistrict('a');

    const projBefore = await db.select().from(topicProjections).where(eq(topicProjections.districtId, districtId));
    expect(projBefore).toHaveLength(1);
    const eviBefore = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.districtId, districtId));
    expect(eviBefore).toHaveLength(1);
    const topicsBefore = await db.select().from(topics).where(eq(topics.districtId, districtId));
    expect(topicsBefore).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTopicsDataCleaner().deleteDistrictData(tx, districtId);
    });

    const projAfter = await db.select().from(topicProjections).where(eq(topicProjections.districtId, districtId));
    expect(projAfter).toHaveLength(0);
    const eviAfter = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.districtId, districtId));
    expect(eviAfter).toHaveLength(0);
    const topicsAfter = await db.select().from(topics).where(eq(topics.districtId, districtId));
    expect(topicsAfter).toHaveLength(0);
  });

  it('does not delete topic-domain rows belonging to a different district', async () => {
    const { districtId: districtA } = await seedTopicsForDistrict('b1');
    const { districtId: districtB } = await seedTopicsForDistrict('b2');

    await db.transaction(async (tx: DbTransaction) => {
      await createTopicsDataCleaner().deleteDistrictData(tx, districtA);
    });

    const projB = await db.select().from(topicProjections).where(eq(topicProjections.districtId, districtB));
    expect(projB).toHaveLength(1);
    const eviB = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.districtId, districtB));
    expect(eviB).toHaveLength(1);
    const topicsB = await db.select().from(topics).where(eq(topics.districtId, districtB));
    expect(topicsB).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTopicsDataCleaner().deleteDistrictData(tx, districtB);
    });
  });

  it('is idempotent — second call on an already-clean district produces no error', async () => {
    const { districtId } = await seedTopicsForDistrict('c');

    await db.transaction(async (tx: DbTransaction) => {
      await createTopicsDataCleaner().deleteDistrictData(tx, districtId);
    });

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createTopicsDataCleaner().deleteDistrictData(tx, districtId);
      })
    ).resolves.not.toThrow();
  });

  it('rolls back — topic rows remain if the surrounding transaction is rolled back', async () => {
    const { districtId } = await seedTopicsForDistrict('d');

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createTopicsDataCleaner().deleteDistrictData(tx, districtId);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');

    const topicsAfter = await db.select().from(topics).where(eq(topics.districtId, districtId));
    expect(topicsAfter).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTopicsDataCleaner().deleteDistrictData(tx, districtId);
    });
  });
});
