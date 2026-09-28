import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type pg from 'pg';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import {
  createBossClient,
  initBossQueues,
  TELEGRAM_BURST_DEBOUNCE_QUEUE,
  TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
  TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
} from '../src/adapters/jobs/boss-client.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  telegramIntakeRecords,
  topics,
  acceptedEvidence,
} from '../src/adapters/db/schema/index.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import { processTelegramWebhookUpdate } from '../src/modules/telegram-intake/telegram-intake-service.js';
import { processBurstDebounceJobs } from '../src/modules/telegram-intake/jobs/burst-debounce-job-handler.js';
import { processSemanticRelevanceJobs } from '../src/modules/ai/jobs/semantic-relevance-job-handler.js';
import { processTopicAssignmentJobs } from '../src/modules/topics/jobs/topic-assignment-job-handler.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';

describe('Burst Message Debouncing & Semantic Aggregation Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;

  let activeDistrictId: string;
  let activeBotId: string;
  let validChatId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient();
    await boss.start();
    await initBossQueues(boss);
    await ensureDefaultAiProfiles(db);
  });

  afterAll(async () => {
    await boss.stop({ graceful: true, timeout: 10000 });
    await pool.end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();

    activeDistrictId = `dist_burst_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: activeDistrictId,
      name: `Burst Test District ${crypto.randomUUID().slice(0, 6)}`,
      status: 'ACTIVE',
    });

    activeBotId = `bot_burst_${crypto.randomUUID().slice(0, 8)}`;
    const activeEnc = encryptToken(`111111111:AA${crypto.randomUUID()}`);
    await db.insert(districtTelegramBots).values({
      id: `dtb_${crypto.randomUUID()}`,
      districtId: activeDistrictId,
      botId: activeBotId,
      botFirstName: 'Burst Test Bot',
      botUsername: 'burst_test_bot',
      encryptedToken: activeEnc.encryptedToken,
      tokenIv: activeEnc.tokenIv,
      tokenTag: activeEnc.tokenTag,
      tokenKeyVersion: activeEnc.tokenKeyVersion,
      tokenMasked: `${activeBotId}:••••••••••••`,
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    validChatId = `-100${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await db.insert(districtTelegramGroups).values({
      id: `dtg_${crypto.randomUUID()}`,
      districtId: activeDistrictId,
      mahallaName: 'Navbahor',
      telegramChatId: validChatId,
      telegramChatTitle: 'Navbahor Mahalla Group',
      status: 'VALID',
      lastValidatedAt: new Date(),
    });
  });

  it('Test 1 (End-to-End Burst Flow): Merges split messages into one AI candidate and persists distinct accepted evidence rows', async () => {
    const userId = '999123';
    const msgId1 = `101_${Date.now()}`;
    const msgId2 = `102_${Date.now()}`;
    const baseTime = new Date('2026-08-21T20:15:00Z');

    // 1. Webhook receives Message 1: "Hammada yomi"
    const res1 = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 1001,
      message: {
        message_id: Number(msgId1.split('_')[0]),
        date: Math.floor(baseTime.getTime() / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident', username: 'resident1' },
        text: 'Hammada yomi',
      },
    });
    expect(res1.status).toBe('ACCEPTED');

    // 2. Webhook receives Message 2: "Svet" (10s later)
    const res2 = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 1002,
      message: {
        message_id: Number(msgId2.split('_')[0]),
        date: Math.floor((baseTime.getTime() + 10000) / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident', username: 'resident1' },
        text: 'Svet',
      },
    });
    expect(res2.status).toBe('ACCEPTED');

    // 3. Verify both intake records exist in DB
    const intakes = await db
      .select()
      .from(telegramIntakeRecords)
      .where(
        and(
          eq(telegramIntakeRecords.districtId, activeDistrictId),
          eq(telegramIntakeRecords.telegramChatId, validChatId),
        ),
      );
    expect(intakes.length).toBe(2);

    // 4. Process Burst Debounce Job (simulating timer expiration 30s later)
    const debounceJob: any = {
      data: {
        districtId: activeDistrictId,
        mahallaName: 'Navbahor',
        calendarDay: '2026-08-21',
        telegramChatId: validChatId,
        telegramUserId: userId,
        telegramBotId: activeBotId,
        firstMessageTimestamp: baseTime.toISOString(),
      },
    };

    // Mock Date.now to simulate execution 55s after the second message
    const realDateNow = Date.now;
    Date.now = () => baseTime.getTime() + 65000;

    let enqueuedSemanticJobData: any = null;
    const sendSpy = vi.spyOn(boss, 'send').mockImplementation(async (queue: any, data: any) => {
      if (queue === TELEGRAM_SEMANTIC_RELEVANCE_QUEUE) {
        enqueuedSemanticJobData = data;
      }
      return 'mock_job_id';
    });

    try {
      await processBurstDebounceJobs([debounceJob], { db, boss });

      expect(enqueuedSemanticJobData).toBeDefined();
      expect(enqueuedSemanticJobData.verbatimText).toBe('Hammada yomi\nSvet');
      expect(enqueuedSemanticJobData.burstMessages).toBeDefined();
      expect(enqueuedSemanticJobData.burstMessages.length).toBe(2);

      // Verify records are now marked with batchId
      const updatedIntakes = await db
        .select()
        .from(telegramIntakeRecords)
        .where(
          and(
            eq(telegramIntakeRecords.districtId, activeDistrictId),
            eq(telegramIntakeRecords.telegramChatId, validChatId),
          ),
        );
      expect(updatedIntakes.every((r) => r.processedAt !== null && r.batchId !== null)).toBe(true);

      // 5. Process Semantic Relevance with mock evaluator
      const mockRelevanceEvaluator: any = {
        evaluateRelevance: vi.fn().mockResolvedValue({
          data: {
            is_relevant: true,
            relevant_lanes: ['INFRASTRUCTURE'],
            reasoning: 'Electricity outage complaint',
          },
          profileId: 'prof_rel_2026_08_v1',
          provider: 'OLLAMA',
          modelId: 'gemma4:12b',
          providerRequestId: 'mock_req',
          durationMs: 50,
          tokens: { inputTokens: 20, outputTokens: 10, cachedTokens: 0 },
          estimatedCostUsd: '0.0001',
          attempts: [],
        }),
      };

      let enqueuedTopicJobData: any = null;
      sendSpy.mockImplementation(async (queue: any, data: any) => {
        if (queue === TELEGRAM_TOPIC_ASSIGNMENT_QUEUE) {
          enqueuedTopicJobData = data;
        }
        return 'mock_topic_job_id';
      });

      const semanticJob: any = {
        data: enqueuedSemanticJobData,
      };

      await processSemanticRelevanceJobs([semanticJob], {
        db,
        pool,
        boss,
        relevanceEvaluator: mockRelevanceEvaluator,
      });

      expect(enqueuedTopicJobData).toBeDefined();
      expect(enqueuedTopicJobData.burstMessages.length).toBe(2);

      // 6. Process Topic Assignment with mock topic matching evaluator (NEW_TOPIC)
      const mockTopicMatchingEvaluator: any = {
        evaluateTopicAssignment: vi.fn().mockResolvedValue({
          data: {
            decision: 'NEW_TOPIC',
            primary_lane: 'INFRASTRUCTURE',
            reasoning: 'New electricity outage cluster',
          },
          profileId: 'prof_match_2026_08_v1',
          provider: 'OLLAMA',
          modelId: 'gemma4:12b',
          providerRequestId: 'mock_req',
          durationMs: 50,
          tokens: { inputTokens: 20, outputTokens: 10, cachedTokens: 0 },
          estimatedCostUsd: '0.0001',
          attempts: [],
        }),
      };

      const topicJob: any = {
        data: enqueuedTopicJobData,
      };

      await processTopicAssignmentJobs([topicJob], {
        db,
        pool,
        boss,
        topicMatchingEvaluator: mockTopicMatchingEvaluator,
      });

      // 7. Verify Database Result: 1 Topic, 2 Accepted Evidence rows
      const createdTopics = await db
        .select()
        .from(topics)
        .where(
          and(
            eq(topics.districtId, activeDistrictId),
            eq(topics.mahallaName, 'Navbahor'),
          ),
        );
      expect(createdTopics.length).toBe(1);
      const topicId = createdTopics[0]!.id;
      expect(createdTopics[0]!.primaryLane).toBe('INFRASTRUCTURE');

      const evidence = await db
        .select()
        .from(acceptedEvidence)
        .where(eq(acceptedEvidence.topicId, topicId));

      expect(evidence.length).toBe(2);

      const texts = evidence.map((e) => e.verbatimText).sort();
      expect(texts).toEqual(['Hammada yomi', 'Svet']);
    } finally {
      Date.now = realDateNow;
      sendSpy.mockRestore();
    }
  });

  it('Test 2 (Sliding Window Reset): Extends debounce timer when user continues typing within 20 seconds', async () => {
    const userId = '888456';
    const baseTime = new Date('2026-08-21T14:00:00Z');

    // Message 1 at T=0
    await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 2001,
      message: {
        message_id: 201,
        date: Math.floor(baseTime.getTime() / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 2' },
        text: 'Assalomu alaykum',
      },
    });

    // Message 2 at T=5s
    await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 2002,
      message: {
        message_id: 202,
        date: Math.floor((baseTime.getTime() + 5000) / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 2' },
        text: 'Kutamiz',
      },
    });

    // When worker fires at T=8s (3s after Msg 2, so within 12s window):
    const realDateNow = Date.now;
    Date.now = () => baseTime.getTime() + 8000;

    let rescheduledJobData: any = null;
    let rescheduledOptions: any = null;

    const sendSpy = vi.spyOn(boss, 'send').mockImplementation(async (queue: any, data: any, options: any) => {
      if (queue === TELEGRAM_BURST_DEBOUNCE_QUEUE) {
        rescheduledJobData = data;
        rescheduledOptions = options;
      }
      return 'mock_rescheduled_id';
    });

    try {
      const debounceJob: any = {
        data: {
          districtId: activeDistrictId,
          mahallaName: 'Navbahor',
          calendarDay: '2026-08-21',
          telegramChatId: validChatId,
          telegramUserId: userId,
          source: 'BOT_API',
          telegramBotId: activeBotId,
          firstMessageTimestamp: baseTime.toISOString(),
        },
      };

      await processBurstDebounceJobs([debounceJob], { db, boss });

      // Verify job was rescheduled rather than flushed
      expect(rescheduledJobData).toBeDefined();
      expect(rescheduledOptions?.startAfter).toBeGreaterThanOrEqual(1);
    } finally {
      Date.now = realDateNow;
      sendSpy.mockRestore();
    }
  });

  it('Test 3 (Pre-Filtering Noise): Discards bot commands from the burst buffer candidate pool', async () => {
    const userId = '777888';
    const baseTime = new Date('2026-08-21T16:00:00Z');

    // Message 1: Bot command /start (structurally excluded)
    const res1 = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 3001,
      message: {
        message_id: 301,
        date: Math.floor(baseTime.getTime() / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 3' },
        text: '/start',
      },
    });
    expect(res1.status).toBe('ACCEPTED');

    // Message 2: Legitimate complaint
    const res2 = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 3002,
      message: {
        message_id: 302,
        date: Math.floor((baseTime.getTime() + 5000) / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 3' },
        text: 'Gaz bosimi juda past tushib ketdi',
      },
    });
    expect(res2.status).toBe('ACCEPTED');

    // Trigger debounce worker 55s later
    const realDateNow = Date.now;
    Date.now = () => baseTime.getTime() + 60000;

    let enqueuedSemanticJobData: any = null;
    const sendSpy = vi.spyOn(boss, 'send').mockImplementation(async (queue: any, data: any) => {
      if (queue === TELEGRAM_SEMANTIC_RELEVANCE_QUEUE) {
        enqueuedSemanticJobData = data;
      }
      return 'mock_job_id';
    });

    try {
      const debounceJob: any = {
        data: {
          districtId: activeDistrictId,
          mahallaName: 'Navbahor',
          calendarDay: '2026-08-21',
          telegramChatId: validChatId,
          telegramUserId: userId,
          telegramBotId: activeBotId,
          firstMessageTimestamp: baseTime.toISOString(),
        },
      };

      await processBurstDebounceJobs([debounceJob], { db, boss });

      expect(enqueuedSemanticJobData).toBeDefined();
      // Only the valid complaint is included, '/start' was filtered out
      expect(enqueuedSemanticJobData.verbatimText).toBe('Gaz bosimi juda past tushib ketdi');
    } finally {
      Date.now = realDateNow;
      sendSpy.mockRestore();
    }
  });

  it('Test 4 (In-buffer Edit): Updates payload in-place and flushes revised text to AI pipeline', async () => {
    const userId = '999401';
    const msgId = `401_${Date.now()}`;
    const baseTime = new Date('2026-08-21T21:00:00Z');

    // 1. Initial message with typo
    const res1 = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 4001,
      message: {
        message_id: Number(msgId.split('_')[0]),
        date: Math.floor(baseTime.getTime() / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 4' },
        text: 'Bogzor kucada quvr yorilgan',
      },
    });
    expect(res1.status).toBe('ACCEPTED');
    if (res1.status !== 'ACCEPTED') throw new Error('Expected ACCEPTED');
    expect(res1.intakeId).toBeDefined();

    // 2. In-buffer edit (5 seconds later)
    const editTime = new Date(baseTime.getTime() + 5000);
    const resEdit = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 4002,
      edited_message: {
        message_id: Number(msgId.split('_')[0]),
        date: Math.floor(baseTime.getTime() / 1000),
        edit_date: Math.floor(editTime.getTime() / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 4' },
        text: "Bog'zor ko'chasida quvur yorilgan, suv toshmoqda",
      },
    });
    expect(resEdit.status).toBe('UPDATED');
    if (resEdit.status !== 'UPDATED') throw new Error('Expected UPDATED');
    expect(resEdit.intakeId).toBe(res1.intakeId);

    // Verify DB row contains the updated payload
    const [record] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.id, res1.intakeId));
    expect(record).toBeDefined();
    const payload = record!.rawPayload as any;
    expect(payload.edited_message?.text).toBe("Bog'zor ko'chasida quvur yorilgan, suv toshmoqda");

    // 3. Flush burst worker 55 seconds after edit
    const realDateNow = Date.now;
    Date.now = () => baseTime.getTime() + 65000;

    let enqueuedSemanticJobData: any = null;
    const sendSpy = vi.spyOn(boss, 'send').mockImplementation(async (queue: any, data: any) => {
      if (queue === TELEGRAM_SEMANTIC_RELEVANCE_QUEUE) {
        enqueuedSemanticJobData = data;
      }
      return 'mock_job_id';
    });

    try {
      const debounceJob: any = {
        data: {
          districtId: activeDistrictId,
          mahallaName: 'Navbahor',
          calendarDay: '2026-08-21',
          telegramChatId: validChatId,
          telegramUserId: userId,
          telegramBotId: activeBotId,
          firstMessageTimestamp: baseTime.toISOString(),
        },
      };

      await processBurstDebounceJobs([debounceJob], { db, boss });

      expect(enqueuedSemanticJobData).toBeDefined();
      // Verifies the revised/edited text was extracted and passed downstream
      expect(enqueuedSemanticJobData.verbatimText).toBe("Bog'zor ko'chasida quvur yorilgan, suv toshmoqda");
    } finally {
      Date.now = realDateNow;
      sendSpy.mockRestore();
    }
  });

  it('Test 5 (Edit Resets Debounce Timer): Reschedules job if edit occurred within 20 seconds of check', async () => {
    const userId = '999501';
    const msgId = `501_${Date.now()}`;
    const baseTime = new Date('2026-08-21T21:10:00Z');

    // 1. Send initial message at t=0
    await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 5001,
      message: {
        message_id: Number(msgId.split('_')[0]),
        date: Math.floor(baseTime.getTime() / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 5' },
        text: 'Chiroq o‘chdimi hammada',
      },
    });

    // 2. Edit message at t=20s via webhook
    const editTime = Math.floor(baseTime.getTime() / 1000) + 20;
    const resEdit = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 5002,
      edited_message: {
        message_id: Number(msgId.split('_')[0]),
        date: Math.floor(baseTime.getTime() / 1000),
        edit_date: editTime,
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 5' },
        text: 'Chiroq o‘chdimi hammada? Bizda o‘chdi',
      },
    });
    expect(resEdit.status).toBe('UPDATED');

    // 3. Worker fires at t=26s (26s after initial send, but only 6s after edit)
    const realDateNow = Date.now;
    Date.now = () => baseTime.getTime() + 26000;

    let rescheduledJob: any = null;
    const sendSpy = vi.spyOn(boss, 'send').mockImplementation(async (queue: any, data: any, options: any) => {
      if (queue === TELEGRAM_BURST_DEBOUNCE_QUEUE) {
        rescheduledJob = { data, options };
      }
      return 'mock_job_id';
    });

    try {
      const debounceJob: any = {
        data: {
          districtId: activeDistrictId,
          mahallaName: 'Navbahor',
          calendarDay: '2026-08-21',
          telegramChatId: validChatId,
          telegramUserId: userId,
          source: 'BOT_API',
          telegramBotId: activeBotId,
          firstMessageTimestamp: baseTime.toISOString(),
        },
      };

      await processBurstDebounceJobs([debounceJob], { db, boss });

      // Verifies timer was extended: remainingDelay is ceil(30 - 6) = 24 seconds
      expect(rescheduledJob).toBeDefined();
      expect(rescheduledJob.options.startAfter).toBe(24);
    } finally {
      Date.now = realDateNow;
      sendSpy.mockRestore();
    }
  });

  it('Test 6 (Edit to Empty Content): Excludes blanked-out message dynamically at flush', async () => {
    const userId = '999601';
    const msgId = `601_${Date.now()}`;
    const baseTime = new Date('2026-08-21T21:20:00Z');

    // 1. Send valid message
    const res1 = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 6001,
      message: {
        message_id: Number(msgId.split('_')[0]),
        date: Math.floor(baseTime.getTime() / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 6' },
        text: 'Adashib yozvordim uzr',
      },
    });
    expect(res1.status).toBe('ACCEPTED');
    if (res1.status !== 'ACCEPTED') throw new Error('Expected ACCEPTED');

    // 2. Edit to empty whitespace (retraction)
    const resEdit = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 6002,
      edited_message: {
        message_id: Number(msgId.split('_')[0]),
        date: Math.floor(baseTime.getTime() / 1000),
        edit_date: Math.floor((baseTime.getTime() + 2000) / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 6' },
        text: '   ',
      },
    });
    expect(resEdit.status).toBe('UPDATED');

    // 3. Flush worker at t=60s
    const realDateNow = Date.now;
    Date.now = () => baseTime.getTime() + 60000;

    let enqueuedSemanticJob = false;
    const sendSpy = vi.spyOn(boss, 'send').mockImplementation(async (queue: any) => {
      if (queue === TELEGRAM_SEMANTIC_RELEVANCE_QUEUE) {
        enqueuedSemanticJob = true;
      }
      return 'mock_job_id';
    });

    try {
      const debounceJob: any = {
        data: {
          districtId: activeDistrictId,
          mahallaName: 'Navbahor',
          calendarDay: '2026-08-21',
          telegramChatId: validChatId,
          telegramUserId: userId,
          telegramBotId: activeBotId,
          firstMessageTimestamp: baseTime.toISOString(),
        },
      };

      await processBurstDebounceJobs([debounceJob], { db, boss });

      // No semantic job should be enqueued for a retracted blank message
      expect(enqueuedSemanticJob).toBe(false);

      // Record should be updated with EXCLUDED status
      const [updatedRecord] = await db
        .select()
        .from(telegramIntakeRecords)
        .where(eq(telegramIntakeRecords.id, res1.intakeId));
      const payload = updatedRecord!.rawPayload as any;
      expect(payload.status).toBe('EXCLUDED');
      expect(payload.exclusionReason).toBe('EMPTY_CONTENT');
    } finally {
      Date.now = realDateNow;
      sendSpy.mockRestore();
    }
  });

  it('Test 7 (Post-Flush Edit): Rejects edit when message was already processed into AI pipeline', async () => {
    const userId = '999701';
    const msgId = `701_${Date.now()}`;
    const baseTime = new Date('2026-08-21T21:30:00Z');

    // 1. Send initial message
    const res1 = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 7001,
      message: {
        message_id: Number(msgId.split('_')[0]),
        date: Math.floor(baseTime.getTime() / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 7' },
        text: 'Suv ertalabdan beri yo‘q',
      },
    });
    expect(res1.status).toBe('ACCEPTED');
    if (res1.status !== 'ACCEPTED') throw new Error('Expected ACCEPTED');

    // 2. Mark message as processed (simulating completion of burst debounce flush)
    await db
      .update(telegramIntakeRecords)
      .set({
        processedAt: new Date(),
        batchId: 'batch_test_processed',
      })
      .where(eq(telegramIntakeRecords.id, res1.intakeId));

    // 3. User edits message post-processing
    const resEdit = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 7002,
      edited_message: {
        message_id: Number(msgId.split('_')[0]),
        date: Math.floor(baseTime.getTime() / 1000),
        edit_date: Math.floor((baseTime.getTime() + 45000) / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 7' },
        text: 'Suv ertalabdan beri yo‘q, keldi endi',
      },
    });

    // Verifies the post-flush edit is cleanly dropped
    expect(resEdit.status).toBe('DROPPED');
    expect((resEdit as any).reason).toBe('ALREADY_PROCESSED');

    // Verifies raw_payload in DB was NOT mutated
    const [unmutatedRecord] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.id, res1.intakeId));
    const payload = unmutatedRecord!.rawPayload as any;
    expect(payload.message.text).toBe('Suv ertalabdan beri yo‘q');
  });

  it('Test 8 (Untracked Edit): Ingests edited_message as a new intake if message was not previously recorded', async () => {
    const userId = '999801';
    const untrackedMsgId = Number(`801${Math.floor(Math.random() * 1000)}`);
    const baseTime = new Date('2026-08-21T21:40:00Z');

    // Webhook receives edited_message for a message that never had an initial intake
    const res = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 8001,
      edited_message: {
        message_id: untrackedMsgId,
        date: Math.floor(baseTime.getTime() / 1000),
        edit_date: Math.floor((baseTime.getTime() + 5000) / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 8' },
        text: 'Gaz tarmog‘ida portlash ovozi eshitildi',
      },
    });

    expect(res.status).toBe('ACCEPTED');
    if (res.status !== 'ACCEPTED') throw new Error('Expected ACCEPTED');
    expect(res.intakeId).toBeDefined();

    const [record] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.id, res.intakeId));
    expect(record).toBeDefined();
    expect(record!.telegramMessageId).toBe(String(untrackedMsgId));
  });

  it('Test 9 (Delta-Time Gating & Backlog Partitioning): Partitions backlog messages with originalTimestamp gap > 50s into separate burst jobs', async () => {
    const userId = '999901';
    const msgId1 = `901_${crypto.randomUUID().slice(0, 4)}`;
    const msgId2 = `902_${crypto.randomUUID().slice(0, 4)}`;
    const msgId3 = `903_${crypto.randomUUID().slice(0, 4)}`;
    const baseTime = new Date('2026-08-21T21:00:00Z');

    // Simulate 3 messages from same user during offline backlog
    // Msg 1 and 2 have a 10s gap (<= 50s)
    // Msg 3 arrives 60s after Msg 2 (> 50s gap)
    await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 9001,
      message: {
        message_id: Number(msgId1.split('_')[0]),
        date: Math.floor(baseTime.getTime() / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 9' },
        text: 'Bogi baland kucamzda musr olinmadi',
      },
    });

    await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 9002,
      message: {
        message_id: Number(msgId2.split('_')[0]),
        date: Math.floor((baseTime.getTime() + 10000) / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 9' },
        text: 'Elektrosvet yonidagi kuca',
      },
    });

    await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 9003,
      message: {
        message_id: Number(msgId3.split('_')[0]),
        date: Math.floor((baseTime.getTime() + 70000) / 1000),
        chat: { id: validChatId, title: 'Navbahor' },
        from: { id: Number(userId), first_name: 'Resident 9' },
        text: 'Katyol bor',
      },
    });

    // Simulate offline backlog execution: Date.now is well past the burst window
    const realDateNow = Date.now;
    Date.now = () => baseTime.getTime() + 120000;

    let enqueuedSemanticJobs: any[] = [];
    let enqueuedDebounceJobs: any[] = [];

    vi.spyOn(boss, 'send').mockImplementation(async (queue: any, data: any) => {
      if (queue === TELEGRAM_SEMANTIC_RELEVANCE_QUEUE) {
        enqueuedSemanticJobs.push(data);
      } else if (queue === TELEGRAM_BURST_DEBOUNCE_QUEUE) {
        enqueuedDebounceJobs.push(data);
      }
      return 'mock_job_id';
    });

    try {
      const initialJob: any = {
        id: 'job_burst_backlog_1',
        data: {
          districtId: activeDistrictId,
          mahallaName: 'Navbahor',
          calendarDay: '2026-08-21',
          telegramChatId: validChatId,
          telegramUserId: userId,
          source: 'BOT_API',
          telegramBotId: activeBotId,
          firstMessageTimestamp: baseTime.toISOString(),
        },
      };

      // Run first burst debounce pass
      await processBurstDebounceJobs([initialJob], { db, boss });

      // First burst should have processed only msg 1 and msg 2 (gap 10s <= 12s)
      expect(enqueuedSemanticJobs.length).toBe(1);
      const burst1 = enqueuedSemanticJobs[0];
      expect(burst1.burstMessages).toBeDefined();
      expect(burst1.burstMessages.length).toBe(2);
      expect(burst1.verbatimText).toContain('Bogi baland kucamzda musr olinmadi');
      expect(burst1.verbatimText).toContain('Elektrosvet yonidagi kuca');
      expect(burst1.verbatimText).not.toContain('Katyol bor');

      // The partitioner must have enqueued the next burst debounce job for remaining msg 3
      expect(enqueuedDebounceJobs.length).toBe(1);

      // Now process the enqueued second debounce job
      const secondJob: any = {
        id: 'job_burst_backlog_2',
        data: enqueuedDebounceJobs[0],
      };
      await processBurstDebounceJobs([secondJob], { db, boss });

      // Second burst should have processed msg 3 separately as single message
      expect(enqueuedSemanticJobs.length).toBe(2);
      const burst2 = enqueuedSemanticJobs[1];
      expect(burst2.verbatimText).toBe('Katyol bor');
    } finally {
      Date.now = realDateNow;
    }
  });
});
