import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, and } from 'drizzle-orm';
import {
  createDbPool,
  createDbClient,
  type DbClient,
} from '../src/adapters/db/client.js';
import { districts, telegramIntakeRecords, aiOperations, aiProviderAttempts, topics, acceptedEvidence } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import {
  createBossClient,
  initBossQueues,
  TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  type TelegramTopicAssignmentJobData,
} from '../src/adapters/jobs/boss-client.js';
import { startWorker, stopWorker } from '../src/entrypoints/worker.js';
import { processTopicAssignmentJobs } from '../src/modules/topics/jobs/topic-assignment-job-handler.js';
import {
  assignEvidenceToTopic,
  StaleSnapshotError,
} from '../src/modules/topics/topic-assignment-coordinator.js';
import { TopicMatchingEvaluator } from '../src/modules/topics/topic-matching-evaluator.js';
import { createMockAiGateway, type MockAiGatewayController } from './helpers/mock-ai-gateway.js';
import { AiGatewayError } from '../src/modules/ai/types.js';
import {
  StaleSnapshotRevisionError,
  type AcceptedEvidenceItem,
} from '../src/modules/ai/context-snapshot.js';
import type { TopicMatchingResult } from '../src/modules/topics/topic-matching-evaluator.js';

describe('Story 2.4: Worker Topic Assignment 28-Row Verification Matrix Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;
  let aiController: MockAiGatewayController;
  let testDistrictId: string;
  let testChatId: string;
  let customEvidenceStore: Map<string, AcceptedEvidenceItem[]> = new Map();
  let dynamicResolver: (() => Promise<AcceptedEvidenceItem[] | undefined>) | null = null;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    await ensureDefaultAiProfiles(db);

    const defaultTopicMatchingResponse: TopicMatchingResult = {
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'WATER',
      reasoning: 'Default mock topic matching decision',
    };
    aiController = createMockAiGateway(defaultTopicMatchingResponse);

    boss = createBossClient({ schema: 'pgboss_topic_assignment' });
    await boss.start();
    await initBossQueues(boss);

    // Clean up stale jobs
    await pool.query('DELETE FROM pgboss_topic_assignment.job WHERE name IN ($1, $2)', [
      TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
      TELEGRAM_TOPIC_PROJECTION_QUEUE,
    ]);

    await startWorker({
      boss,
      db,
      pool,
      aiGateway: aiController.gateway,
      queues: [TELEGRAM_TOPIC_ASSIGNMENT_QUEUE],
      injectedEvidenceResolver: async (districtId, mahallaName, calendarDay) => {
        if (dynamicResolver) {
          return dynamicResolver();
        }
        const key = `${districtId}:${mahallaName}:${calendarDay}`;
        return customEvidenceStore.get(key);
      },
    });
  });

  afterAll(async () => {
    await stopWorker(boss);
    await pool.end();
  });

  beforeEach(async () => {
    aiController.mockAdapter.clearHistory();
    customEvidenceStore.clear();
    dynamicResolver = null;

    testDistrictId = `dist_top_${crypto.randomUUID()}`;
    testChatId = `-100${Date.now()}${Math.floor(Math.random() * 1000)}`;

    await pool.query('DELETE FROM pgboss_topic_assignment.job WHERE name IN ($1, $2)', [
      TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
      TELEGRAM_TOPIC_PROJECTION_QUEUE,
    ]);

    // Seed test active district
    await db.insert(districts).values({
      id: testDistrictId,
      name: `TopicDistrict_${crypto.randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
      accessEligible: true,
    });
  });

  /** Helper to insert raw intake record */
  async function seedIntakeRecord(params: {
    intakeId: string;
    messageId: string;
    timestamp: Date;
    text: string;
    mahallaName?: string;
    calendarDay?: string;
    from?: Record<string, any>;
  }) {
    await db.insert(telegramIntakeRecords).values({
      id: params.intakeId,
      districtId: testDistrictId,
      mahallaName: params.mahallaName || 'Guliston',
      telegramBotId: 'bot_test_1',
      telegramChatId: testChatId,
      telegramMessageId: params.messageId,
      originalTimestamp: params.timestamp,
      calendarDay: params.calendarDay || '2026-08-22',
      rawPayload: {
        text: params.text,
        from: params.from || { id: 12345, username: 'citizen_uz', first_name: 'Alisher' },
      },
    });
  }

  /** Helper to send a job and poll until processed */
  async function sendAndProcessJob(jobData: TelegramTopicAssignmentJobData) {
    const jobId = await boss.send(TELEGRAM_TOPIC_ASSIGNMENT_QUEUE, jobData);
    expect(jobId).toBeDefined();

    for (let i = 0; i < 120; i++) {
      const { rows } = await pool.query(
        'SELECT state, output FROM pgboss_topic_assignment.job WHERE id = $1',
        [jobId],
      );
      if (rows.length > 0 && (rows[0].state === 'completed' || rows[0].state === 'failed')) {
        return rows[0];
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Job ${jobId} did not complete within timeout`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Verification Matrix Tests 1 to 28
  // ──────────────────────────────────────────────────────────────────────────

  it('Matrix #1: Direct Reply same-day valid match assigns immediately without AI call (0 cost) (AC 2)', async () => {
    const parentTopicId = `top_parent_${crypto.randomUUID()}`;
    const parentIntakeId = `intk_parent_${crypto.randomUUID()}`;
    const parentEvidenceId = `evi_parent_${crypto.randomUUID()}`;
    const candidateIntakeId = `intk_cand_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T09:00:00Z');

    // Seed existing topic and parent accepted evidence
    await db.insert(topics).values({
      id: parentTopicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    await seedIntakeRecord({
      intakeId: parentIntakeId,
      messageId: '101',
      timestamp: now,
      text: 'Svet o‘chdi 5-domda',
    });

    await db.insert(acceptedEvidence).values({
      id: parentEvidenceId,
      topicId: parentTopicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      intakeRecordId: parentIntakeId,
      telegramChatId: testChatId,
      telegramMessageId: '101',
      originalTimestamp: now,
      verbatimText: 'Svet o‘chdi 5-domda',
      contentType: 'TEXT',
    });

    const candidateTime = new Date('2026-08-22T09:10:00Z');
    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '102',
      timestamp: candidateTime,
      text: 'Bizda ham chiroq o‘chdi',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '102',
      telegramUserId: '12345',
      originalTimestamp: candidateTime.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Bizda ham chiroq o‘chdi',
      replyMetadata: {
        replyToMessageId: '101',
        replyToIsForwarded: false,
        replyToIsBot: false,
      },
      aiOperationId: `aiop_rel_${crypto.randomUUID()}`,
      relevantLanes: ['ELECTRICITY'],
      reasoning: 'Outage confirmed',
    });

    expect(jobResult.state).toBe('completed');
    // Direct reply should make ZERO AI Gateway calls
    expect(aiController.mockAdapter.getCalls().length).toBe(0);

    // Verify candidate is assigned to parentTopicId
    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '102'),
        ),
      );

    expect(candEvidence).toBeDefined();
    expect(candEvidence!.topicId).toBe(parentTopicId);

    // Verify Topic generation incremented to 2 and retention updated
    const [updatedTopic] = await db
      .select()
      .from(topics)
      .where(eq(topics.id, parentTopicId));

    expect(updatedTopic).toBeDefined();
    expect(updatedTopic!.requiredDerivedGeneration).toBe(2);
    expect(updatedTopic!.latestRelevantEvidenceTimestamp.toISOString()).toBe(
      candidateTime.toISOString(),
    );

    // Verify downstream projection queue received generation 2 job
    const { rows: projJobs } = await pool.query(
      'SELECT data FROM pgboss_topic_assignment.job WHERE name = $1',
      [TELEGRAM_TOPIC_PROJECTION_QUEUE],
    );
    expect(projJobs.length).toBe(1);
    expect(projJobs[0].data.topicId).toBe(parentTopicId);
    expect(projJobs[0].data.generation).toBe(2);
  });

  it('Matrix #2: Direct Reply cross-day parent target is ignored and falls back to AI matching (AC 3)', async () => {
    const yesterdayTopicId = `top_yest_${crypto.randomUUID()}`;
    const yesterdayIntakeId = `intk_yest_${crypto.randomUUID()}`;
    const yesterdayEvidenceId = `evi_yest_${crypto.randomUUID()}`;
    const candidateIntakeId = `intk_cand2_${crypto.randomUUID()}`;
    const yesterday = new Date('2026-08-21T09:00:00Z');
    const today = new Date('2026-08-22T09:00:00Z');

    await db.insert(topics).values({
      id: yesterdayTopicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-21',
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: yesterday,
      retentionExpiresAt: new Date(yesterday.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    await seedIntakeRecord({
      intakeId: yesterdayIntakeId,
      messageId: '201',
      timestamp: yesterday,
      text: 'Kecha svet o‘chgan edi',
      calendarDay: '2026-08-21',
    });

    await db.insert(acceptedEvidence).values({
      id: yesterdayEvidenceId,
      topicId: yesterdayTopicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-21',
      intakeRecordId: yesterdayIntakeId,
      telegramChatId: testChatId,
      telegramMessageId: '201',
      originalTimestamp: yesterday,
      verbatimText: 'Kecha svet o‘chgan edi',
      contentType: 'TEXT',
    });

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '202',
      timestamp: today,
      text: 'Bugun ham svet o‘chdi',
      calendarDay: '2026-08-22',
    });

    // Mock AI response for fallback: seeds a new today topic
    const mockAiDecision: TopicMatchingResult = {
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'ELECTRICITY',
      reasoning: 'New today outage topic',
    };
    aiController.mockAdapter.setNextResponse(mockAiDecision);

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '202',
      originalTimestamp: today.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Bugun ham svet o‘chdi',
      replyMetadata: {
        replyToMessageId: '201',
        replyToIsForwarded: false,
        replyToIsBot: false,
      },
      aiOperationId: `aiop_rel_${crypto.randomUUID()}`,
      relevantLanes: ['ELECTRICITY'],
      reasoning: 'New outage',
    });

    expect(jobResult.state).toBe('completed');
    // AI Gateway was invoked because direct reply target was cross-day
    expect(aiController.mockAdapter.getCalls().length).toBe(1);

    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '202',
        )),
      );

    expect(candEvidence).toBeDefined();
    // Must NOT be attached to yesterday's topic
    expect(candEvidence!.topicId).not.toBe(yesterdayTopicId);
  });

  it('Matrix #3: Direct Reply cross-group / cross-district parent target is ignored (AC 3)', async () => {
    const otherChatId = `-100999999999`;
    const otherTopicId = `top_other_${crypto.randomUUID()}`;
    const otherIntakeId = `intk_other_${crypto.randomUUID()}`;
    const candidateIntakeId = `intk_cand3_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T10:00:00Z');

    await db.insert(topics).values({
      id: otherTopicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    await db.insert(telegramIntakeRecords).values({
      id: otherIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      telegramBotId: 'bot_test_1',
      telegramChatId: otherChatId,
      telegramMessageId: '301',
      originalTimestamp: now,
      calendarDay: '2026-08-22',
      rawPayload: { text: 'Boshqa guruhdagi xabar' },
    });

    await db.insert(acceptedEvidence).values({
      id: `evi_other_${crypto.randomUUID()}`,
      topicId: otherTopicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      intakeRecordId: otherIntakeId,
      telegramChatId: otherChatId,
      telegramMessageId: '301',
      originalTimestamp: now,
      verbatimText: 'Boshqa guruhdagi xabar',
      contentType: 'TEXT',
    });

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '302',
      timestamp: now,
      text: 'Bizda gaz yo‘q',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'GAS',
      reasoning: 'New gas issue',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId, // In testChatId, replying to 301 from otherChatId
      telegramMessageId: '302',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Bizda gaz yo‘q',
      replyMetadata: {
        replyToMessageId: '301',
        replyToIsForwarded: false,
        replyToIsBot: false,
      },
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['GAS'],
      reasoning: 'Gas issue',
    });

    expect(jobResult.state).toBe('completed');
    expect(aiController.mockAdapter.getCalls().length).toBe(1);

    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '302',
        )),
      );

    expect(candEvidence).toBeDefined();
    expect(candEvidence!.topicId).not.toBe(otherTopicId);
  });

  it('Matrix #4: Direct Reply to forwarded parent message is isolated and falls back to AI (AC 3)', async () => {
    const candidateIntakeId = `intk_cand4_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T10:15:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '401',
      timestamp: now,
      text: 'Suv toshib ketdi',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'WATER',
      reasoning: 'Self contained water burst',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '401',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Suv toshib ketdi',
      replyMetadata: {
        replyToMessageId: '999',
        replyToIsForwarded: true, // Forwarded parent
        replyToIsBot: false,
      },
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['WATER'],
      reasoning: 'Water pipe burst',
    });

    expect(jobResult.state).toBe('completed');
    expect(aiController.mockAdapter.getCalls().length).toBe(1);
  });

  it('Matrix #5: Topic Seeding: Empty Mahalla Day + Self-Contained Water Burst seeds new Topic (AC 6)', async () => {
    const candidateIntakeId = `intk_cand5_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T11:00:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '501',
      timestamp: now,
      text: 'Suv quvuri yorildi, ko‘chani suv bosdi',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'WATER',
      reasoning: 'First water issue today in Guliston',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '501',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Suv quvuri yorildi, ko‘chani suv bosdi',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['WATER'],
      reasoning: 'Water leak',
    });

    expect(jobResult.state).toBe('completed');

    // Verify 1 new topic created with requiredDerivedGeneration = 1 and appliedDerivedGeneration = 0
    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '501'),
        ),
      );

    expect(candEvidence).toBeDefined();
    expect(candEvidence!.topicId.startsWith('top_')).toBe(true);

    const [createdTopic] = await db
      .select()
      .from(topics)
      .where(eq(topics.id, candEvidence!.topicId));

    expect(createdTopic).toBeDefined();
    expect(createdTopic!.primaryLane).toBe('WATER');
    expect(createdTopic!.status).toBe('ACTIVE');
    expect(createdTopic!.requiredDerivedGeneration).toBe(1);
    expect(createdTopic!.appliedDerivedGeneration).toBe(0);
  });

  it('Matrix #6: Topic Seeding: Empty Mahalla Day + Vague Fragment is discarded as UNASSIGNABLE_VAGUE and raw payload sanitized (AC 7)', async () => {
    const candidateIntakeId = `intk_cand6_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T11:15:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '601',
      timestamp: now,
      text: 'Bizda ham',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'UNASSIGNABLE_VAGUE',
      matched_topic_id: null,
      primary_lane: null,
      reasoning: 'Vague fragment with no active topic to anchor to',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '601',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Bizda ham',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['ELECTRICITY'],
      reasoning: 'Ambiguous',
    });

    expect(jobResult.state).toBe('completed');

    // 0 evidence records created
    const evidenceRows = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '601'),
        ),
      );
    expect(evidenceRows.length).toBe(0);

    // Raw payload sanitized in telegram_intake_records
    const [intakeRec] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.id, candidateIntakeId));

    expect(intakeRec).toBeDefined();
    expect((intakeRec!.rawPayload as any).status).toBe('EXCLUDED');
    expect((intakeRec!.rawPayload as any).reason).toBe('UNASSIGNABLE_VAGUE');
    expect((intakeRec!.rawPayload as any).purgedAt).toBeDefined();
  });

  it('Matrix #7: Fallback Matching: Voltage drop ("tok 160V") matches existing electricity topic (AC 5)', async () => {
    const topicId = `top_elec_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T12:00:00Z');

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    const candidateIntakeId = `intk_cand7_${crypto.randomUUID()}`;
    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '701',
      timestamp: new Date('2026-08-22T12:15:00Z'),
      text: 'Tok 160V bo‘lib qoldi',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'MATCH_EXISTING_TOPIC',
      matched_topic_id: topicId,
      primary_lane: null,
      reasoning: 'Voltage drop belongs to active electricity topic',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '701',
      originalTimestamp: '2026-08-22T12:15:00Z',
      contentType: 'TEXT',
      verbatimText: 'Tok 160V bo‘lib qoldi',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['ELECTRICITY'],
      reasoning: 'Voltage drop',
    });

    expect(jobResult.state).toBe('completed');

    const [updatedTopic] = await db.select().from(topics).where(eq(topics.id, topicId));
    expect(updatedTopic).toBeDefined();
    expect(updatedTopic!.requiredDerivedGeneration).toBe(2);
    expect(updatedTopic!.primaryLane).toBe('ELECTRICITY'); // Immutability of primary lane
  });

  it('Matrix #8: Fallback Matching: Water burst with active electricity topic creates new WATER Topic (lane isolation) (AC 5, 6)', async () => {
    const elecTopicId = `top_elec_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T12:30:00Z');

    await db.insert(topics).values({
      id: elecTopicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    const candidateIntakeId = `intk_cand8_${crypto.randomUUID()}`;
    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '801',
      timestamp: new Date('2026-08-22T12:35:00Z'),
      text: 'Kanalizatsiya quvuri yorildi',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'WATER',
      reasoning: 'Distinct water service issue independent of electricity outage',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '801',
      originalTimestamp: '2026-08-22T12:35:00Z',
      contentType: 'TEXT',
      verbatimText: 'Kanalizatsiya quvuri yorildi',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['WATER'],
      reasoning: 'Water leak',
    });

    expect(jobResult.state).toBe('completed');

    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '801'),
        ),
      );

    expect(candEvidence).toBeDefined();
    expect(candEvidence!.topicId).not.toBe(elecTopicId);
    const [newTopic] = await db.select().from(topics).where(eq(topics.id, candEvidence!.topicId));
    expect(newTopic).toBeDefined();
    expect(newTopic!.primaryLane).toBe('WATER');
  });

  it('Matrix #9: Fallback Matching: Resident restoration notice ("svet yondi") matches active topic (AC 5)', async () => {
    const topicId = `top_rest_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T13:00:00Z');

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    const candidateIntakeId = `intk_cand9_${crypto.randomUUID()}`;
    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '901',
      timestamp: new Date('2026-08-22T13:30:00Z'),
      text: 'Svet yondi, rahmat',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'MATCH_EXISTING_TOPIC',
      matched_topic_id: topicId,
      primary_lane: null,
      reasoning: 'Power restoration notice for active electricity topic',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '901',
      originalTimestamp: '2026-08-22T13:30:00Z',
      contentType: 'TEXT',
      verbatimText: 'Svet yondi, rahmat',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['ELECTRICITY'],
      reasoning: 'Power restored',
    });

    expect(jobResult.state).toBe('completed');
    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '901'),
        ),
      );
    expect(candEvidence).toBeDefined();
    expect(candEvidence!.topicId).toBe(topicId);
  });

  it('Matrix #10: Fallback Matching: Issue recurrence ("yana o‘chdi") matches active topic (AC 5)', async () => {
    const topicId = `top_recur_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T14:00:00Z');

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 2,
      appliedDerivedGeneration: 0,
    });

    const candidateIntakeId = `intk_cand10_${crypto.randomUUID()}`;
    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '1001',
      timestamp: new Date('2026-08-22T14:15:00Z'),
      text: 'Yana o‘chdi svet',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'MATCH_EXISTING_TOPIC',
      matched_topic_id: topicId,
      primary_lane: null,
      reasoning: 'Power cut recurrence matches ongoing electricity disruption topic',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '1001',
      originalTimestamp: '2026-08-22T14:15:00Z',
      contentType: 'TEXT',
      verbatimText: 'Yana o‘chdi svet',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['ELECTRICITY'],
      reasoning: 'Recurrence',
    });

    expect(jobResult.state).toBe('completed');
    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '1001'),
        ),
      );
    expect(candEvidence).toBeDefined();
    expect(candEvidence!.topicId).toBe(topicId);
  });

  it('Matrix #11: Fallback Matching: Contradictory resident reports match active topic (AC 5)', async () => {
    const topicId = `top_contra_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T15:00:00Z');

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'GAS',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    const candidateIntakeId = `intk_cand11_${crypto.randomUUID()}`;
    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '1101',
      timestamp: new Date('2026-08-22T15:10:00Z'),
      text: 'Bizda gaz bor, sizlarda qaysi domda yo‘q?',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'MATCH_EXISTING_TOPIC',
      matched_topic_id: topicId,
      primary_lane: null,
      reasoning: 'Contradictory inquiry regards the same active gas outage',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '1101',
      originalTimestamp: '2026-08-22T15:10:00Z',
      contentType: 'TEXT',
      verbatimText: 'Bizda gaz bor, sizlarda qaysi domda yo‘q?',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['GAS'],
      reasoning: 'Gas inquiry',
    });

    expect(jobResult.state).toBe('completed');
    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '1101'),
        ),
      );
    expect(candEvidence).toBeDefined();
    expect(candEvidence!.topicId).toBe(topicId);
  });

  it('Matrix #12: Fallback Matching: Road pothole issue creates new HOKIM_RELATED Topic (AC 6)', async () => {
    const candidateIntakeId = `intk_cand12_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T15:30:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '1201',
      timestamp: now,
      text: 'Yo‘l o‘rtasida katta chuqur paydo bo‘ldi, mashinalar tushib qolyapti',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'HOKIM_RELATED',
      reasoning: 'Road pothole infrastructure issue for Hokimiyat intervention',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '1201',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Yo‘l o‘rtasida katta chuqur paydo bo‘ldi, mashinalar tushib qolyapti',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['HOKIM_RELATED'],
      reasoning: 'Road pothole',
    });

    expect(jobResult.state).toBe('completed');
    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '1201'),
        ),
      );
    expect(candEvidence).toBeDefined();
    const [topic] = await db.select().from(topics).where(eq(topics.id, candEvidence!.topicId));
    expect(topic).toBeDefined();
    expect(topic!.primaryLane).toBe('HOKIM_RELATED');
  });

  it('Matrix #13: Vague Discard: Vague fragment with no match is discarded and purged (AC 7)', async () => {
    const candidateIntakeId = `intk_cand13_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T15:45:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '1301',
      timestamp: now,
      text: 'Qachon beradi?',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'UNASSIGNABLE_VAGUE',
      matched_topic_id: null,
      primary_lane: null,
      reasoning: 'Vague query cannot be assigned to any specific topic',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '1301',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Qachon beradi?',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['ELECTRICITY'],
      reasoning: 'Vague',
    });

    expect(jobResult.state).toBe('completed');
    const [intakeRec] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.id, candidateIntakeId));

    expect(intakeRec).toBeDefined();
    expect((intakeRec!.rawPayload as any).status).toBe('EXCLUDED');
  });

  it('Matrix #14: Verbatim Evidence: Exact Cyrillic/Uzbek emojis preserved in accepted_evidence (AC 8)', async () => {
    const candidateIntakeId = `intk_cand14_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T16:00:00Z');
    const verbatimCyrillic = 'Свет ўчди, трансфоррматор ёнди ⚡️💡🔥';

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '1401',
      timestamp: now,
      text: verbatimCyrillic,
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'ELECTRICITY',
      reasoning: 'Transformer fire reported in Cyrillic Uzbek',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '1401',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: verbatimCyrillic,
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['ELECTRICITY'],
      reasoning: 'Transformer fire',
    });

    expect(jobResult.state).toBe('completed');
    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '1401'),
        ),
      );

    expect(candEvidence).toBeDefined();
    expect(candEvidence!.verbatimText).toBe(verbatimCyrillic);
  });

  it('Matrix #15: Privacy: Whitelisted user metadata stored without phone number inference (AC 8, AD-11)', async () => {
    const candidateIntakeId = `intk_cand15_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T16:15:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '1501',
      timestamp: now,
      text: 'Musorxonadan badbo‘y hid kelyapti',
      from: {
        id: 998877,
        username: 'tashkent_citizen',
        first_name: 'Jasur',
        last_name: 'Karimov',
        phone_number: '+998901234567', // Should NOT be persisted in whitelisted fields
      },
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'WASTE',
      reasoning: 'Waste odor issue',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '1501',
      telegramUserId: '998877',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Musorxonadan badbo‘y hid kelyapti',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['WASTE'],
      reasoning: 'Waste issue',
    });

    expect(jobResult.state).toBe('completed');
    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '1501'),
        ),
      );

    expect(candEvidence).toBeDefined();
    const userMeta = candEvidence!.userMetadata as Record<string, any>;
    expect(userMeta.telegramUserId).toBe('998877');
    expect(userMeta.username).toBe('tashkent_citizen');
    expect(userMeta.firstName).toBe('Jasur');
    expect(userMeta.lastName).toBe('Karimov');
    expect(userMeta.phoneNumber).toBeUndefined();
    expect(userMeta.phone_number).toBeUndefined();
  });

  it('Matrix #16: Immutability: Telegram message edit leaves stored accepted_evidence unmodified (AC 9)', async () => {
    const candidateIntakeId = `intk_cand16_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T16:30:00Z');
    const originalText = 'Suv bosdi';

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '1601',
      timestamp: now,
      text: originalText,
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'WATER',
      reasoning: 'Water leak',
    });

    await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '1601',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: originalText,
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['WATER'],
      reasoning: 'Water issue',
    });

    // Simulate Telegram message edit in raw intake table
    await db
      .update(telegramIntakeRecords)
      .set({ rawPayload: { text: 'Tahrirlangan matn: hammasi yaxshi' } })
      .where(eq(telegramIntakeRecords.id, candidateIntakeId));

    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '1601'),
        ),
      );

    // Stored accepted evidence remains the original immutable verbatimText
    expect(candEvidence).toBeDefined();
    expect(candEvidence!.verbatimText).toBe(originalText);
  });

  it('Matrix #17: Immutability: Telegram deletion does not delete accepted_evidence (AC 9)', async () => {
    const candidateIntakeId = `intk_cand17_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T16:45:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '1701',
      timestamp: now,
      text: 'Chiroq uchdi',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'ELECTRICITY',
      reasoning: 'Power cut',
    });

    await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '1701',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Chiroq uchdi',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['ELECTRICITY'],
      reasoning: 'Outage',
    });

    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '1701'),
        ),
      );

    expect(candEvidence).toBeDefined();
  });

  it('Matrix #18: Retention: Exact 90-day retention calculated via millisecond arithmetic (AC 10)', async () => {
    const candidateIntakeId = `intk_cand18_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T17:00:00.123Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '1801',
      timestamp: now,
      text: 'Musor to‘lib ketdi',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'WASTE',
      reasoning: 'Trash pileup',
    });

    await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '1801',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Musor to‘lib ketdi',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['WASTE'],
      reasoning: 'Waste',
    });

    const [candEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '1801'),
        ),
      );

    expect(candEvidence).toBeDefined();
    const [createdTopic] = await db
      .select()
      .from(topics)
      .where(eq(topics.id, candEvidence!.topicId));

    expect(createdTopic).toBeDefined();
    const expectedExpiryMs = now.getTime() + 90 * 24 * 60 * 60 * 1000;
    expect(createdTopic!.retentionExpiresAt.getTime()).toBe(expectedExpiryMs);
  });

  it('Matrix #19: Context Revision: Advances monotonically by 1 per evidence item (AC 11)', async () => {
    const topicId = `top_rev_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T17:15:00Z');

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'GAS',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    // Seed 2 evidence items
    const in1 = `intk_rev1_${crypto.randomUUID()}`;
    const in2 = `intk_rev2_${crypto.randomUUID()}`;
    await seedIntakeRecord({ intakeId: in1, messageId: '1901', timestamp: now, text: 'Gaz past' });
    await seedIntakeRecord({
      intakeId: in2,
      messageId: '1902',
      timestamp: new Date('2026-08-22T17:20:00Z'),
      text: 'Bizda ham gaz yo‘q',
    });

    await db.insert(acceptedEvidence).values([
      {
        id: `evi_rev1_${crypto.randomUUID()}`,
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        intakeRecordId: in1,
        telegramChatId: testChatId,
        telegramMessageId: '1901',
        originalTimestamp: now,
        verbatimText: 'Gaz past',
        contentType: 'TEXT',
      },
      {
        id: `evi_rev2_${crypto.randomUUID()}`,
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        intakeRecordId: in2,
        telegramChatId: testChatId,
        telegramMessageId: '1902',
        originalTimestamp: new Date('2026-08-22T17:20:00Z'),
        verbatimText: 'Bizda ham gaz yo‘q',
        contentType: 'TEXT',
      },
    ]);

    const { getMahallaDailySnapshot } = await import('../src/modules/ai/context-snapshot.js');
    const snapshot = await getMahallaDailySnapshot(db, testDistrictId, 'Guliston', '2026-08-22');
    expect(snapshot.contextRevision).toBe(2);
  });

  it('Matrix #20: Context Order: Strictly deterministic originalTimestamp ASC -> msgId ASC -> id ASC (AC 11)', async () => {
    const topicId = `top_ord_${crypto.randomUUID()}`;
    const t1 = new Date('2026-08-22T10:00:00Z');
    const t2 = new Date('2026-08-22T10:30:00Z');

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: t2,
      retentionExpiresAt: new Date(t2.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    const inA = `intk_a_${crypto.randomUUID()}`;
    const inB = `intk_b_${crypto.randomUUID()}`;
    const inC = `intk_c_${crypto.randomUUID()}`;
    await seedIntakeRecord({ intakeId: inA, messageId: '2001', timestamp: t1, text: 'Msg 1' });
    await seedIntakeRecord({ intakeId: inB, messageId: '2002', timestamp: t1, text: 'Msg 2' });
    await seedIntakeRecord({ intakeId: inC, messageId: '2003', timestamp: t2, text: 'Msg 3' });

    await db.insert(acceptedEvidence).values([
      {
        id: `evi_ccc_${crypto.randomUUID()}`,
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        intakeRecordId: inC,
        telegramChatId: testChatId,
        telegramMessageId: '2003',
        originalTimestamp: t2,
        verbatimText: 'Msg 3',
        contentType: 'TEXT',
      },
      {
        id: `evi_bbb_${crypto.randomUUID()}`,
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        intakeRecordId: inB,
        telegramChatId: testChatId,
        telegramMessageId: '2002',
        originalTimestamp: t1,
        verbatimText: 'Msg 2',
        contentType: 'TEXT',
      },
      {
        id: `evi_aaa_${crypto.randomUUID()}`,
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        intakeRecordId: inA,
        telegramChatId: testChatId,
        telegramMessageId: '2001',
        originalTimestamp: t1,
        verbatimText: 'Msg 1',
        contentType: 'TEXT',
      },
    ]);

    const { getMahallaDailySnapshot } = await import('../src/modules/ai/context-snapshot.js');
    const snapshot = await getMahallaDailySnapshot(db, testDistrictId, 'Guliston', '2026-08-22');

    expect(snapshot.evidence.map((e) => e.telegramMessageId)).toEqual(['2001', '2002', '2003']);
  });

  it('Matrix #21: CAS Concurrency: In-flight context revision advance triggers STALE_SNAPSHOT retry (AC 12)', async () => {
    const candidateIntakeId = `intk_cand21_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T18:00:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '2101',
      timestamp: now,
      text: 'Svet o‘chdi',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'ELECTRICITY',
      reasoning: 'Outage',
    });

    // Simulate concurrent worker committing evidence during AI evaluation
    let callCount = 0;
    dynamicResolver = async () => {
      callCount++;
      if (callCount === 1) {
        return []; // Initial snapshot revision 0
      } else {
        // Revision advanced to 1 concurrently
        return [
          {
            id: 'evi_concurrent',
            topicId: 'top_conc',
            telegramMessageId: '9999',
            originalTimestamp: now.toISOString(),
            verbatimText: 'Boshqa xabar',
            lane: 'ELECTRICITY',
          },
        ];
      }
    };

    const jobId = await boss.send(
      TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
      {
        intakeId: candidateIntakeId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        telegramChatId: testChatId,
        telegramMessageId: '2101',
        originalTimestamp: now.toISOString(),
        contentType: 'TEXT',
        verbatimText: 'Svet o‘chdi',
        replyMetadata: null,
        aiOperationId: `aiop_${crypto.randomUUID()}`,
        relevantLanes: ['ELECTRICITY'],
        reasoning: 'Outage',
      },
      { retryLimit: 0 },
    );

    let finalState = '';
    for (let i = 0; i < 30; i++) {
      const { rows } = await pool.query(
        'SELECT state, output FROM pgboss_topic_assignment.job WHERE id = $1',
        [jobId],
      );
      if (rows.length > 0) {
        finalState = rows[0].state;
        if (finalState === 'failed' || rows[0].output?.message?.includes('STALE_SNAPSHOT')) {
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Verify STALE_SNAPSHOT aborted the commit
    const { rows } = await pool.query(
      'SELECT output FROM pgboss_topic_assignment.job WHERE id = $1',
      [jobId],
    );
    expect(JSON.stringify(rows[0]?.output)).toContain('STALE_SNAPSHOT');
  });

  // L3-P05-10: the CAS re-read and the commit must share one session, and the UPDATE
  // must be guarded by the generation it read. This test makes BOTH concurrent
  // assignments pass the CAS check (identical injected snapshot, so identical revision
  // and fingerprint) — which isolates the generation predicate on the UPDATE as the
  // only thing that can stop a lost update.
  it('L3-P05-10: two concurrent assignments against one Topic cannot both commit', async () => {
    const topicId = `top_race_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T12:00:00Z');
    const mahallaName = 'Guliston';

    // The Topic both assignments will resolve to, at generation 1.
    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay: '2026-08-22',
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 1,
      createdAt: now,
      updatedAt: now,
    });

    // A FIXED injected snapshot. The resolver is consulted twice per assignment (initial
    // snapshot, then the in-transaction CAS re-read), so both calls see an identical
    // revision and fingerprint and the CAS check passes for BOTH.
    const injectedEvidence: AcceptedEvidenceItem[] = [
      {
        id: `evi_seed_${crypto.randomUUID()}`,
        topicId,
        telegramMessageId: '9001',
        originalTimestamp: now.toISOString(),
        verbatimText: 'Suv bosimi past',
        lane: 'WATER',
      },
    ];
    customEvidenceStore.set(`${testDistrictId}:${mahallaName}:2026-08-22`, injectedEvidence);

    // Both assignments match the existing Topic by EXACT id, and both spend the same
    // mock latency so they arrive at the commit block together.
    const matchResponse = {
      decision: 'MATCH_EXISTING_TOPIC',
      matched_topic_id: topicId,
      primary_lane: 'WATER',
      reasoning: 'Concurrent assignment race',
    };
    // Both calls must be IN FLIGHT at the same time. Two delayed behaviors — one each —
    // keep them overlapping. An undelayed response would let the first assignment commit
    // before the second even reached its CAS check, and the test would pass without
    // exercising the predicate it exists to prove.
    aiController.mockAdapter.enqueueBehavior({ response: matchResponse, delayMs: 50 });
    aiController.mockAdapter.enqueueBehavior({ response: matchResponse, delayMs: 50 });

    // Two DISTINCT messages. They must differ on telegramMessageId: the schema enforces
    // uniqueness on (district_id, telegram_chat_id, telegram_message_id), and the
    // coordinator's own idempotency stage keys on the same triple — identical ids would
    // make the second call short-circuit as SKIPPED_DUPLICATE instead of racing.
    const candidates = [
      { intakeId: `intk_race_a_${crypto.randomUUID()}`, messageId: '9001' },
      { intakeId: `intk_race_b_${crypto.randomUUID()}`, messageId: '9002' },
    ];
    for (const c of candidates) {
      await seedIntakeRecord({
        intakeId: c.intakeId,
        messageId: c.messageId,
        timestamp: now,
        text: 'Suv bosimi past',
      });
    }

    const evaluator = new TopicMatchingEvaluator(aiController.gateway);
    const makeInput = (intakeId: string, telegramMessageId: string): TelegramTopicAssignmentJobData => ({
      intakeId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId,
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Suv bosimi past',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['WATER'],
      reasoning: 'Outage',
    });

    const settled = await Promise.allSettled(
      candidates.map((c) =>
        assignEvidenceToTopic(
          {
            db,
            pool,
            boss,
            topicMatchingEvaluator: evaluator,
            injectedEvidenceResolver: async () => injectedEvidence,
          },
          makeInput(c.intakeId, c.messageId),
        ),
      ),
    );

    const rejected = settled.filter((s) => s.status === 'rejected');
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');

    // The losing assignment must fail with the stale signal (so pg-boss retries it),
    // not silently commit on top of the winner.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const loserReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(String(loserReason?.message)).toContain('STALE_SNAPSHOT');

    // And it must be the GENERATION arm, not the snapshot-revision arm. Both
    // assignments read an identical injected snapshot, so the CAS check passes for
    // both and the generation predicate is the only mechanism that can reject —
    // which makes the discriminated reason a deterministic assertion rather than a
    // timing-dependent one. This pins `GENERATION_ADVANCED`, the reason variant that
    // only exists because this predicate added a second stale site.
    expect(loserReason).toBeInstanceOf(StaleSnapshotError);
    expect((loserReason as StaleSnapshotError).reason).toBe('GENERATION_ADVANCED');
    expect((loserReason as StaleSnapshotError).cause).toBeUndefined();

    // The generation must have advanced EXACTLY ONCE (1 -> 2), not twice, and not 1 -> 2
    // twice over. Two commits would leave the Topic projected at a generation that does
    // not account for the second item's evidence.
    const [finalTopic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
    expect(finalTopic?.requiredDerivedGeneration).toBe(2);

    // And only the winner's evidence may exist. Without the generation predicate both
    // assignments would insert, adding evidence the projection would never pick up.
    const evidenceRows = await db
      .select()
      .from(acceptedEvidence)
      .where(eq(acceptedEvidence.topicId, topicId));
    expect(evidenceRows.length).toBe(1);
  });

  it('Matrix #22: Lifecycle Gate 1: Inactive District drops job cleanly before AI invocation (AC 13)', async () => {
    const inactiveDistrictId = `dist_inact_1_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: inactiveDistrictId,
      name: `InactiveDist1_${crypto.randomUUID().slice(0, 8)}`,
      status: 'SUSPENDED',
      accessEligible: false,
    });

    const candidateIntakeId = `intk_cand22_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T18:30:00Z');

    await db.insert(telegramIntakeRecords).values({
      id: candidateIntakeId,
      districtId: inactiveDistrictId,
      mahallaName: 'Guliston',
      telegramBotId: 'bot_test_1',
      telegramChatId: testChatId,
      telegramMessageId: '2201',
      originalTimestamp: now,
      calendarDay: '2026-08-22',
      rawPayload: { text: 'Svet yo‘q' },
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: inactiveDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '2201',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Svet yo‘q',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['ELECTRICITY'],
      reasoning: 'Outage',
    });

    expect(jobResult.state).toBe('completed');
    // 0 AI Gateway calls
    expect(aiController.mockAdapter.getCalls().length).toBe(0);
    // 0 accepted evidence created
    const evidenceRows = await db
      .select()
      .from(acceptedEvidence)
      .where(eq(acceptedEvidence.districtId, inactiveDistrictId));
    expect(evidenceRows.length).toBe(0);
  });

  it('Matrix #23: Lifecycle Gate 2: Inactive District pre-commit aborts transaction cleanly (AC 13)', async () => {
    const candidateIntakeId = `intk_cand23_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T18:45:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '2301',
      timestamp: now,
      text: 'Suv toshdi',
    });

    // Mock AI response that triggers mid-flight district deactivation
    aiController.mockAdapter.enqueueBehavior({
      delayMs: 200,
      response: {
        decision: 'NEW_TOPIC',
        matched_topic_id: null,
        primary_lane: 'WATER',
        reasoning: 'Water leak',
      },
    });

    const jobPromise = sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '2301',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Suv toshdi',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['WATER'],
      reasoning: 'Water leak',
    });

    // Deactivate district while AI is running
    await new Promise((r) => setTimeout(r, 50));
    await db
      .update(districts)
      .set({ status: 'SUSPENDED', accessEligible: false })
      .where(eq(districts.id, testDistrictId));

    const jobResult = await jobPromise;
    expect(jobResult.state).toBe('completed');

    // Gate 2 aborted commit: 0 topics or evidence created
    const evidenceRows = await db
      .select()
      .from(acceptedEvidence)
      .where(eq(acceptedEvidence.districtId, testDistrictId));
    expect(evidenceRows.length).toBe(0);
  });

  it('Matrix #24: AI Traceability: Records ai_operations with prof_match_2026_08_v1 and ai_provider_attempts (AC 14)', async () => {
    const candidateIntakeId = `intk_cand24_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T19:00:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '2401',
      timestamp: now,
      text: 'Musor tozalansin',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'WASTE',
      reasoning: 'Waste cleanup complaint',
    });

    const jobResult = await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '2401',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Musor tozalansin',
      replyMetadata: null,
      aiOperationId: `aiop_rel_${crypto.randomUUID()}`,
      relevantLanes: ['WASTE'],
      reasoning: 'Waste',
    });

    expect(jobResult.state).toBe('completed');

    const [matchingOp] = await db
      .select()
      .from(aiOperations)
      .where(
        and(
          eq(aiOperations.districtId, testDistrictId),
          eq(aiOperations.operationType, 'TOPIC_MATCHING'),
          eq(aiOperations.targetId, candidateIntakeId),
        ),
      );

    expect(matchingOp).toBeDefined();
    expect(matchingOp!.pinnedProfileId).toBe('prof_match_2026_08_v1');
    expect(matchingOp!.finalStatus).toBe('COMPLETED_RELEVANT');

    const attempts = await db
      .select()
      .from(aiProviderAttempts)
      .where(eq(aiProviderAttempts.operationId, matchingOp!.id));

    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts[0]!.status).toBe('SUCCESS');
  });

  it('Matrix #25: Explicit AI Failure: Provider error triggers pg-boss retry without creating fake topic (AC 15)', async () => {
    const candidateIntakeId = `intk_cand25_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T19:15:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '2501',
      timestamp: now,
      text: 'Svet o‘chdi',
    });

    aiController.mockAdapter.setNextError(
      new AiGatewayError('PROVIDER_TIMEOUT', 'Gateway timeout contacting LLM', {
        retryable: true,
      }),
    );

    const jobId = await boss.send(
      TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
      {
        intakeId: candidateIntakeId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        telegramChatId: testChatId,
        telegramMessageId: '2501',
        originalTimestamp: now.toISOString(),
        contentType: 'TEXT',
        verbatimText: 'Svet o‘chdi',
        replyMetadata: null,
        aiOperationId: `aiop_${crypto.randomUUID()}`,
        relevantLanes: ['ELECTRICITY'],
        reasoning: 'Outage',
      },
      { retryLimit: 0 },
    );

    for (let i = 0; i < 20; i++) {
      const { rows } = await pool.query(
        'SELECT state, output FROM pgboss_topic_assignment.job WHERE id = $1',
        [jobId],
      );
      if (rows.length > 0 && rows[0].state === 'failed') {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // 0 evidence created on provider failure
    const evidenceRows = await db
      .select()
      .from(acceptedEvidence)
      .where(eq(acceptedEvidence.districtId, testDistrictId));
    expect(evidenceRows.length).toBe(0);
  });

  it('Matrix #26: Idempotency & Redelivery: Duplicate message catches 23505 gracefully (AC 16)', async () => {
    const candidateIntakeId = `intk_cand26_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T19:30:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '2601',
      timestamp: now,
      text: 'Gaz sizib chiqmoqda',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'GAS',
      reasoning: 'Gas leak',
    });

    const jobData: TelegramTopicAssignmentJobData = {
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '2601',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Gaz sizib chiqmoqda',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['GAS'],
      reasoning: 'Gas leak',
    };

    const firstRun = await sendAndProcessJob(jobData);
    expect(firstRun.state).toBe('completed');

    // Redelivery with same messageId
    const secondRun = await sendAndProcessJob(jobData);
    expect(secondRun.state).toBe('completed');

    // Exactly 1 evidence record exists
    const evidenceRows = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '2601'),
        ),
      );
    expect(evidenceRows.length).toBe(1);
  });

  it('Matrix #27: Downstream Topic Projection Enqueue: Enqueues TELEGRAM_TOPIC_PROJECTION_QUEUE atomically (AC 17)', async () => {
    const candidateIntakeId = `intk_cand27_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T19:45:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '2701',
      timestamp: now,
      text: 'Yo‘l ta’mirlansin',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'HOKIM_RELATED',
      reasoning: 'Road repair appeal',
    });

    await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '2701',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Yo‘l ta’mirlansin',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['HOKIM_RELATED'],
      reasoning: 'Road repair',
    });

    const { rows: projectionJobs } = await pool.query(
      'SELECT data FROM pgboss_topic_assignment.job WHERE name = $1',
      [TELEGRAM_TOPIC_PROJECTION_QUEUE],
    );

    expect(projectionJobs.length).toBe(1);
    expect(projectionJobs[0].data.mahallaName).toBe('Guliston');
    expect(projectionJobs[0].data.calendarDay).toBe('2026-08-22');
    expect(projectionJobs[0].data.generation).toBe(1);
  });

  it('Matrix #28: Story Boundary: Confirms Story 2.4 does not calculate summaries or lane projections (AC 17)', async () => {
    const candidateIntakeId = `intk_cand28_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T20:00:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '2801',
      timestamp: now,
      text: 'Suv bosdi ko‘chani',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'WATER',
      reasoning: 'Water pipe burst',
    });

    await sendAndProcessJob({
      intakeId: candidateIntakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '2801',
      originalTimestamp: now.toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Suv bosdi ko‘chani',
      replyMetadata: null,
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['WATER'],
      reasoning: 'Water leak',
    });

    // Verify Story 2.4 only outputs `{ topicId, districtId, mahallaName, calendarDay, generation }` to projection queue
    const { rows: projJobs } = await pool.query(
      'SELECT data FROM pgboss_topic_assignment.job WHERE name = $1',
      [TELEGRAM_TOPIC_PROJECTION_QUEUE],
    );

    expect(projJobs.length).toBe(1);
    const data = projJobs[0].data;
    expect(data.summary).toBeUndefined();
    expect(data.anchor_evidence_id).toBeUndefined();
    expect(data.lane_distribution).toBeUndefined();
  });

  it('preserves userMetadata on burst messages when message 1 is excluded chatter and subsequent messages are accepted', async () => {
    const intakeId1 = `intk_burst_chatter_${crypto.randomUUID()}`;
    const intakeId2 = `intk_burst_signal_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T10:00:00Z');

    // Message 1 (chatter): raw payload has exclusion metadata merged (non-destructively)
    await db.insert(telegramIntakeRecords).values({
      id: intakeId1,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      telegramBotId: 'bot_test_1',
      telegramChatId: testChatId,
      telegramMessageId: '2901',
      originalTimestamp: now,
      calendarDay: '2026-08-22',
      rawPayload: {
        text: 'salom',
        from: { id: 7512582881, username: 'ZubaydullaOkhunboboyev', first_name: 'Zubaydulla', last_name: 'Okhunboboyev' },
        status: 'EXCLUDED',
        exclusionReason: 'GENERAL_CHATTER',
      },
    });

    // Message 2 (signal): intact payload
    await seedIntakeRecord({
      intakeId: intakeId2,
      messageId: '2902',
      timestamp: new Date(now.getTime() + 5000),
      text: 'Gazdan xabar bormi',
      from: { id: 7512582881, username: 'ZubaydullaOkhunboboyev', first_name: 'Zubaydulla', last_name: 'Okhunboboyev' },
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'GAS',
      reasoning: 'Gas supply query',
    });

    // Send topic assignment job as emitted by semantic-relevance (re-anchored to intakeId2 with userMetadata)
    await sendAndProcessJob({
      intakeId: intakeId2,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      telegramChatId: testChatId,
      telegramMessageId: '2902',
      originalTimestamp: new Date(now.getTime() + 5000).toISOString(),
      contentType: 'TEXT',
      verbatimText: 'Gazdan xabar bormi',
      replyMetadata: null,
      userMetadata: {
        telegramUserId: '7512582881',
        username: 'ZubaydullaOkhunboboyev',
        firstName: 'Zubaydulla',
        lastName: 'Okhunboboyev',
      },
      aiOperationId: `aiop_${crypto.randomUUID()}`,
      relevantLanes: ['GAS'],
      reasoning: 'Gas supply report',
      burstMessages: [
        {
          intakeId: intakeId2,
          telegramMessageId: '2902',
          originalTimestamp: new Date(now.getTime() + 5000).toISOString(),
          contentType: 'TEXT',
          verbatimText: 'Gazdan xabar bormi',
          replyMetadata: null,
          userMetadata: {
            telegramUserId: '7512582881',
            username: 'ZubaydullaOkhunboboyev',
            firstName: 'Zubaydulla',
            lastName: 'Okhunboboyev',
          },
        },
      ],
    });

    // Verify accepted_evidence record contains complete user_metadata
    const evidence = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, '2902'),
        ),
      )
      .limit(1);

    expect(evidence.length).toBe(1);
    expect(evidence[0]!.userMetadata).toEqual({
      telegramUserId: '7512582881',
      username: 'ZubaydullaOkhunboboyev',
      firstName: 'Zubaydulla',
      lastName: 'Okhunboboyev',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // L3-P05-09 / L3-P05-15 — the coordinator's error contract must be typed
  // ──────────────────────────────────────────────────────────────────────────

  // DECISIVE falsification arm. The stale-snapshot branch in the handler is the
  // retry-signalling path, and it currently selects that branch by matching a
  // STRING PREFIX off the error message. Any unrelated error that happens to
  // carry the same prefix text — a wrapped driver error, a different module's
  // prose — is therefore misrouted into the stale path and logged as a benign
  // retry instead of a hard failure. Only a typed narrowing can tell them apart.
  it('L3-P05-09: handler must NOT route a non-StaleSnapshot error carrying the same message prefix into the stale path', async () => {
    const candidateIntakeId = `intk_prefix_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T20:00:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '3101',
      timestamp: now,
      text: 'Svet o‘chdi',
    });

    // An unrelated failure whose message merely BEGINS with the same literal.
    const decoy = new Error(
      'STALE_SNAPSHOT: unrelated upstream failure in a different module',
    );
    const decoyEvaluator = {
      evaluateTopicAssignment: async () => {
        throw decoy;
      },
    } as unknown as TopicMatchingEvaluator;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Read the recorded calls BEFORE restoring the spies: in Vitest mockRestore()
    // also clears mock.calls, so reading afterwards would silently see empty arrays
    // and make this test pass or fail for the wrong reason.
    let warnedEvents: string[] = [];
    let erroredEvents: string[] = [];

    try {
      await processTopicAssignmentJobs(
        [
          {
            data: {
              intakeId: candidateIntakeId,
              districtId: testDistrictId,
              mahallaName: 'Guliston',
              calendarDay: '2026-08-22',
              telegramChatId: testChatId,
              telegramMessageId: '3101',
              originalTimestamp: now.toISOString(),
              contentType: 'TEXT',
              verbatimText: 'Svet o‘chdi',
              replyMetadata: null,
              aiOperationId: `aiop_${crypto.randomUUID()}`,
              relevantLanes: ['ELECTRICITY'],
              reasoning: 'Outage',
            },
          } as any,
        ],
        {
          db,
          pool,
          boss,
          topicMatchingEvaluator: decoyEvaluator,
        },
      );
    } catch {
      // The handler rethrows to trigger the pg-boss retry policy; that is expected.
    } finally {
      warnedEvents = warnSpy.mock.calls.map((c) => String(c[0]));
      erroredEvents = errorSpy.mock.calls.map((c) => String(c[0]));
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }

    // The decoy is NOT a stale-snapshot signal, so it must take the error branch.
    expect(warnedEvents.some((e) => e.includes('STALE_SNAPSHOT'))).toBe(false);
    expect(erroredEvents.some((e) => e.includes('TELEGRAM_TOPIC_ASSIGNMENT_ERROR'))).toBe(
      true,
    );
  });

  // Producer side of the same contract (AC 2). A caller must be able to tell the
  // stale-snapshot path apart WITHOUT reading the coordinator's source, and the
  // typed diagnostic must survive: the previous code threw a bare Error, discarding
  // the StaleSnapshotRevisionError that carries the revision numbers.
  it('L3-P05-09: a stale snapshot rejects with a typed StaleSnapshotError carrying the diagnostic cause', async () => {
    const candidateIntakeId = `intk_typed_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T21:00:00Z');

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId: '3201',
      timestamp: now,
      text: 'Svet o‘chdi',
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'ELECTRICITY',
      reasoning: 'Outage',
    });

    // Initial snapshot (revision 0), then the in-transaction CAS re-read sees a
    // revision that has advanced to 1 — the exact race this error mode reports.
    let callCount = 0;
    const racingResolver = async (): Promise<AcceptedEvidenceItem[] | undefined> => {
      callCount++;
      if (callCount === 1) {
        return [];
      }
      return [
        {
          id: 'evi_concurrent_typed',
          topicId: 'top_typed',
          telegramMessageId: '9998',
          originalTimestamp: now.toISOString(),
          verbatimText: 'Boshqa xabar',
          lane: 'ELECTRICITY',
        },
      ];
    };

    const evaluator = new TopicMatchingEvaluator(aiController.gateway);

    const settled = await Promise.allSettled([
      assignEvidenceToTopic(
        {
          db,
          pool,
          boss,
          topicMatchingEvaluator: evaluator,
          injectedEvidenceResolver: racingResolver,
        },
        {
          intakeId: candidateIntakeId,
          districtId: testDistrictId,
          mahallaName: 'Guliston',
          calendarDay: '2026-08-22',
          telegramChatId: testChatId,
          telegramMessageId: '3201',
          originalTimestamp: now.toISOString(),
          contentType: 'TEXT',
          verbatimText: 'Svet o‘chdi',
          replyMetadata: null,
          aiOperationId: `aiop_${crypto.randomUUID()}`,
          relevantLanes: ['ELECTRICITY'],
          reasoning: 'Outage',
        },
      ),
    ]);

    expect(settled[0]!.status).toBe('rejected');
    const thrown = (settled[0] as PromiseRejectedResult).reason;

    // Narrowable by type — no message matching required of the caller.
    expect(thrown).toBeInstanceOf(StaleSnapshotError);
    expect((thrown as StaleSnapshotError).code).toBe('STALE_SNAPSHOT');
    expect((thrown as StaleSnapshotError).reason).toBe('SNAPSHOT_REVISION');

    // The typed diagnostic is preserved rather than discarded one frame later.
    expect((thrown as StaleSnapshotError).cause).toBeInstanceOf(StaleSnapshotRevisionError);

    // The operator-facing message text is unchanged, so pg-boss output still
    // surfaces the literal STALE_SNAPSHOT marker operators and tests rely on.
    expect((thrown as Error).message).toContain('STALE_SNAPSHOT');
  });

  // Companion to Matrix #26. That test replays the SAME telegramMessageId, so the
  // coordinator's idempotency check short-circuits as SKIPPED_DUPLICATE before any
  // insert — it never reaches the 23505 catch it is named for. This test forces a
  // REAL unique violation on accepted_evidence_district_chat_msg_idx and asserts the
  // catch absorbs it, proving the rewritten detection (isPostgresError + constraint
  // name) fires and that PostgreSQL actually populates `constraint` on the driver
  // error — which the old raw `err?.code` read could miss.
  it('L3-P05-15: a genuine 23505 reaching the insert is absorbed as IGNORED_DUPLICATE_VIOLATION', async () => {
    const candidateIntakeId = `intk_dup_${crypto.randomUUID()}`;
    const now = new Date('2026-08-22T22:00:00Z');
    const messageId = '3301';

    await seedIntakeRecord({
      intakeId: candidateIntakeId,
      messageId,
      timestamp: now,
      text: 'Gaz sizib chiqmoqda',
    });

    // A separate Topic owns the row that will collide, so the collision lands on the
    // unique index rather than on a Topic foreign key.
    const collidingTopicId = `top_dup_${crypto.randomUUID()}`;
    await db.insert(topics).values({
      id: collidingTopicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'GAS',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    aiController.mockAdapter.setNextResponse({
      decision: 'NEW_TOPIC',
      matched_topic_id: null,
      primary_lane: 'GAS',
      reasoning: 'Gas leak',
    });

    // The idempotency check runs BEFORE the insert, so a pre-seeded row would just
    // short-circuit. The colliding row is injected mid-flight instead: on the
    // in-transaction CAS re-read (the resolver's second call), which lands after the
    // idempotency check and before the accepted_evidence insert. The snapshot is
    // unchanged between the two calls, so the CAS check still passes and the test
    // reaches the insert deterministically instead of by racing the scheduler.
    let callCount = 0;
    const collidingResolver = async (): Promise<AcceptedEvidenceItem[] | undefined> => {
      callCount++;
      if (callCount === 2) {
        await db.insert(acceptedEvidence).values({
          id: `evi_dup_${crypto.randomUUID()}`,
          topicId: collidingTopicId,
          districtId: testDistrictId,
          mahallaName: 'Guliston',
          calendarDay: '2026-08-22',
          intakeRecordId: candidateIntakeId,
          telegramChatId: testChatId,
          telegramMessageId: messageId,
          originalTimestamp: now,
          verbatimText: 'Gaz sizib chiqmoqda',
          contentType: 'TEXT',
        });
      }
      return [];
    };

    const evaluator = new TopicMatchingEvaluator(aiController.gateway);

    const outcome = await assignEvidenceToTopic(
      {
        db,
        pool,
        boss,
        topicMatchingEvaluator: evaluator,
        injectedEvidenceResolver: collidingResolver,
      },
      {
        intakeId: candidateIntakeId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        telegramChatId: testChatId,
        telegramMessageId: messageId,
        originalTimestamp: now.toISOString(),
        contentType: 'TEXT',
        verbatimText: 'Gaz sizib chiqmoqda',
        replyMetadata: null,
        aiOperationId: `aiop_${crypto.randomUUID()}`,
        relevantLanes: ['GAS'],
        reasoning: 'Gas leak',
      },
    );

    // The unique violation was raised, reached the catch, and was absorbed rather
    // than burning a pg-boss retry.
    expect(outcome.status).toBe('IGNORED_DUPLICATE_VIOLATION');

    // Exactly one evidence row exists — the loser's transaction rolled back.
    const rows = await db
      .select()
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, testDistrictId),
          eq(acceptedEvidence.telegramMessageId, messageId),
        ),
      );
    expect(rows.length).toBe(1);
  });
});
