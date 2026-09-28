import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type pg from 'pg';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import {
  createBossClient,
  initBossQueues,
  TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
  TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
} from '../src/adapters/jobs/boss-client.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  districtTelegramUserbotSessions,
  telegramIntakeRecords,
  topics,
  acceptedEvidence,
} from '../src/adapters/db/schema/index.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import {
  processTelegramWebhookUpdate,
  processUserbotIngestEnvelope,
} from '../src/modules/telegram-intake/telegram-intake-service.js';
import { normalizeMtprotoUpdate } from '../src/adapters/telegram/mtproto-normalizer.js';
import { switchDistrictTelegramGroupTransport } from '../src/modules/telegram-groups/telegram-groups-service.js';
import { processBurstDebounceJobs } from '../src/modules/telegram-intake/jobs/burst-debounce-job-handler.js';
import { processSemanticRelevanceJobs } from '../src/modules/ai/jobs/semantic-relevance-job-handler.js';
import { processTopicAssignmentJobs } from '../src/modules/topics/jobs/topic-assignment-job-handler.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import {
  createDistrictUserbotSession,
  updateUserbotSessionStatus,
} from '../src/modules/userbot-session/index.js';
import {
  UserbotConnectionManager,
  type UserbotClientPort,
  type UserbotClientEvents,
} from '../src/modules/userbot/index.js';

class MockUserbotClient implements UserbotClientPort {
  readonly districtId: string;
  readonly sessionString: string;
  readonly apiId: string;
  readonly phoneNumber: string;

  connectCalls: number = 0;
  disconnectCalls: number = 0;
  private connected: boolean = false;
  private listeners = {
    message: [] as ((update: unknown) => void)[],
    disconnect: [] as ((reason?: string | Error) => void)[],
    reconnect: [] as (() => void)[],
    error: [] as ((err: Error) => void)[],
    ban: [] as ((details?: { reason?: string; error?: Error }) => void)[],
  };

  constructor(params: {
    districtId: string;
    sessionString: string;
    apiId: string;
    phoneNumber: string;
  }) {
    this.districtId = params.districtId;
    this.sessionString = params.sessionString;
    this.apiId = params.apiId;
    this.phoneNumber = params.phoneNumber;
  }

  async connect(): Promise<void> {
    this.connectCalls++;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.connected = false;
    this.emit('disconnect');
  }

  isConnected(): boolean {
    return this.connected;
  }

  on<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void;
  on(...[event, listener]: { [K in keyof UserbotClientEvents]: [K, UserbotClientEvents[K]] }[keyof UserbotClientEvents]): void {
    switch (event) {
      case 'message':
        this.listeners.message.push(listener);
        break;
      case 'disconnect':
        this.listeners.disconnect.push(listener);
        break;
      case 'reconnect':
        this.listeners.reconnect.push(listener);
        break;
      case 'error':
        this.listeners.error.push(listener);
        break;
      case 'ban':
        this.listeners.ban.push(listener);
        break;
    }
  }

  off<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void;
  off(...[event, listener]: { [K in keyof UserbotClientEvents]: [K, UserbotClientEvents[K]] }[keyof UserbotClientEvents]): void {
    switch (event) {
      case 'message':
        this.listeners.message = this.listeners.message.filter((l) => l !== listener);
        break;
      case 'disconnect':
        this.listeners.disconnect = this.listeners.disconnect.filter((l) => l !== listener);
        break;
      case 'reconnect':
        this.listeners.reconnect = this.listeners.reconnect.filter((l) => l !== listener);
        break;
      case 'error':
        this.listeners.error = this.listeners.error.filter((l) => l !== listener);
        break;
      case 'ban':
        this.listeners.ban = this.listeners.ban.filter((l) => l !== listener);
        break;
    }
  }

