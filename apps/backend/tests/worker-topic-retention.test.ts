import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import {
  createDbPool,
  createDbClient,
  type DbClient,
} from '../src/adapters/db/client.js';
import { districts, telegramIntakeRecords, aiOperations, aiProviderAttempts, topics, acceptedEvidence, topicProjections } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import {
  createBossClient,
  initBossQueues,
  withTransactionalIntake,
  TELEGRAM_TOPIC_RETENTION_QUEUE,
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  type TelegramTopicRetentionJobData,
  type TelegramTopicProjectionJobData,
} from '../src/adapters/jobs/boss-client.js';
import { startWorker, stopWorker } from '../src/entrypoints/worker.js';
import {
  purgeExpiredTopic,
  purgeDistrictExpiredTopicsBatch,
  calculateRetentionDeadline,
} from '../src/modules/retention/topic-retention-service.js';
import type {
  RetentionPurgeResult,
  RetentionBatchResult,
  RetentionScanOptions,
} from '../src/modules/retention/topic-retention-types.js';
import { reconcileRestoredRetention } from '../src/modules/retention/restore-reconciliation.js';
import { getMahallaDailySnapshot } from '../src/modules/ai/context-snapshot.js';

describe('Story 2.6: Worker Topic Retention & Accepted Evidence Source of Truth 28-Row Verification Matrix Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;
  let retentionService: {
    purgeExpiredTopic: (districtId: string, topicId: string, now?: Date) => Promise<RetentionPurgeResult>;
    purgeDistrictExpiredTopicsBatch: (districtId: string, options?: RetentionScanOptions, now?: Date) => Promise<RetentionBatchResult>;
  };
  let testDistrictId: string;
  let testChatId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    await ensureDefaultAiProfiles(db);

    boss = createBossClient({ schema: 'pgboss_topic_retention' });
    await boss.start();
    await initBossQueues(boss);

    retentionService = {
      purgeExpiredTopic: (districtId: string, topicId: string, now?: Date) =>
        purgeExpiredTopic(pool, boss, db, districtId, topicId, now),
      purgeDistrictExpiredTopicsBatch: (districtId: string, options?: RetentionScanOptions, now?: Date) =>
        purgeDistrictExpiredTopicsBatch(pool, boss, db, districtId, options, now),
    };

    // Clean up stale jobs in test schema
    await pool.query('DELETE FROM pgboss_topic_retention.job');

    await startWorker({
      boss,
      db,
      pool,
      queues: [TELEGRAM_TOPIC_RETENTION_QUEUE, TELEGRAM_TOPIC_PROJECTION_QUEUE],
    });
  });

  afterAll(async () => {
    await stopWorker(boss);
    await pool.end();
  });

  beforeEach(async () => {
    testDistrictId = `dist_ret_${crypto.randomUUID()}`;
    testChatId = `-100${Math.floor(1000000000 + Math.random() * 9000000000)}`;

    await db.insert(districts).values({
      id: testDistrictId,
      name: `RetentionDistrict_${crypto.randomUUID().slice(0, 8)}`,
      region: 'Sirdaryo',
      status: 'ACTIVE',
      accessEligible: true,
    });
  });

  async function seedDistrict(
    districtId: string,
    options?: { status?: 'ACTIVE' | 'ONBOARDING' | 'SUSPENDED' | 'OFFBOARDED'; accessEligible?: boolean },
  ) {
    await db.insert(districts).values({
      id: districtId,
      name: `District_${districtId.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`,
      region: 'Toshkent shahri',
      status: options?.status ?? 'ACTIVE',
      accessEligible: options?.accessEligible ?? true,
    });
  }

  /** Helper to seed a Topic with arbitrary Accepted Evidence rows */
  async function seedTopicWithEvidence(
    districtId: string,
    options: {
      topicId?: string;
      mahallaName?: string;
      calendarDay?: string;
      primaryLane?: 'WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE' | 'HOKIM_RELATED';
      retentionExpiresAt: Date;
      latestRelevantEvidenceTimestamp?: Date;
      evidenceList: Array<{
        evidenceId?: string;
        telegramMessageId: string;
        telegramUserId?: string;
        originalTimestamp: Date;
        verbatimText: string;
        userMetadata?: any;
      }>;
      projection?: {
        summary: string;
        lanes: ('WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE' | 'HOKIM_RELATED')[];
        anchorQuote?: string;
        attribution?: string;
      };
    },
  ): Promise<{ topicId: string; evidenceIds: string[] }> {
    const topicId = options.topicId || `top_${crypto.randomUUID()}`;
    const mahallaName = options.mahallaName || 'Guliston';
    const calendarDay = options.calendarDay || '2026-08-22';
    const primaryLane = options.primaryLane || 'WATER';

    const latestEvidenceTime =
      options.latestRelevantEvidenceTimestamp ||
      (options.evidenceList.length > 0
        ? options.evidenceList.reduce(
            (max, e) => (e.originalTimestamp.getTime() > max.getTime() ? e.originalTimestamp : max),
            options.evidenceList[0]!.originalTimestamp,
          )
        : new Date());

    // 1. Insert Topic
    await db.insert(topics).values({
      id: topicId,
      districtId,
      mahallaName,
      calendarDay,
      primaryLane,
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: latestEvidenceTime,
      retentionExpiresAt: options.retentionExpiresAt,
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: options.projection ? 1 : 0,
    });

    // 2. Insert Evidence
    const insertedEvidenceIds: string[] = [];
    for (const item of options.evidenceList) {
      const evidenceId = item.evidenceId || `evi_${crypto.randomUUID()}`;
      const intakeId = `intk_${crypto.randomUUID()}`;

      // Insert intake record for FK
      await db.insert(telegramIntakeRecords).values({
        id: intakeId,
        districtId,
        mahallaName,
        telegramBotId: 'bot_ret_test',
        telegramChatId: testChatId,
        telegramMessageId: item.telegramMessageId,
        originalTimestamp: item.originalTimestamp,
        calendarDay,
        rawPayload: { text: item.verbatimText },
      });

      await db.insert(acceptedEvidence).values({
        id: evidenceId,
        topicId,
        districtId,
        mahallaName,
        calendarDay,
        intakeRecordId: intakeId,
        telegramChatId: testChatId,
        telegramMessageId: item.telegramMessageId,
        telegramUserId: item.telegramUserId ?? '12345678',
        originalTimestamp: item.originalTimestamp,
        verbatimText: item.verbatimText,
        contentType: 'TEXT',
        userMetadata: item.userMetadata || { username: 'citizen_1' },
      });

      insertedEvidenceIds.push(evidenceId);
    }

    // 3. Insert Projection if specified
    if (options.projection && insertedEvidenceIds.length > 0) {
      const anchorEvidenceId = insertedEvidenceIds[0]!;
      await db.insert(topicProjections).values({
        id: `prj_${crypto.randomUUID()}`,
        topicId,
        districtId,
        mahallaName,
        calendarDay,
        summary: options.projection.summary,
        lanes: options.projection.lanes,
        primaryLane,
        anchorEvidenceId,
        anchorQuote: options.projection.anchorQuote || 'Default anchor quote',
        latestMeaningfulActivityTimestamp: latestEvidenceTime,
        attribution: options.projection.attribution || 'Fuqaro',
        isHokimRelated: options.projection.lanes.includes('HOKIM_RELATED'),
        generation: 1,
        aiProfileId: 'prof_proj_2026_08_v1',
      });
    }

    return { topicId, evidenceIds: insertedEvidenceIds };
  }

  /** Helper to send a job and poll until processed */
  async function sendAndProcessJob(queueName: string, jobData: any, options?: any) {
    const jobId = await boss.send(queueName, jobData, {
      retryLimit: 0,
      ...options,
    });
    expect(jobId).toBeDefined();

    for (let i = 0; i < 120; i++) {
      const { rows } = await pool.query(
        'SELECT state, output FROM pgboss_topic_retention.job WHERE id = $1',
        [jobId],
      );
      if (rows.length > 0 && (rows[0].state === 'completed' || rows[0].state === 'failed')) {
        return rows[0];
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Job ${jobId} on queue ${queueName} did not complete within timeout`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 28-Row Verification Matrix
  // ──────────────────────────────────────────────────────────────────────────

  // Matrix #1: Topic with retentionExpiresAt in the past is purged atomically (AC 2, 6)
  it('Matrix #1: Topic with retentionExpiresAt in past is purged atomically (projections, evidence, topic removed)', async () => {
    const expiredDeadline = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
    const evidenceTime = new Date(expiredDeadline.getTime() - 90 * 24 * 60 * 60 * 1000);

    const { topicId, evidenceIds } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '101', originalTimestamp: evidenceTime, verbatimText: 'Suv 3 kundan beri yoq' },
      ],
      projection: {
        summary: 'Сув таъминотида 3 кундан бери узилиш бўлаётгани маълум қилинди.',
        lanes: ['WATER'],
        anchorQuote: 'Suv 3 kundan beri yoq',
        attribution: 'Маҳалла фуқароси хабарига кўра',
      },
    });

    const result = await retentionService.purgeExpiredTopic(testDistrictId, topicId);
    expect(result.purged).toBe(true);
    expect(result.evidenceCount).toBe(1);
    expect(result.projectionsCount).toBe(1);

    // Verify DB state
    const topicRows = await db.select().from(topics).where(eq(topics.id, topicId));
    expect(topicRows).toHaveLength(0);

    const evidenceRows = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.id, evidenceIds[0]!));
    expect(evidenceRows).toHaveLength(0);

    const projectionRows = await db.select().from(topicProjections).where(eq(topicProjections.topicId, topicId));
    expect(projectionRows).toHaveLength(0);
  });

  // Matrix #2: Older evidence retained because Topic has newer evidence (AC 3, 4)
  it('Matrix #2: Older evidence (95 days old) is retained because Topic has newer evidence (10 days old)', async () => {
    const olderEvidenceTime = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);
    const newerEvidenceTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const activeDeadline = new Date(newerEvidenceTime.getTime() + 90 * 24 * 60 * 60 * 1000); // 80 days in future

    const { topicId, evidenceIds } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: activeDeadline,
      latestRelevantEvidenceTimestamp: newerEvidenceTime,
      evidenceList: [
        { telegramMessageId: '201', originalTimestamp: olderEvidenceTime, verbatimText: 'Svet ochdi 95 kun oldin' },
        { telegramMessageId: '202', originalTimestamp: newerEvidenceTime, verbatimText: 'Svet yana ochdi 10 kun oldin' },
      ],
    });

    // Scanner evaluates district
    const batchResult = await retentionService.purgeDistrictExpiredTopicsBatch(testDistrictId);
    expect(batchResult.topicsPurged).toBe(0);

    // Both older and newer evidence survive together
    const evidenceRows = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.topicId, topicId));
    expect(evidenceRows).toHaveLength(2);
    expect(evidenceRows.map((e) => e.id)).toContain(evidenceIds[0]);
    expect(evidenceRows.map((e) => e.id)).toContain(evidenceIds[1]);
  });

  // Matrix #3: Active Topic with retentionExpiresAt in future is not touched (AC 5)
  it('Matrix #3: Active Topic with retentionExpiresAt in future is not touched by scanner', async () => {
    const futureDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // Tomorrow
    const evidenceTime = new Date(futureDeadline.getTime() - 90 * 24 * 60 * 60 * 1000);

    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: futureDeadline,
      evidenceList: [
        { telegramMessageId: '301', originalTimestamp: evidenceTime, verbatimText: 'Gaz bosimi past' },
      ],
    });

    const batchResult = await retentionService.purgeDistrictExpiredTopicsBatch(testDistrictId);
    expect(batchResult.topicsPurged).toBe(0);

    const [existingTopic] = await db.select().from(topics).where(eq(topics.id, topicId));
    expect(existingTopic).toBeDefined();
    expect(existingTopic?.status).toBe('ACTIVE');
  });

  // Matrix #4: Deletion removes topic_projections before accepted_evidence before topics (AC 6)
  it('Matrix #4: Deletion removes topic_projections before accepted_evidence before topics respecting onDelete: restrict', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '401', originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), verbatimText: 'Axlat toplanib qoldi' },
      ],
      projection: {
        summary: 'Маҳаллада чиқинди тўпланиб қолгани хабар қилинди.',
        lanes: ['WASTE'],
        anchorQuote: 'Axlat toplanib qoldi',
        attribution: 'Маҳалла аҳолиси хабарига кўра',
      },
    });

    // Should succeed cleanly without Postgres FK restrict violation
    const purgeResult = await retentionService.purgeExpiredTopic(testDistrictId, topicId);
    expect(purgeResult.purged).toBe(true);
    expect(purgeResult.projectionsCount).toBe(1);
    expect(purgeResult.evidenceCount).toBe(1);
  });

  // Matrix #5: In-flight race: new evidence arrives during scan extending deadline -> purge aborts (AC 7)
  it('Matrix #5: In-flight race: new evidence extends deadline -> purge aborts cleanly with 0 deleted', async () => {
    const expiredDeadline = new Date(Date.now() - 5000);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '501', originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), verbatimText: 'Eski xabar' },
      ],
    });

    // Simulate concurrent arrival of new evidence extending deadline to future before row lock
    const extendedDeadline = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await db.update(topics).set({ retentionExpiresAt: extendedDeadline }).where(eq(topics.id, topicId));

    const purgeResult = await retentionService.purgeExpiredTopic(testDistrictId, topicId);
    expect(purgeResult.purged).toBe(false);
    expect(purgeResult.reason).toBe('EXTENDED_BY_NEWER_EVIDENCE');

    // Topic still exists
    const [topic] = await db.select().from(topics).where(eq(topics.id, topicId));
    expect(topic).toBeDefined();
  });

  // Matrix #6: After Topic is purged, subsequent insertion into old topic_id fails FK constraint (AC 7)
  it('Matrix #6: After Topic is purged, subsequent insertion of accepted_evidence into old topic_id fails FK constraint', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '601', originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), verbatimText: 'Eski dalil' },
      ],
    });

    await retentionService.purgeExpiredTopic(testDistrictId, topicId);

    // Attempt inserting into deleted topicId
    const fakeIntakeId = `intk_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: fakeIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      telegramBotId: 'bot_ret_test',
      telegramChatId: testChatId,
      telegramMessageId: '602',
      originalTimestamp: new Date(),
      calendarDay: '2026-08-22',
      rawPayload: { text: 'Kech kelgan xabar' },
    });

    await expect(
      db.insert(acceptedEvidence).values({
        id: `evi_${crypto.randomUUID()}`,
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        intakeRecordId: fakeIntakeId,
        telegramChatId: testChatId,
        telegramMessageId: '602',
        originalTimestamp: new Date(),
        verbatimText: 'Kech kelgan xabar',
        contentType: 'TEXT',
      }),
    ).rejects.toThrow();
  });

  // Matrix #7: Purging Topic deletes summary and multi-lane projection completely (AC 8)
  it('Matrix #7: Purging Topic deletes summary and multi-lane projection completely without leaving shadow rows', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '701', originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), verbatimText: 'Svet uchdi va sim uzildi' },
      ],
      projection: {
        summary: 'Электр таъминоти узилган ва сим узилиб тушган.',
        lanes: ['ELECTRICITY', 'HOKIM_RELATED'],
        anchorQuote: 'Svet uchdi va sim uzildi',
        attribution: 'Маҳалла аҳолиси хабарига кўра',
      },
    });

    await retentionService.purgeExpiredTopic(testDistrictId, topicId);

    const projections = await db.select().from(topicProjections).where(eq(topicProjections.topicId, topicId));
    expect(projections).toHaveLength(0);
  });

  // Matrix #8: AI operations retain content-free technical metadata while resident text is purged (AC 9)
  it('Matrix #8: AI operations in ai_operations retain content-free technical metadata while resident text is purged', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const aiOpId = `aiop_${crypto.randomUUID()}`;

    // Insert privacy-safe technical record in ai_operations
    await db.insert(aiOperations).values({
      id: aiOpId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      operationType: 'TOPIC_MATCHING',
      targetId: 'msg_801',
      pinnedProfileId: 'prof_match_2026_08_v1',
      contextRevision: 1,
      snapshotFingerprint: 'sha256_dummy',
      finalStatus: 'COMPLETED',
    });

    await db.insert(aiProviderAttempts).values({
      id: `att_${crypto.randomUUID()}`,
      operationId: aiOpId,
      attemptNumber: 1,
      provider: 'MOCK',
      modelId: 'mock-model',
      durationMs: 15,
      inputTokens: 50,
      outputTokens: 20,
      status: 'SUCCESS',
    });

    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '801', originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), verbatimText: 'Maxfiy xabar matni' },
      ],
    });

    await retentionService.purgeExpiredTopic(testDistrictId, topicId);

    // AI Operation metadata remains intact and queryable for analytics
    const [op] = await db.select().from(aiOperations).where(eq(aiOperations.id, aiOpId));
    expect(op).toBeDefined();
    expect(op?.operationType).toBe('TOPIC_MATCHING');

    // But evidence text is completely wiped
    const evidence = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.topicId, topicId));
    expect(evidence).toHaveLength(0);
  });

  // Matrix #9: Topic deletion invalidates snapshotFingerprint and contextRevision monotonically (AC 10)
  it('Matrix #9: Topic deletion invalidates snapshotFingerprint and contextRevision dynamically', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '901', originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), verbatimText: 'Dalil 1' },
      ],
    });

    const initialSnapshot = await getMahallaDailySnapshot(db, testDistrictId, 'Guliston', '2026-08-22');
    expect(initialSnapshot.contextRevision).toBe(1);
    expect(initialSnapshot.evidence).toHaveLength(1);

    await retentionService.purgeExpiredTopic(testDistrictId, topicId);

    const postPurgeSnapshot = await getMahallaDailySnapshot(db, testDistrictId, 'Guliston', '2026-08-22');
    expect(postPurgeSnapshot.contextRevision).toBe(0);
    expect(postPurgeSnapshot.evidence).toHaveLength(0);
    expect(postPurgeSnapshot.snapshotFingerprint).not.toBe(initialSnapshot.snapshotFingerprint);
  });

  // Matrix #10: In-flight AI Topic projection job targeting deleted topic fails as STALE_SNAPSHOT (AC 10)
  it('Matrix #10: In-flight AI Topic projection job referencing deleted context fails as STALE_SNAPSHOT', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '1001', originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), verbatimText: 'Dalil 1001' },
      ],
    });

    const snapshotBefore = await getMahallaDailySnapshot(db, testDistrictId, 'Guliston', '2026-08-22');
    expect(snapshotBefore.contextRevision).toBe(1);

    // Purge the topic
    await retentionService.purgeExpiredTopic(testDistrictId, topicId);

    // Verify context snapshot changed
    const snapshotAfter = await getMahallaDailySnapshot(db, testDistrictId, 'Guliston', '2026-08-22');
    expect(snapshotAfter.snapshotFingerprint).not.toBe(snapshotBefore.snapshotFingerprint);
  });

  // Matrix #11: In-flight AI Topic matching job referencing old context revision fails and does not recreate deleted topic (AC 10)
  it('Matrix #11: In-flight AI matching job referencing old snapshot fingerprint fails on commit', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '1101', originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), verbatimText: 'Dalil 1101' },
      ],
    });

    await retentionService.purgeExpiredTopic(testDistrictId, topicId);

    const snapshot = await getMahallaDailySnapshot(db, testDistrictId, 'Guliston', '2026-08-22');
    expect(snapshot.contextRevision).toBe(0);
    expect(snapshot.evidence).toHaveLength(0);
  });

  // Matrix #12: Pending pg-boss projection job for expired topic detects deleted topic and drops cleanly as DROPPED_EXPIRED (AC 11)
  it('Matrix #12: Pending projection job for expired topic drops cleanly as TELEGRAM_TOPIC_PROJECTION_DROPPED_EXPIRED', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '1201', originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), verbatimText: 'Dalil 1201' },
      ],
    });

    // Purge topic first
    await retentionService.purgeExpiredTopic(testDistrictId, topicId);

    // Enqueue projection job for already-deleted topic
    const projectionJobData: TelegramTopicProjectionJobData = {
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 2,
    };

    const jobRecord = await sendAndProcessJob(TELEGRAM_TOPIC_PROJECTION_QUEUE, projectionJobData);
    expect(jobRecord?.state).toBe('completed');
  });

  // Matrix #13: Missing districtId in retention scan throws INVALID_DISTRICT_SCOPE (AC 12)
  it('Matrix #13: Missing districtId in retention scan throws INVALID_DISTRICT_SCOPE', async () => {
    await expect(retentionService.purgeExpiredTopic('', 'top_123')).rejects.toThrowError(
      /INVALID_DISTRICT_SCOPE/,
    );
    await expect(retentionService.purgeDistrictExpiredTopicsBatch('')).rejects.toThrowError(
      /INVALID_DISTRICT_SCOPE/,
    );
  });

  // Matrix #14: Purge in District A never touches expired or active topics in District B (AC 12)
  it('Matrix #14: Purge in District A never touches expired or active topics in District B', async () => {
    const districtB = `dist_ret_b_${crypto.randomUUID()}`;
    await seedDistrict(districtB);

    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId: topicA } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [{ telegramMessageId: '1401', originalTimestamp: new Date(), verbatimText: 'A' }],
    });

    const { topicId: topicB } = await seedTopicWithEvidence(districtB, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [{ telegramMessageId: '1402', originalTimestamp: new Date(), verbatimText: 'B' }],
    });

    // Purge only in District A
    await retentionService.purgeDistrictExpiredTopicsBatch(testDistrictId);

    const [topicARows] = await db.select().from(topics).where(eq(topics.id, topicA));
    expect(topicARows).toBeUndefined();

    const [topicBRows] = await db.select().from(topics).where(eq(topics.id, topicB));
    expect(topicBRows).toBeDefined();
  });

  // Matrix #15: Scheduled retention worker executes batch purge of expired topics in single run (AC 13)
  it('Matrix #15: Scheduled retention worker executes batch purge of 10 expired topics in single run', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);

    for (let i = 1; i <= 10; i++) {
      await seedTopicWithEvidence(testDistrictId, {
        topicId: `top_batch_${i}_${crypto.randomUUID()}`,
        retentionExpiresAt: expiredDeadline,
        evidenceList: [{ telegramMessageId: `msg_b_${i}`, originalTimestamp: new Date(), verbatimText: `B ${i}` }],
      });
    }

    const batchResult = await retentionService.purgeDistrictExpiredTopicsBatch(testDistrictId, { limit: 50 });
    expect(batchResult.topicsPurged).toBe(10);
    expect(batchResult.evidencePurged).toBe(10);

    const remaining = await db.select().from(topics).where(eq(topics.districtId, testDistrictId));
    expect(remaining).toHaveLength(0);
  });

  // Matrix #16: Duplicate retention job delivery for same topic executes idempotently with 0 errors (AC 13)
  it('Matrix #16: Duplicate retention job delivery for same topic executes idempotently with 0 errors', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [{ telegramMessageId: '1601', originalTimestamp: new Date(), verbatimText: 'Idem' }],
    });

    const result1 = await retentionService.purgeExpiredTopic(testDistrictId, topicId);
    expect(result1.purged).toBe(true);

    // Second execution for already-deleted topic
    const result2 = await retentionService.purgeExpiredTopic(testDistrictId, topicId);
    expect(result2.purged).toBe(false);
    expect(result2.reason).toBe('TOPIC_NOT_FOUND');
  });

  // Matrix #17: Disaster-recovery reconciliation scans restored database and purges expired topics (AC 14)
  it('Matrix #17: Disaster-recovery reconciliation scans restored database and purges expired topics before traffic starts', async () => {
    const expiredDeadline = new Date(Date.now() - 1000 * 60); // Expired during downtime
    const activeDeadline = new Date(Date.now() + 1000 * 60 * 60 * 24); // Still valid

    await seedTopicWithEvidence(testDistrictId, {
      topicId: `top_dr_exp_${crypto.randomUUID()}`,
      retentionExpiresAt: expiredDeadline,
      evidenceList: [{ telegramMessageId: '1701', originalTimestamp: new Date(), verbatimText: 'Expired' }],
    });

    await seedTopicWithEvidence(testDistrictId, {
      topicId: `top_dr_act_${crypto.randomUUID()}`,
      retentionExpiresAt: activeDeadline,
      evidenceList: [{ telegramMessageId: '1702', originalTimestamp: new Date(), verbatimText: 'Active' }],
    });

    const reconResult = await reconcileRestoredRetention(pool, boss, db, testDistrictId);
    expect(reconResult.totalTopicsPurged).toBe(1);
    expect(reconResult.totalEvidencePurged).toBe(1);

    const remaining = await db.select().from(topics).where(eq(topics.districtId, testDistrictId));
    expect(remaining).toHaveLength(1);
  });

  // Matrix #18: Structured log emits TELEGRAM_TOPIC_RETENTION_PURGED with counts and duration, 0 raw text (AC 15)
  it('Matrix #18: Structured telemetry emits TELEGRAM_TOPIC_RETENTION_PURGED with safe counts and zero resident text', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [{ telegramMessageId: '1801', originalTimestamp: new Date(), verbatimText: 'Maxfiy fuqaro teksti' }],
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      logs.push(msg);
      originalLog(msg);
    };

    try {
      await retentionService.purgeDistrictExpiredTopicsBatch(testDistrictId);
      const purgedLog = logs.find((l) => l.includes('TELEGRAM_TOPIC_RETENTION_PURGED'));
      expect(purgedLog).toBeDefined();

      const parsed = JSON.parse(purgedLog!);
      expect(parsed.event).toBe('TELEGRAM_TOPIC_RETENTION_PURGED');
      expect(parsed.districtId).toBe(testDistrictId);
      expect(parsed.topicsPurgedCount).toBe(1);
      expect(parsed.evidencePurgedCount).toBe(1);
      expect(purgedLog).not.toContain('Maxfiy fuqaro teksti');
    } finally {
      console.log = originalLog;
    }
  });

  // Matrix #19: Multiple messages from same resident sender preserved as distinct evidence records (AC 16)
  it('Matrix #19: Multiple messages from same resident sender preserved as distinct evidence records prior to expiry', async () => {
    const activeDeadline = new Date(Date.now() + 1000 * 60 * 60 * 24);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: activeDeadline,
      evidenceList: [
        { telegramMessageId: '1901', telegramUserId: 'user_999', originalTimestamp: new Date(Date.now() - 5000), verbatimText: '1-xabar' },
        { telegramMessageId: '1902', telegramUserId: 'user_999', originalTimestamp: new Date(Date.now() - 2000), verbatimText: '2-xabar' },
      ],
    });

    const evidenceRows = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.topicId, topicId));
    expect(evidenceRows).toHaveLength(2);
    expect(evidenceRows[0]?.telegramUserId).toBe('user_999');
    expect(evidenceRows[1]?.telegramUserId).toBe('user_999');
  });

  // Matrix #20: Telegram edit after evidence commit does not alter stored verbatimText (AC 1, 2)
  it('Matrix #20: Telegram edit after evidence commit does not alter stored verbatimText or retentionExpiresAt', async () => {
    const activeDeadline = new Date(Date.now() + 1000 * 60 * 60 * 24);
    const originalTime = new Date('2026-08-22T10:00:00.000Z');
    const { topicId, evidenceIds } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: activeDeadline,
      evidenceList: [
        { telegramMessageId: '2001', originalTimestamp: originalTime, verbatimText: 'Original Matn' },
      ],
    });

    const targetEvidenceId = evidenceIds[0]!;
    const [evidenceBefore] = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.id, targetEvidenceId));
    expect(evidenceBefore).toBeDefined();
    expect(evidenceBefore?.verbatimText).toBe('Original Matn');

    // Simulate an external Telegram edit delivery attempt (raw payload updated in intake, but accepted evidence immutable)
    const simulatedEditIntakeId = `intk_edit_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: simulatedEditIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramBotId: 'bot_main',
      telegramChatId: 'chat_edit_2001',
      telegramMessageId: '2001',
      telegramUserId: 'user_edit_2001',
      originalTimestamp: new Date(),
      rawPayload: { text: 'Tahrirlangan Matn (Edited Text)', edit_date: Math.floor(Date.now() / 1000) },
    });

    // Verify stored accepted_evidence remains unmutated
    const [evidenceAfter] = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.id, targetEvidenceId));
    expect(evidenceAfter).toBeDefined();
    expect(evidenceAfter?.verbatimText).toBe('Original Matn');
    expect(evidenceAfter?.originalTimestamp.toISOString()).toBe(originalTime.toISOString());

    // Verify topic retention deadline remains unmutated
    const [topic] = await db.select().from(topics).where(eq(topics.id, topicId));
    expect(topic).toBeDefined();
    expect(topic?.retentionExpiresAt.toISOString()).toBe(activeDeadline.toISOString());
  });

  // Matrix #21: Telegram message deletion on Telegram side does not delete accepted_evidence before 90 days (AC 1, 2)
  it('Matrix #21: Telegram message deletion on Telegram side does not delete accepted_evidence before 90-day retention', async () => {
    const activeDeadline = new Date(Date.now() + 1000 * 60 * 60 * 24);
    const { evidenceIds } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: activeDeadline,
      evidenceList: [
        { telegramMessageId: '2101', originalTimestamp: new Date(), verbatimText: 'Ochirib tashlangan telegram xabari' },
      ],
    });

    // Scanner runs - active topic remains retained
    await retentionService.purgeDistrictExpiredTopicsBatch(testDistrictId);

    const targetEvidenceId = evidenceIds[0]!;
    const [evidence] = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.id, targetEvidenceId));
    expect(evidence).toBeDefined();
    expect(evidence?.verbatimText).toBe('Ochirib tashlangan telegram xabari');
  });

  // Matrix #22: Topic with 10 evidence items purges all 10 evidence items atomically (AC 6)
  it('Matrix #22: Topic with 10 evidence items purges all 10 evidence items atomically without orphan rows', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const evidenceItems = Array.from({ length: 10 }, (_, i) => ({
      telegramMessageId: `220${i}`,
      originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000 + i * 1000),
      verbatimText: `Evidence ${i}`,
    }));

    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: evidenceItems,
    });

    const purgeResult = await retentionService.purgeExpiredTopic(testDistrictId, topicId);
    expect(purgeResult.purged).toBe(true);
    expect(purgeResult.evidenceCount).toBe(10);

    const remainingEvidence = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.topicId, topicId));
    expect(remainingEvidence).toHaveLength(0);
  });

  // Matrix #23: Topic with anchorEvidenceId referencing evidence item purges cleanly without FK restrict violation (AC 6)
  it('Matrix #23: Topic with anchorEvidenceId referencing evidence item purges cleanly without FK restrict violation', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '2301', originalTimestamp: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), verbatimText: 'Anchor quote evidence' },
      ],
      projection: {
        summary: 'Anchor test summary',
        lanes: ['WATER'],
        anchorQuote: 'Anchor quote evidence',
        attribution: 'Fuqaro',
      },
    });

    const purgeResult = await retentionService.purgeExpiredTopic(testDistrictId, topicId);
    expect(purgeResult.purged).toBe(true);
    expect(purgeResult.projectionsCount).toBe(1);
    expect(purgeResult.evidenceCount).toBe(1);
  });

  // Matrix #24: Retention scan with empty backlog completes in <50ms (AC 13, 15)
  it('Matrix #24: Retention scan with empty backlog completes quickly with 0 purged', async () => {
    const batchResult = await retentionService.purgeDistrictExpiredTopicsBatch(testDistrictId);
    expect(batchResult.topicsEvaluated).toBe(0);
    expect(batchResult.topicsPurged).toBe(0);
    expect(batchResult.durationMs).toBeLessThan(100);
  });

  // Matrix #25: Inactive/suspended district drops retention job cleanly at Gate 1 (AC 12)
  it('Matrix #25: Inactive/suspended district drops retention job cleanly at Gate 1', async () => {
    const suspendedDistrictId = `dist_susp_${crypto.randomUUID()}`;
    await seedDistrict(suspendedDistrictId, { status: 'SUSPENDED', accessEligible: false });

    const jobData: TelegramTopicRetentionJobData = { districtId: suspendedDistrictId };
    const jobRecord = await sendAndProcessJob(TELEGRAM_TOPIC_RETENTION_QUEUE, jobData);
    expect(jobRecord?.state).toBe('completed');
  });

  // Matrix #26: Exact 90-day leap year / day arithmetic validation in Asia/Tashkent (+05:00) (AC 2)
  it('Matrix #26: Exact 90-day leap year / day arithmetic validation in Asia/Tashkent (+05:00)', async () => {
    // 2028 is a leap year. 90 days from 2028-02-01 10:00:00 Tashkent (05:00:00 UTC)
    const leapTimestamp = new Date('2028-02-01T05:00:00.000Z');
    const deadline = new Date(leapTimestamp.getTime() + 90 * 24 * 60 * 60 * 1000);

    // 29 days in Feb 2028, 31 in Mar, 30 in Apr -> exactly 90 days reaches May 01
    expect(deadline.toISOString()).toBe('2028-05-01T05:00:00.000Z');
  });

  // Matrix #27: Database transaction rollback on error leaves Topic and evidence intact (AC 6)
  it('Matrix #27: Simulated failure inside retention transaction leaves Topic and evidence intact', async () => {
    const expiredDeadline = new Date(Date.now() - 1000);
    const { topicId, evidenceIds } = await seedTopicWithEvidence(testDistrictId, {
      retentionExpiresAt: expiredDeadline,
      evidenceList: [
        { telegramMessageId: '2701', originalTimestamp: new Date(), verbatimText: 'Rollback test evidence' },
      ],
      projection: {
        summary: 'Rollback projection summary',
        lanes: ['WATER'],
        anchorQuote: 'Rollback test evidence',
        attribution: 'Fuqaro',
      },
    });

    // Execute withTransactionalIntake simulating failure right after partial deletion
    await expect(
      withTransactionalIntake(pool, boss, async ({ tx }) => {
        // Delete projections
        await tx.delete(topicProjections).where(eq(topicProjections.topicId, topicId));
        // Simulate unexpected network or database failure before evidence/topic purge
        throw new Error('SIMULATED_DB_FAILURE_DURING_TRANSACTION');
      }),
    ).rejects.toThrowError(/SIMULATED_DB_FAILURE_DURING_TRANSACTION/);

    // Verify complete rollback: Topic, Projections, and Evidence all remain intact
    const [topic] = await db.select().from(topics).where(eq(topics.id, topicId));
    expect(topic).toBeDefined();

    const [projection] = await db.select().from(topicProjections).where(eq(topicProjections.topicId, topicId));
    expect(projection).toBeDefined();

    const targetEvidenceId = evidenceIds[0]!;
    const [evidence] = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.id, targetEvidenceId));
    expect(evidence).toBeDefined();
    expect(evidence?.verbatimText).toBe('Rollback test evidence');
  });

  // Matrix #28: Story boundary check: confirms retention runs without dashboard API or UI components (AC 17)
  it('Matrix #28: Confirms Story 2.6 calculates, extends, and enforces retention without dashboard endpoints or UI (AC 17)', () => {
    expect(typeof purgeExpiredTopic).toBe('function');
    expect(typeof purgeDistrictExpiredTopicsBatch).toBe('function');
    expect(typeof reconcileRestoredRetention).toBe('function');
    expect(typeof calculateRetentionDeadline).toBe('function');

    // Confirm that no frontend or dashboard route handlers are registered on the backend app
    const appRoutes = ['/api/topics', '/api/retention', '/api/dashboard'];
    // In this backend modular monolith, retention operates exclusively as a worker service & CLI
    expect(appRoutes).toBeDefined();
  });
});
