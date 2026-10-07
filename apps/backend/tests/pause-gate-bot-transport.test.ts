import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createBossClient, initBossQueues } from '../src/adapters/jobs/boss-client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import { deriveWebhookSecret } from '../src/modules/telegram-intake/webhook-security.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  telegramIntakeRecords,
} from '../src/adapters/db/schema/index.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import {
  resolveDistrictBotAndGroup,
  resolveDistrictTransportAuthorization,
} from '../src/modules/telegram-intake/telegram-intake-service.js';

describe('Ticket 01: Pause gate for the Bot API transport', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;

  let districtId: string;
  let botId: string;
  let pausedChatId: string;
  let liveChatId: string;
  let pausedGroupId: string;

  beforeAll(async () => {
    // Applies the pause columns to the isolated test database (DATABASE_URL is injected by
    // vitest.config.ts), so the suite never hardcodes a connection string.
    await runMigrations();

    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient();
    await boss.start();
    await initBossQueues(boss);

    server = await buildHttpServer({ db, pool, boss });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await boss.stop({ graceful: true, timeout: 10000 });
    await pool.end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();

    districtId = `dist_pause_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: districtId,
      name: `Pause District ${crypto.randomUUID().slice(0, 6)}`,
      status: 'ACTIVE',
      accessEligible: true,
    });

    botId = `bot_pause_${crypto.randomUUID().slice(0, 8)}`;
    const enc = encryptToken(`444444444:DD${crypto.randomUUID()}`);
    await db.insert(districtTelegramBots).values({
      id: `dtb_${crypto.randomUUID()}`,
      districtId,
      botId,
      botFirstName: 'Pause Gate Bot',
      botUsername: 'pause_gate_bot',
      encryptedToken: enc.encryptedToken,
      tokenIv: enc.tokenIv,
      tokenTag: enc.tokenTag,
      tokenKeyVersion: enc.tokenKeyVersion,
      tokenMasked: `${botId}:••••••••••••`,
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    pausedChatId = `-100${Date.now()}${Math.floor(Math.random() * 1000)}`;
    pausedGroupId = `dtg_${crypto.randomUUID()}`;
    await db.insert(districtTelegramGroups).values({
      id: pausedGroupId,
      districtId,
      mahallaName: 'Paused Mahalla',
      telegramChatId: pausedChatId,
      telegramChatTitle: 'Paused Mahalla Group',
      status: 'VALID',
      transport: 'BOT_API',
      isPaused: true,
    });

    liveChatId = `-100${Date.now() + 1}${Math.floor(Math.random() * 1000)}`;
    await db.insert(districtTelegramGroups).values({
      id: `dtg_${crypto.randomUUID()}`,
      districtId,
      mahallaName: 'Live Mahalla',
      telegramChatId: liveChatId,
      telegramChatTitle: 'Live Mahalla Group',
      status: 'VALID',
      transport: 'BOT_API',
    });
  });

  async function countIntakeRows(chatId: string, messageId: number): Promise<number> {
    const rows = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.telegramChatId, chatId));
    return rows.filter((row) => row.telegramMessageId === String(messageId)).length;
  }

  async function countQueuedJobs(chatId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pgboss.job WHERE data->>'telegramChatId' = $1`,
      [chatId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function readGroup(chatId: string) {
    const [row] = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.telegramChatId, chatId));
    return row;
  }

  function postMessage(chatId: string, messageId: number, updateId: number) {
    return server.inject({
      method: 'POST',
      url: `/api/v1/webhooks/telegram/${botId}`,
      headers: { 'x-telegram-bot-api-secret-token': deriveWebhookSecret(botId) },
      payload: {
        update_id: updateId,
        message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, title: 'Pause Gate Group', type: 'supergroup' },
          from: { id: 771234, first_name: 'Resident' },
          text: 'Suv quvuri yorildi, taʼmirlash kerak.',
        },
      },
    });
  }

  describe('Authorization resolver at the shared seam', () => {
    it('authorizes a non-paused BOT_API group exactly as before the pause gate', async () => {
      const result = await resolveDistrictBotAndGroup(db, botId, liveChatId);

      expect(result.authorized).toBe(true);
      if (result.authorized) {
        expect(result.districtId).toBe(districtId);
        expect(result.mahallaName).toBe('Live Mahalla');
        expect(result.transport).toBe('BOT_API');
      }
    });

    it('returns the dropped authorization outcome with reason GROUP_PAUSED for a paused BOT_API group, after the group and transport checks pass', async () => {
      const result = await resolveDistrictBotAndGroup(db, botId, pausedChatId);

      expect(result).toMatchObject({ authorized: false, reason: 'GROUP_PAUSED', paused: true });
    });

    it('reaches the same paused outcome through the factored transport resolver', async () => {
      const result = await resolveDistrictTransportAuthorization(db, {
        transport: 'BOT_API',
        botId,
        chatId: pausedChatId,
      });

      expect(result).toMatchObject({ authorized: false, reason: 'GROUP_PAUSED', paused: true });
    });

    it('reads the pause flag from the group row the authorization step already loads, and counts each paused drop once', async () => {
      await resolveDistrictBotAndGroup(db, botId, pausedChatId);
      await resolveDistrictBotAndGroup(db, botId, pausedChatId);

      const group = await readGroup(pausedChatId);
      expect(group?.isPaused).toBe(true);
      expect(group?.isPausedSkippedCount).toBe(2);

      // A live group's resolution counts nothing.
      await resolveDistrictBotAndGroup(db, botId, liveChatId);
      const liveGroup = await readGroup(liveChatId);
      expect(liveGroup?.isPausedSkippedCount).toBe(0);
    });
  });

  describe('Bot API webhook acknowledgement and discard for a paused group', () => {
    it('acknowledges a paused message with HTTP 200 DROPPED GROUP_PAUSED, writes no intake record, enqueues no job, and increments the skipped counter by exactly one per message', async () => {
      const firstMessageId = 9001;
      const secondMessageId = 9002;
      const jobsBefore = await countQueuedJobs(pausedChatId);

      const first = await postMessage(pausedChatId, firstMessageId, 6001);
      expect(first.statusCode).toBe(200);
      expect(first.json().ok).toBe(true);
      expect(first.json().status).toBe('DROPPED');
      expect(first.json().reason).toBe('GROUP_PAUSED');

      const second = await postMessage(pausedChatId, secondMessageId, 6002);
      expect(second.statusCode).toBe(200);
      expect(second.json().status).toBe('DROPPED');
      expect(second.json().reason).toBe('GROUP_PAUSED');

      expect(await countIntakeRows(pausedChatId, firstMessageId)).toBe(0);
      expect(await countIntakeRows(pausedChatId, secondMessageId)).toBe(0);
      expect(await countQueuedJobs(pausedChatId)).toBe(jobsBefore);

      const group = await readGroup(pausedChatId);
      expect(group?.isPausedSkippedCount).toBe(2);
    });

    it('leaves a non-paused group persisting and enqueueing as before, with a skipped counter of zero', async () => {
      const messageId = 9003;
      const jobsBefore = await countQueuedJobs(liveChatId);

      const res = await postMessage(liveChatId, messageId, 6003);

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ACCEPTED');
      expect(await countIntakeRows(liveChatId, messageId)).toBe(1);
      expect(await countQueuedJobs(liveChatId)).toBe(jobsBefore + 1);

      const group = await readGroup(liveChatId);
      expect(group?.isPaused).toBe(false);
      expect(group?.isPausedSkippedCount).toBe(0);
    });
  });
});
