import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import type PgBoss from 'pg-boss';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import {
  createBossClient,
  initBossQueues,
  TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
  TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
  type TelegramContentQualificationJobData,
  type TelegramSemanticRelevanceJobData,
} from '../src/adapters/jobs/boss-client.js';
import { startWorker, stopWorker } from '../src/entrypoints/worker.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  telegramIntakeRecords,
} from '../src/adapters/db/schema/index.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';

describe('Story 2.2: Background Worker Content Qualification Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;

  let activeDistrictId: string;
  let suspendedDistrictId: string;
  let activeBotId: string;
  let validChatId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient({ schema: 'pgboss_qualification' });
    await boss.start();
    await initBossQueues(boss);

    // Clean up any stale jobs from previous tests
    await pool.query('DELETE FROM pgboss_qualification.job WHERE name IN ($1, $2)', [
      TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
      TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
    ]);

    // Start background worker with shared boss and db for content qualification only
    await startWorker({ boss, db, pool, queues: [TELEGRAM_CONTENT_QUALIFICATION_QUEUE] });
  });

  afterAll(async () => {
    await stopWorker(boss);
    await pool.end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Clean up jobs table before each test
    await pool.query('DELETE FROM pgboss_qualification.job WHERE name IN ($1, $2)', [
      TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
      TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
    ]);

    // 1. Create Active District
    activeDistrictId = `dist_wq_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: activeDistrictId,
      name: `Worker Test District ${crypto.randomUUID().slice(0, 6)}`,
      status: 'ACTIVE',
      accessEligible: true,
    });

    // 2. Create Suspended District
    suspendedDistrictId = `dist_susp_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: suspendedDistrictId,
      name: `Suspended District ${crypto.randomUUID().slice(0, 6)}`,
      status: 'SUSPENDED',
      accessEligible: false,
    });

    // 3. Create Bot for Active District
    activeBotId = `bot_wq_${crypto.randomUUID().slice(0, 8)}`;
    const enc = encryptToken(`222222222:AA${crypto.randomUUID()}`);
    await db.insert(districtTelegramBots).values({
      id: `dtb_${crypto.randomUUID()}`,
      districtId: activeDistrictId,
      botId: activeBotId,
      botFirstName: 'Worker Test Bot',
      botUsername: 'worker_test_bot',
      encryptedToken: enc.encryptedToken,
      tokenIv: enc.tokenIv,
      tokenTag: enc.tokenTag,
      tokenKeyVersion: enc.tokenKeyVersion,
      tokenMasked: `${activeBotId}:••••••••••••`,
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    // 4. Create Group for Active District
    validChatId = `-100${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await db.insert(districtTelegramGroups).values({
      id: `dtg_${crypto.randomUUID()}`,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      telegramChatId: validChatId,
      telegramChatTitle: 'Guliston Mahalla Chat',
      status: 'VALID',
      lastValidatedAt: new Date(),
    });
  });

  it('processes supported human text and enqueues candidate to telegram-semantic-relevance with singletonKey (AC 1, 6, 8)', async () => {
    const intakeId = `intk_${crypto.randomUUID()}`;
    const messageId = String(Math.floor(Math.random() * 1000000));
    const verbatimText = "Ko'chamizda 3 kundan buyon ichimlik suvi o'chirilgan.";

    // Insert intake record
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      telegramBotId: activeBotId,
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      updateId: '2001',
      telegramUserId: '987654',
      originalTimestamp: new Date('2026-08-21T12:00:00.000Z'),
      calendarDay: '2026-08-21',
      rawPayload: {
        update_id: 2001,
        message: {
          message_id: Number(messageId),
          date: 1787317200,
          chat: { id: Number(validChatId), type: 'supergroup', title: 'Guliston Mahalla Chat' },
          from: { id: 987654, is_bot: false, first_name: 'Bobur' },
          text: verbatimText,
        },
      },
    });

    const qualificationPayload: TelegramContentQualificationJobData = {
      intakeId,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-21',
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      originalTimestamp: '2026-08-21T12:00:00.000Z',
    };

    // Dispatch qualification job
    await boss.send(TELEGRAM_CONTENT_QUALIFICATION_QUEUE, qualificationPayload);

    // Wait for qualification worker to process and downstream queue to receive candidate
    let receivedJob: PgBoss.Job<TelegramSemanticRelevanceJobData> | null = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const jobs = await boss.fetch<TelegramSemanticRelevanceJobData>(TELEGRAM_SEMANTIC_RELEVANCE_QUEUE, {
        batchSize: 10,
      });
      if (jobs && jobs.length > 0) {
        const match = jobs.find((j) => j.data.intakeId === intakeId);
        if (match) {
          receivedJob = match;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    expect(receivedJob).not.toBeNull();
    expect(receivedJob?.data).toEqual({
      intakeId,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-21',
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      telegramUserId: '987654',
      originalTimestamp: '2026-08-21T12:00:00.000Z',
      contentType: 'TEXT',
      verbatimText,
      replyMetadata: null,
    });
  }, 10000);

  it('processes supported media caption and enqueues candidate (AC 2)', async () => {
    const intakeId = `intk_${crypto.randomUUID()}`;
    const messageId = String(Math.floor(Math.random() * 1000000));
    const captionText = "Transformator yonib ketdi, yordam bering!";

    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      telegramBotId: activeBotId,
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      updateId: '2002',
      telegramUserId: '987654',
      originalTimestamp: new Date('2026-08-21T12:05:00.000Z'),
      calendarDay: '2026-08-21',
      rawPayload: {
        update_id: 2002,
        message: {
          message_id: Number(messageId),
          date: 1787317500,
          chat: { id: Number(validChatId), type: 'supergroup' },
          from: { id: 987654, is_bot: false, first_name: 'Bobur' },
          photo: [{ file_id: 'ph_999' }],
          caption: captionText,
        },
      },
    });

    const qualificationPayload: TelegramContentQualificationJobData = {
      intakeId,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-21',
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      originalTimestamp: '2026-08-21T12:05:00.000Z',
    };

    await boss.send(TELEGRAM_CONTENT_QUALIFICATION_QUEUE, qualificationPayload);

    let receivedJob: PgBoss.Job<TelegramSemanticRelevanceJobData> | null = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const jobs = await boss.fetch<TelegramSemanticRelevanceJobData>(TELEGRAM_SEMANTIC_RELEVANCE_QUEUE, {
        batchSize: 10,
      });
      if (jobs && jobs.length > 0) {
        const match = jobs.find((j) => j.data.intakeId === intakeId);
        if (match) {
          receivedJob = match;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    expect(receivedJob).not.toBeNull();
    expect(receivedJob?.data.contentType).toBe('MEDIA_CAPTION');
    expect(receivedJob?.data.verbatimText).toBe(captionText);
  }, 10000);

  it('discards structurally excluded forwarded message and enqueues 0 downstream jobs (AC 3, 4)', async () => {
    const intakeId = `intk_${crypto.randomUUID()}`;
    const messageId = String(Math.floor(Math.random() * 1000000));

    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      telegramBotId: activeBotId,
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      updateId: '2003',
      telegramUserId: '987654',
      originalTimestamp: new Date('2026-08-21T12:10:00.000Z'),
      calendarDay: '2026-08-21',
      rawPayload: {
        update_id: 2003,
        message: {
          message_id: Number(messageId),
          date: 1787317800,
          chat: { id: Number(validChatId), type: 'supergroup' },
          from: { id: 987654, is_bot: false, first_name: 'Bobur' },
          forward_origin: {
            type: 'channel',
            date: 1787300000,
            chat: { id: -100444, type: 'channel' },
            message_id: 1,
          },
          text: "Forward qilingan xabar: suv narxi oshdi",
        },
      },
    });

    const qualificationPayload: TelegramContentQualificationJobData = {
      intakeId,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-21',
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      originalTimestamp: '2026-08-21T12:10:00.000Z',
    };

    await boss.send(TELEGRAM_CONTENT_QUALIFICATION_QUEUE, qualificationPayload);

    // Wait 1 second and assert downstream queue never receives this intakeId
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const jobs = await boss.fetch<TelegramSemanticRelevanceJobData>(TELEGRAM_SEMANTIC_RELEVANCE_QUEUE, {
      batchSize: 20,
    });
    const match = jobs ? jobs.find((j) => j.data.intakeId === intakeId) : undefined;
    expect(match).toBeUndefined();
  }, 10000);

  it('drops job cleanly when district lifecycle status is SUSPENDED or accessEligible false (AC 7 & Matrix #24)', async () => {
    const intakeId = `intk_${crypto.randomUUID()}`;
    const messageId = String(Math.floor(Math.random() * 1000000));

    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId: suspendedDistrictId,
      mahallaName: 'Guliston',
      telegramBotId: activeBotId,
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      updateId: '2004',
      telegramUserId: '987654',
      originalTimestamp: new Date('2026-08-21T12:15:00.000Z'),
      calendarDay: '2026-08-21',
      rawPayload: {
        update_id: 2004,
        message: {
          message_id: Number(messageId),
          date: 1787318100,
          chat: { id: Number(validChatId), type: 'supergroup' },
          from: { id: 987654, is_bot: false, first_name: 'Bobur' },
          text: "To'xtatilgan tuman xabari",
        },
      },
    });

    const qualificationPayload: TelegramContentQualificationJobData = {
      intakeId,
      districtId: suspendedDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-21',
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      originalTimestamp: '2026-08-21T12:15:00.000Z',
    };

    await boss.send(TELEGRAM_CONTENT_QUALIFICATION_QUEUE, qualificationPayload);

    await new Promise((resolve) => setTimeout(resolve, 1000));
    const jobs = await boss.fetch<TelegramSemanticRelevanceJobData>(TELEGRAM_SEMANTIC_RELEVANCE_QUEUE, {
      batchSize: 20,
    });
    const match = jobs ? jobs.find((j) => j.data.intakeId === intakeId) : undefined;
    expect(match).toBeUndefined();
  }, 10000);

  it('strictly excludes raw message text, captions and bot tokens from all worker telemetry logs (AC 9 / AD-11)', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const errorSpy = vi.spyOn(console, 'error');
    const warnSpy = vi.spyOn(console, 'warn');

    const sensitiveSecretText = `UNPERMITTED_LEAK_SECRET_TEXT_${crypto.randomUUID()}`;
    const intakeId = `intk_${crypto.randomUUID()}`;
    const messageId = String(Math.floor(Math.random() * 1000000));

    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      telegramBotId: activeBotId,
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      updateId: '2005',
      telegramUserId: '987654',
      originalTimestamp: new Date('2026-08-21T12:20:00.000Z'),
      calendarDay: '2026-08-21',
      rawPayload: {
        update_id: 2005,
        message: {
          message_id: Number(messageId),
          date: 1787318400,
          chat: { id: Number(validChatId), type: 'supergroup' },
          from: { id: 987654, is_bot: false, first_name: 'Bobur' },
          text: sensitiveSecretText,
        },
      },
    });

    const qualificationPayload: TelegramContentQualificationJobData = {
      intakeId,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-21',
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      originalTimestamp: '2026-08-21T12:20:00.000Z',
    };

    await boss.send(TELEGRAM_CONTENT_QUALIFICATION_QUEUE, qualificationPayload);

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const allLoggedArgs = [
      ...logSpy.mock.calls.flatMap((call) => call),
      ...errorSpy.mock.calls.flatMap((call) => call),
      ...warnSpy.mock.calls.flatMap((call) => call),
    ].map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)));

    for (const logStr of allLoggedArgs) {
      expect(logStr).not.toContain(sensitiveSecretText);
      expect(logStr).not.toContain('AA'); // bot token substring
    }
  }, 10000);

  it('enforces idempotency via singletonKey rel:${districtId}:${chatId}:${messageId} preventing duplicate semantic jobs (AC 6)', async () => {
    const intakeId1 = `intk_${crypto.randomUUID()}`;
    const messageId = String(Math.floor(Math.random() * 1000000));
    const verbatimText = "Bir xil xabar takroran yuborildi";

    // Insert 1 intake record in database
    await db.insert(telegramIntakeRecords).values({
      id: intakeId1,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      telegramBotId: activeBotId,
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      updateId: '2006',
      telegramUserId: '987654',
      originalTimestamp: new Date('2026-08-21T12:25:00.000Z'),
      calendarDay: '2026-08-21',
      rawPayload: {
        update_id: 2006,
        message: {
          message_id: Number(messageId),
          date: 1787318700,
          chat: { id: Number(validChatId), type: 'supergroup' },
          from: { id: 987654, is_bot: false, first_name: 'Bobur' },
          text: verbatimText,
        },
      },
    });

    // Send duplicate qualification jobs concurrently (e.g. queue redelivery / retry)
    await Promise.all([
      boss.send(TELEGRAM_CONTENT_QUALIFICATION_QUEUE, {
        intakeId: intakeId1,
        districtId: activeDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-21',
        telegramChatId: validChatId,
        telegramMessageId: messageId,
        originalTimestamp: '2026-08-21T12:25:00.000Z',
      }),
      boss.send(TELEGRAM_CONTENT_QUALIFICATION_QUEUE, {
        intakeId: intakeId1,
        districtId: activeDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-21',
        telegramChatId: validChatId,
        telegramMessageId: messageId,
        originalTimestamp: '2026-08-21T12:25:00.000Z',
      }),
    ]);

    // Wait for worker processing
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Query jobs in TELEGRAM_SEMANTIC_RELEVANCE_QUEUE for this intakeId
    const jobs = await boss.fetch<TelegramSemanticRelevanceJobData>(TELEGRAM_SEMANTIC_RELEVANCE_QUEUE, {
      batchSize: 20,
    });
    const matchingJobs = (jobs || []).filter((j) => j.data.intakeId === intakeId1);

    // Exactly 1 job exists in the downstream queue despite duplicate qualification dispatches
    expect(matchingJobs.length).toBe(1);
    expect(matchingJobs[0]?.data.districtId).toBe(activeDistrictId);
    expect(matchingJobs[0]?.data.telegramMessageId).toBe(messageId);
  }, 10000);

  it('fails and triggers pg-boss retry when intake record is not found in database', async () => {
    const nonExistentIntakeId = `intk_missing_${crypto.randomUUID()}`;
    const messageId = String(Math.floor(Math.random() * 1000000));

    await boss.send(TELEGRAM_CONTENT_QUALIFICATION_QUEUE, {
      intakeId: nonExistentIntakeId,
      districtId: activeDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-21',
      telegramChatId: validChatId,
      telegramMessageId: messageId,
      originalTimestamp: '2026-08-21T12:30:00.000Z',
    }, { retryLimit: 1, retryDelay: 1 });

    // Wait for worker attempt
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Assert zero downstream jobs enqueued
    const downstreamJobs = await boss.fetch<TelegramSemanticRelevanceJobData>(TELEGRAM_SEMANTIC_RELEVANCE_QUEUE, {
      batchSize: 20,
    });
    const match = downstreamJobs ? downstreamJobs.find((j) => j.data.intakeId === nonExistentIntakeId) : undefined;
    expect(match).toBeUndefined();
  }, 10000);
});