  emit(event: 'reconnect'): void;
  emit(event: 'disconnect', reason?: string | Error): void;
  emit(event: 'message', update: unknown): void;
  emit(event: 'error', err: Error): void;
  emit(event: 'ban', details?: { reason?: string; error?: Error }): void;
  emit(event: keyof UserbotClientEvents, arg?: unknown): void {
    switch (event) {
      case 'reconnect':
        for (const fn of this.listeners.reconnect) fn();
        break;
      case 'disconnect':
        if (typeof arg === 'string' || arg instanceof Error || arg === undefined) {
          for (const fn of this.listeners.disconnect) fn(arg);
        }
        break;
      case 'message':
        for (const fn of this.listeners.message) fn(arg);
        break;
      case 'error':
        if (arg instanceof Error) {
          for (const fn of this.listeners.error) fn(arg);
        }
        break;
      case 'ban':
        if (arg === undefined || (typeof arg === 'object' && arg !== null)) {
          for (const fn of this.listeners.ban) fn(arg);
        }
        break;
    }
  }
}

describe('Ticket 09: Userbot Ingestion End-to-End for one Mahalla', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;

  let activeDistrictId: string;
  let activeBotId: string;
  let testChatId: string;
  let numericChatId: number;
  let testGroupId: string;

  function nextTestChatId(): { raw: string; num: number } {
    const randomSuffix = Math.floor(1000000000 + Math.random() * 9000000000);
    return {
      raw: `-100${randomSuffix}`,
      num: randomSuffix,
    };
  }

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

    activeDistrictId = `dist_u_e2e_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: activeDistrictId,
      name: `Userbot Ingest District ${crypto.randomUUID()}`,
      status: 'ACTIVE',
    });

    // Provision an ACTIVE Userbot session for this district
    await createDistrictUserbotSession(db, {
      districtId: activeDistrictId,
      phoneNumber: '+998901234567',
      apiId: '12345',
      apiHash: 'test_api_hash',
      sessionString: `test_session_${activeDistrictId}`,
    });
    await updateUserbotSessionStatus(db, activeDistrictId, { status: 'ACTIVE' });

    // Provision an active Telegram Bot for BOT_API intake
    activeBotId = `bot_e2e_${crypto.randomUUID().slice(0, 8)}`;
    const enc = encryptToken('test_bot_token');
    await db.insert(districtTelegramBots).values({
      id: `dtb_${crypto.randomUUID()}`,
      districtId: activeDistrictId,
      botId: activeBotId,
      botUsername: `TestBot_${crypto.randomUUID().slice(0, 6)}`,
      botFirstName: 'Test Bot',
      encryptedToken: enc.encryptedToken,
      tokenIv: enc.tokenIv,
      tokenTag: enc.tokenTag,
      tokenKeyVersion: enc.tokenKeyVersion,
      tokenMasked: `${activeBotId}:••••••••••••`,
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    const chat = nextTestChatId();
    testChatId = chat.raw;
    numericChatId = chat.num;
    testGroupId = `dtg_e2e_${crypto.randomUUID()}`;

    // Provision group initially configured for USERBOT transport
    await db.insert(districtTelegramGroups).values({
      id: testGroupId,
      districtId: activeDistrictId,
      mahallaName: 'Navbahor',
      telegramChatId: testChatId,
      telegramChatTitle: 'Navbahor Mahalla Group',
      transport: 'USERBOT',
      status: 'VALID',
      lastValidatedAt: new Date(),
    });
  });

  it('Test 1: Userbot message is normalized and persisted through processUserbotIngestEnvelope with source: "USERBOT" and telegram_bot_id: null', async () => {
    const rawMtprotoUpdate = {
      _: 'UpdateNewChannelMessage',
      message: {
        _: 'Message',
        id: 501,
        peerId: { _: 'PeerChannel', channelId: numericChatId },
        fromId: { _: 'PeerUser', userId: 445566 },
        date: Math.floor(Date.now() / 1000),
        message: 'Mahallamizda suv bosimi juda past bo‘lyapti',
      },
      chats: [
        {
          _: 'Channel',
          id: numericChatId,
          title: 'Navbahor Mahalla Group',
        },
      ],
      users: [
        {
          _: 'User',
          id: 445566,
          firstName: 'Anvar',
          lastName: 'Resident',
          username: 'anvar_uz',
          bot: false,
        },
      ],
    };

    const normResult = normalizeMtprotoUpdate(rawMtprotoUpdate);
    expect(normResult.status).toBe('NORMALIZED');
    if (normResult.status !== 'NORMALIZED') return;

    const res = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      normResult.envelope,
    );

    expect(res.status).toBe('ACCEPTED');
    if (res.status === 'ACCEPTED') {
      expect(res.districtId).toBe(activeDistrictId);
      expect(res.mahallaName).toBe('Navbahor');
      expect(res.chatId).toBe(testChatId);
      expect(res.messageId).toBe('501');
    }

    // Verify record in telegram_intake_records
    const [record] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(
        and(
          eq(telegramIntakeRecords.districtId, activeDistrictId),
          eq(telegramIntakeRecords.telegramChatId, testChatId),
          eq(telegramIntakeRecords.telegramMessageId, '501'),
        ),
      )
      .limit(1);

    expect(record).toBeDefined();
    expect(record!.source).toBe('USERBOT');
    expect(record!.telegramBotId).toBeNull();
    expect(record!.districtId).toBe(activeDistrictId);
    expect(record!.mahallaName).toBe('Navbahor');
    expect(record!.telegramUserId).toBe('445566');

    // Verify testMessageReceivedAt updated on group
    const [group] = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.id, testGroupId))
      .limit(1);
    expect(group!.testMessageReceivedAt).toBeDefined();
    expect(group!.testMessageReceivedAt).not.toBeNull();
  });

  it('Test 2: Process message through burst-debounce worker / qualification and assert accepted_evidence record is created with correct districtId, mahallaName, and text', async () => {
    const rawMtprotoUpdate = {
      _: 'UpdateNewChannelMessage',
      message: {
        _: 'Message',
        id: 701,
        peerId: { _: 'PeerChannel', channelId: numericChatId },
        fromId: { _: 'PeerUser', userId: 887766 },
        date: Math.floor(Date.now() / 1000),
        message: 'Elektr ta’minotida uzilishlar bo‘lmoqda',
      },
      chats: [
        {
          _: 'Channel',
          id: numericChatId,
          title: 'Navbahor Mahalla Group',
        },
      ],
      users: [
        {
          _: 'User',
          id: 887766,
          firstName: 'Sanjar',
          username: 'sanjar_dev',
          bot: false,
        },
      ],
    };

    const normResult = normalizeMtprotoUpdate(rawMtprotoUpdate);
    expect(normResult.status).toBe('NORMALIZED');
    if (normResult.status !== 'NORMALIZED') return;

    const res = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      normResult.envelope,
    );
    expect(res.status).toBe('ACCEPTED');

    // Run burst debounce job
    const debounceJob: any = {
      data: {
        districtId: activeDistrictId,
        mahallaName: 'Navbahor',
        calendarDay: normResult.envelope.calendarDay,
        telegramChatId: testChatId,
        telegramUserId: '887766',
        source: 'USERBOT',
        telegramBotId: null,
        firstMessageTimestamp: normResult.envelope.originalTimestamp.toISOString(),
      },
    };

    // Fast-forward simulated debounce timer
    const realDateNow = Date.now;
    Date.now = () => normResult.envelope.originalTimestamp.getTime() + 65000;

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
      expect(enqueuedSemanticJobData.verbatimText).toBe('Elektr ta’minotida uzilishlar bo‘lmoqda');

      // Run semantic relevance
      const mockRelevanceEvaluator: any = {
        evaluateRelevance: vi.fn().mockResolvedValue({
          data: {
            is_relevant: true,
            relevant_lanes: ['INFRASTRUCTURE'],
            reasoning: 'Electricity outage report',
          },
          profileId: 'prof_rel_2026_08_v1',
          provider: 'OLLAMA',
          modelId: 'gemma4:12b',
          providerRequestId: 'req_123',
          durationMs: 40,
          tokens: { inputTokens: 15, outputTokens: 10, cachedTokens: 0 },
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

      // Run topic assignment
      const mockTopicMatchingEvaluator: any = {
        evaluateTopicAssignment: vi.fn().mockResolvedValue({
          data: {
            decision: 'NEW_TOPIC',
            primary_lane: 'INFRASTRUCTURE',
            reasoning: 'Electricity outage cluster',
          },
          profileId: 'prof_match_2026_08_v1',
          provider: 'OLLAMA',
          modelId: 'gemma4:12b',
          providerRequestId: 'req_match_123',
          durationMs: 30,
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

      // Assert Accepted Evidence row is persisted with correct attributes
      const evidenceRows = await db
        .select()
        .from(acceptedEvidence)
        .where(
          and(
            eq(acceptedEvidence.districtId, activeDistrictId),
            eq(acceptedEvidence.mahallaName, 'Navbahor'),
          ),
        );

      expect(evidenceRows.length).toBeGreaterThanOrEqual(1);
      const matched = evidenceRows.find(
        (e) => e.verbatimText === 'Elektr ta’minotida uzilishlar bo‘lmoqda',
      );
      expect(matched).toBeDefined();
      expect(matched!.districtId).toBe(activeDistrictId);
      expect(matched!.mahallaName).toBe('Navbahor');
      expect(matched!.telegramChatId).toBe(testChatId);
      expect(matched!.telegramMessageId).toBe('701');
    } finally {
      Date.now = realDateNow;
      sendSpy.mockRestore();
    }
  });

  it('Test 3: Topic synthesis: Verify topic is created / matched from userbot evidence exactly like Bot API evidence', async () => {
    // 1. Ingest Message 1 via USERBOT
    const rawMtprotoUpdate1 = {
      _: 'UpdateNewChannelMessage',
      message: {
        _: 'Message',
        id: 801,
        peerId: { _: 'PeerChannel', channelId: numericChatId },
        fromId: { _: 'PeerUser', userId: 112233 },
        date: Math.floor(Date.now() / 1000),
        message: 'Gaz bosimi juda past bo‘lib ketdi',
      },
      chats: [{ _: 'Channel', id: numericChatId, title: 'Navbahor Mahalla Group' }],
      users: [{ _: 'User', id: 112233, firstName: 'Rustam', bot: false }],
    };

    const normResult1 = normalizeMtprotoUpdate(rawMtprotoUpdate1);
    expect(normResult1.status).toBe('NORMALIZED');
    if (normResult1.status !== 'NORMALIZED') return;

    await processUserbotIngestEnvelope(pool, boss, activeDistrictId, normResult1.envelope);

    // Fast-forward and process debounce -> relevance -> topic assignment
    const debounceJob: any = {
      data: {
        districtId: activeDistrictId,
        mahallaName: 'Navbahor',
        calendarDay: normResult1.envelope.calendarDay,
        telegramChatId: testChatId,
        telegramUserId: '112233',
        source: 'USERBOT',
        telegramBotId: null,
        firstMessageTimestamp: normResult1.envelope.originalTimestamp.toISOString(),
      },
    };

    const realDateNow = Date.now;
    Date.now = () => normResult1.envelope.originalTimestamp.getTime() + 65000;

    let enqueuedSemanticJobData: any = null;
    let enqueuedTopicJobData: any = null;
    const sendSpy = vi.spyOn(boss, 'send').mockImplementation(async (queue: any, data: any) => {
      if (queue === TELEGRAM_SEMANTIC_RELEVANCE_QUEUE) {
        enqueuedSemanticJobData = data;
      }
      if (queue === TELEGRAM_TOPIC_ASSIGNMENT_QUEUE) {
        enqueuedTopicJobData = data;
      }
      return 'mock_job_id';
    });

    try {
      await processBurstDebounceJobs([debounceJob], { db, boss });

      const mockRelevanceEvaluator: any = {
        evaluateRelevance: vi.fn().mockResolvedValue({
          data: {
            is_relevant: true,
            relevant_lanes: ['INFRASTRUCTURE'],
            reasoning: 'Gas pressure issue',
          },
          profileId: 'prof_rel_2026_08_v1',
          provider: 'OLLAMA',
          modelId: 'gemma4:12b',
          providerRequestId: 'req_gas',
          durationMs: 40,
          tokens: { inputTokens: 15, outputTokens: 10, cachedTokens: 0 },
          estimatedCostUsd: '0.0001',
          attempts: [],
        }),
      };

      await processSemanticRelevanceJobs([{ data: enqueuedSemanticJobData } as any], {
        db,
        pool,
        boss,
        relevanceEvaluator: mockRelevanceEvaluator,
      });

      const mockTopicMatchingEvaluator: any = {
        evaluateTopicAssignment: vi.fn().mockResolvedValue({
          data: {
            decision: 'NEW_TOPIC',
            primary_lane: 'INFRASTRUCTURE',
            reasoning: 'New gas supply cluster',
          },
          profileId: 'prof_match_2026_08_v1',
          provider: 'OLLAMA',
          modelId: 'gemma4:12b',
          providerRequestId: 'req_gas_topic',
          durationMs: 30,
          tokens: { inputTokens: 20, outputTokens: 10, cachedTokens: 0 },
          estimatedCostUsd: '0.0001',
          attempts: [],
        }),
      };

      await processTopicAssignmentJobs([{ data: enqueuedTopicJobData } as any], {
        db,
        pool,
        boss,
        topicMatchingEvaluator: mockTopicMatchingEvaluator,
      });

      // Verify topic was created from userbot evidence
      const topicRows = await db
        .select()
        .from(topics)
        .where(
          and(
            eq(topics.districtId, activeDistrictId),
            eq(topics.mahallaName, 'Navbahor'),
            eq(topics.primaryLane, 'INFRASTRUCTURE'),
          ),
        );
      expect(topicRows.length).toBeGreaterThanOrEqual(1);
      const createdTopic = topicRows[0]!;
      expect(createdTopic.districtId).toBe(activeDistrictId);
      expect(createdTopic.mahallaName).toBe('Navbahor');
      expect(createdTopic.primaryLane).toBe('INFRASTRUCTURE');

      // Verify evidence linked to this topic
      const topicEvidence = await db
        .select()
        .from(acceptedEvidence)
        .where(eq(acceptedEvidence.topicId, createdTopic.id));
      expect(topicEvidence.some((e) => e.verbatimText === 'Gaz bosimi juda past bo‘lib ketdi')).toBe(true);
    } finally {
      Date.now = realDateNow;
      sendSpy.mockRestore();
    }
  });

  it('Test 4: Cross-transport deduplication: Group switches transport, duplicate collapses via existing unique key', async () => {
    // 1. Initially set group transport to BOT_API
    await db
      .update(districtTelegramGroups)
      .set({ transport: 'BOT_API' })
      .where(eq(districtTelegramGroups.id, testGroupId));

    const baseTime = Math.floor(Date.now() / 1000);

    // Message #501 ingested via Bot API webhook -> status ACCEPTED
    const botRes1 = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 9001,
      message: {
        message_id: 501,
        date: baseTime,
        chat: { id: testChatId, title: 'Navbahor Mahalla Group' },
        from: { id: 778899, first_name: 'Citizen', is_bot: false },
        text: 'Chiroq o‘chdi #501',
      },
    });
    expect(botRes1.status).toBe('ACCEPTED');

    // 2. Switch group transport to USERBOT
    await switchDistrictTelegramGroupTransport(
      db,
      activeDistrictId,
      testGroupId,
      'USERBOT',
    );

    // 3. Userbot receives message #501 -> collapses to DUPLICATE via existing unique key
    const rawMtproto501 = {
      _: 'UpdateNewChannelMessage',
      message: {
        _: 'Message',
        id: 501,
        peerId: { _: 'PeerChannel', channelId: numericChatId },
        fromId: { _: 'PeerUser', userId: 778899 },
        date: baseTime,
        message: 'Chiroq o‘chdi #501',
      },
      chats: [{ _: 'Channel', id: numericChatId, title: 'Navbahor Mahalla Group' }],
      users: [{ _: 'User', id: 778899, firstName: 'Citizen', bot: false }],
    };
    const norm501 = normalizeMtprotoUpdate(rawMtproto501);
    expect(norm501.status).toBe('NORMALIZED');
    if (norm501.status !== 'NORMALIZED') return;

    const userbotRes1 = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      norm501.envelope,
    );
    expect(userbotRes1.status).toBe('DUPLICATE');

    // 4. Reverse: Message #502 ingested via USERBOT -> status ACCEPTED
    const rawMtproto502 = {
      _: 'UpdateNewChannelMessage',
      message: {
        _: 'Message',
        id: 502,
        peerId: { _: 'PeerChannel', channelId: numericChatId },
        fromId: { _: 'PeerUser', userId: 778899 },
        date: baseTime + 5,
        message: 'Chiroq yondi #502',
      },
      chats: [{ _: 'Channel', id: numericChatId, title: 'Navbahor Mahalla Group' }],
      users: [{ _: 'User', id: 778899, firstName: 'Citizen', bot: false }],
    };
    const norm502 = normalizeMtprotoUpdate(rawMtproto502);
    expect(norm502.status).toBe('NORMALIZED');
    if (norm502.status !== 'NORMALIZED') return;

    const userbotRes2 = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      norm502.envelope,
    );
    expect(userbotRes2.status).toBe('ACCEPTED');

    // Attempt message #502 via Bot API webhook while group is USERBOT -> DROPPED with TRANSPORT_MISMATCH
    const botRes2WhileUserbot = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 9002,
      message: {
        message_id: 502,
        date: baseTime + 5,
        chat: { id: testChatId, title: 'Navbahor Mahalla Group' },
        from: { id: 778899, first_name: 'Citizen', is_bot: false },
        text: 'Chiroq yondi #502',
      },
    });
    expect(botRes2WhileUserbot.status).toBe('DROPPED');
    if (botRes2WhileUserbot.status === 'DROPPED') {
      expect(botRes2WhileUserbot.reason).toBe('TRANSPORT_MISMATCH');
    }

    // Switch group back to BOT_API and re-attempt #502 via Bot API webhook -> collapses to DUPLICATE
    await switchDistrictTelegramGroupTransport(
      db,
      activeDistrictId,
      testGroupId,
      'BOT_API',
    );

    const botRes2AfterSwitch = await processTelegramWebhookUpdate(pool, boss, activeBotId, {
      update_id: 9003,
      message: {
        message_id: 502,
        date: baseTime + 5,
        chat: { id: testChatId, title: 'Navbahor Mahalla Group' },
        from: { id: 778899, first_name: 'Citizen', is_bot: false },
        text: 'Chiroq yondi #502',
      },
    });
    expect(botRes2AfterSwitch.status).toBe('DUPLICATE');

    // Verify exactly 2 records exist in database for messages 501 and 502
    const totalRecords = await db
      .select()
      .from(telegramIntakeRecords)
      .where(
        and(
          eq(telegramIntakeRecords.districtId, activeDistrictId),
          eq(telegramIntakeRecords.telegramChatId, testChatId),
        ),
      );
    const msg501Rows = totalRecords.filter((r) => r.telegramMessageId === '501');
    const msg502Rows = totalRecords.filter((r) => r.telegramMessageId === '502');
    expect(msg501Rows.length).toBe(1);
    expect(msg502Rows.length).toBe(1);
  });

  it('Test 5: Rejection on missing or inactive userbot session or unapproved group', async () => {
    const rawMtproto = {
      _: 'UpdateNewChannelMessage',
      message: {
        _: 'Message',
        id: 999,
        peerId: { _: 'PeerChannel', channelId: numericChatId },
        fromId: { _: 'PeerUser', userId: 123456 },
        date: Math.floor(Date.now() / 1000),
        message: 'Sinov xabari',
      },
      chats: [{ _: 'Channel', id: numericChatId, title: 'Navbahor' }],
    };
    const norm = normalizeMtprotoUpdate(rawMtproto);
    expect(norm.status).toBe('NORMALIZED');
    if (norm.status !== 'NORMALIZED') return;

    // 1. Missing userbot session: other district with no session
    const emptyDistrictId = `dist_empty_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: emptyDistrictId,
      name: `Empty District ${crypto.randomUUID()}`,
      status: 'ACTIVE',
    });

    const resMissingSession = await processUserbotIngestEnvelope(
      pool,
      boss,
      emptyDistrictId,
      norm.envelope,
    );
    expect(resMissingSession.status).toBe('DROPPED');
    if (resMissingSession.status === 'DROPPED') {
      expect(resMissingSession.reason).toBe('USERBOT_SESSION_NOT_ACTIVE');
    }

    // 2. Inactive userbot session: status set to DISABLED
    await db
      .update(districtTelegramUserbotSessions)
      .set({ status: 'DISABLED' })
      .where(eq(districtTelegramUserbotSessions.districtId, activeDistrictId));

    const resDisabledSession = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      norm.envelope,
    );
    expect(resDisabledSession.status).toBe('DROPPED');
    if (resDisabledSession.status === 'DROPPED') {
      expect(resDisabledSession.reason).toBe('USERBOT_SESSION_NOT_ACTIVE');
    }

    // Restore session status to ACTIVE
    await db
      .update(districtTelegramUserbotSessions)
      .set({ status: 'ACTIVE' })
      .where(eq(districtTelegramUserbotSessions.districtId, activeDistrictId));

    // 3. Unapproved group: status set to PENDING
    await db
      .update(districtTelegramGroups)
      .set({ status: 'PENDING' })
      .where(eq(districtTelegramGroups.id, testGroupId));

    const resPendingGroup = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      norm.envelope,
    );
    expect(resPendingGroup.status).toBe('DROPPED');
    if (resPendingGroup.status === 'DROPPED') {
      expect(resPendingGroup.reason).toBe('GROUP_NOT_APPROVED');
    }

    // Restore group to VALID, change transport to BOT_API -> TRANSPORT_MISMATCH
    await db
      .update(districtTelegramGroups)
      .set({ status: 'VALID', transport: 'BOT_API' })
      .where(eq(districtTelegramGroups.id, testGroupId));

    const resTransportMismatch = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      norm.envelope,
    );
    expect(resTransportMismatch.status).toBe('DROPPED');
    if (resTransportMismatch.status === 'DROPPED') {
      expect(resTransportMismatch.reason).toBe('TRANSPORT_MISMATCH');
    }
  });

  it('Test 6: Wire Connection Manager to Ingestion: Client "message" event feeds normalization and transactional intake', async () => {
    const clients = new Map<string, MockUserbotClient>();

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss,
      clientFactory: (params) => {
        const client = new MockUserbotClient(params);
        clients.set(params.districtId, client);
        return client;
      },
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    try {
      await manager.start();
      const activeClient = clients.get(activeDistrictId);
      expect(activeClient).toBeDefined();

      const rawMtprotoMessage = {
        _: 'UpdateNewChannelMessage',
        message: {
          _: 'Message',
          id: 601,
          peerId: { _: 'PeerChannel', channelId: numericChatId },
          fromId: { _: 'PeerUser', userId: 998811 },
          date: Math.floor(Date.now() / 1000),
          message: 'Ko‘chamizda yo‘l ta’miri zarur',
        },
        chats: [{ _: 'Channel', id: numericChatId, title: 'Navbahor' }],
        users: [{ _: 'User', id: 998811, firstName: 'Muxlis', bot: false }],
      };

      // Emit client message event
      activeClient!.emit('message', rawMtprotoMessage);

      // Wait briefly for async ingestion to complete
      await vi.waitFor(
        async () => {
          const [rec] = await db
            .select()
            .from(telegramIntakeRecords)
            .where(
              and(
                eq(telegramIntakeRecords.districtId, activeDistrictId),
                eq(telegramIntakeRecords.telegramChatId, testChatId),
                eq(telegramIntakeRecords.telegramMessageId, '601'),
              ),
            );
          expect(rec).toBeDefined();
          expect(rec!.source).toBe('USERBOT');
          expect(rec!.telegramBotId).toBeNull();
        },
        { timeout: 3000, interval: 50 },
      );
    } finally {
      await manager.stop();
    }
  });

  it('Test 7: Userbot edited message handling: In-buffer edit returns UPDATED, post-AI edit returns ALREADY_PROCESSED, non-existing falls through to ACCEPTED', async () => {
    const baseTime = Math.floor(Date.now() / 1000);

    // 1. Initial message via USERBOT
    const rawMtproto701 = {
      _: 'UpdateNewChannelMessage',
      message: {
        _: 'Message',
        id: 701,
        peerId: { _: 'PeerChannel', channelId: numericChatId },
        fromId: { _: 'PeerUser', userId: 554433 },
        date: baseTime,
        message: 'Boshlang‘ich xabar matni',
      },
      chats: [{ _: 'Channel', id: numericChatId, title: 'Navbahor Mahalla Group' }],
      users: [{ _: 'User', id: 554433, firstName: 'Nodir', bot: false }],
    };
    const norm701 = normalizeMtprotoUpdate(rawMtproto701);
    expect(norm701.status).toBe('NORMALIZED');
    if (norm701.status !== 'NORMALIZED') return;

    const res1 = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      norm701.envelope,
    );
    expect(res1.status).toBe('ACCEPTED');
    if (res1.status !== 'ACCEPTED') return;
    const initialIntakeId = res1.intakeId;

    // 2. In-buffer edit: arrives with edit indicator
    const rawMtprotoEdit = {
      _: 'UpdateEditChannelMessage',
      message: {
        _: 'Message',
        id: 701,
        peerId: { _: 'PeerChannel', channelId: numericChatId },
        fromId: { _: 'PeerUser', userId: 554433 },
        date: baseTime,
        edit_date: baseTime + 5,
        message: 'Tahrirlangan xabar matni: quvur yorilgan',
      },
      chats: [{ _: 'Channel', id: numericChatId, title: 'Navbahor Mahalla Group' }],
      users: [{ _: 'User', id: 554433, firstName: 'Nodir', bot: false }],
    };
    const normEdit = normalizeMtprotoUpdate(rawMtprotoEdit);
    expect(normEdit.status).toBe('NORMALIZED');
    if (normEdit.status !== 'NORMALIZED') return;

    const resEdit = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      normEdit.envelope,
    );
    expect(resEdit.status).toBe('UPDATED');
    if (resEdit.status === 'UPDATED') {
      expect(resEdit.intakeId).toBe(initialIntakeId);
      expect(resEdit.districtId).toBe(activeDistrictId);
      expect(resEdit.mahallaName).toBe('Navbahor');
      expect(resEdit.chatId).toBe(testChatId);
      expect(resEdit.messageId).toBe('701');
    }

    // Verify DB row contains updated raw_payload
    const [record] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.id, initialIntakeId));
    expect(record).toBeDefined();
    const payload = record!.rawPayload as any;
    expect(payload.message?.text).toBe('Tahrirlangan xabar matni: quvur yorilgan');

    // 3. Mark processedAt on the record (simulating post-AI processing)
    await db
      .update(telegramIntakeRecords)
      .set({ processedAt: new Date() })
      .where(eq(telegramIntakeRecords.id, initialIntakeId));

    // Another edit arrives after processing -> DROPPED with ALREADY_PROCESSED
    const resPostAiEdit = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      normEdit.envelope,
    );
    expect(resPostAiEdit.status).toBe('DROPPED');
    if (resPostAiEdit.status === 'DROPPED') {
      expect(resPostAiEdit.reason).toBe('ALREADY_PROCESSED');
    }

    // 4. Edit for non-existent message -> falls through and is inserted as ACCEPTED (Decision 5 Option A)
    const rawMtprotoNonExistentEdit = {
      _: 'UpdateEditChannelMessage',
      message: {
        _: 'Message',
        id: 702,
        peerId: { _: 'PeerChannel', channelId: numericChatId },
        fromId: { _: 'PeerUser', userId: 554433 },
        date: baseTime + 10,
        edit_date: baseTime + 15,
        message: 'Hech qachon bo‘lmagan xabarning tahriri',
      },
      chats: [{ _: 'Channel', id: numericChatId, title: 'Navbahor Mahalla Group' }],
      users: [{ _: 'User', id: 554433, firstName: 'Nodir', bot: false }],
    };
    const normNonExistentEdit = normalizeMtprotoUpdate(rawMtprotoNonExistentEdit);
    expect(normNonExistentEdit.status).toBe('NORMALIZED');
    if (normNonExistentEdit.status !== 'NORMALIZED') return;

    const resNonExistent = await processUserbotIngestEnvelope(
      pool,
      boss,
      activeDistrictId,
      normNonExistentEdit.envelope,
    );
    expect(resNonExistent.status).toBe('ACCEPTED');
    if (resNonExistent.status === 'ACCEPTED') {
      expect(resNonExistent.messageId).toBe('702');
    }
  });
});
