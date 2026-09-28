import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { districts, districtTelegramBots, auditEvents } from '../src/adapters/db/schema/index.js';
import { decryptToken } from '../src/adapters/crypto/token-cipher.js';
import { eq, desc } from 'drizzle-orm';
import pg from 'pg';
import crypto from 'node:crypto';

const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

describe('Telegram Bot Domain Module & Integration Tests', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;

  const testUsername = `po_tg_${Date.now()}`;
  const testPassword = 'Secure-PO-Telegram-Pass-2026!';
  let authCookie: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    // Provision Product Owner account
    await createOrResetProductOwner(db, {
      username: testUsername,
      password: testPassword,
    });

    // Authenticate and obtain session cookie
    const signInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: testUsername,
        password: testPassword,
      },
    });
    expect(signInRes.statusCode).toBe(200);
    const setCookie = signInRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toBeDefined();
    authCookie = cookieHeader ? cookieHeader.split(';')[0]! : '';
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Authentication & Origin Authorization Guards', () => {
    it('GET /api/v1/districts/:id/telegram-bot rejects unauthenticated requests with 401', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/districts/some-district-id/telegram-bot',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('POST /api/v1/districts/:id/telegram-bot rejects unauthenticated requests with 401', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/districts/some-district-id/telegram-bot',
        headers: SAME_ORIGIN_HEADERS,
        payload: { token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('DELETE /api/v1/districts/:id/telegram-bot rejects unauthenticated requests with 401', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: '/api/v1/districts/some-district-id/telegram-bot',
        headers: SAME_ORIGIN_HEADERS,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('Non-Existent District Handling', () => {
    it('returns 404 for non-existent district on GET, POST, DELETE', async () => {
      const nonExistentId = `dist_${crypto.randomUUID()}`;

      const getRes = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${nonExistentId}/telegram-bot`,
        headers: { cookie: authCookie },
      });
      expect(getRes.statusCode).toBe(404);
      expect(getRes.json().error.code).toBe('DISTRICT_NOT_FOUND');

      const postRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${nonExistentId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567' },
      });
      expect(postRes.statusCode).toBe(404);
      expect(postRes.json().error.code).toBe('DISTRICT_NOT_FOUND');

      const deleteRes = await server.inject({
        method: 'DELETE',
        url: `/api/v1/districts/${nonExistentId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(deleteRes.statusCode).toBe(404);
      expect(deleteRes.json().error.code).toBe('DISTRICT_NOT_FOUND');
    });
  });

  describe('Bot Lifecycle: Connect, Read, Replace, Disconnect & Audit', () => {
    let districtId: string;
    const initialBotId = (500000000 + Math.floor(Math.random() * 100000)).toString();
    const initialToken = `${initialBotId}:ABCdefGHIjklMNOpqrSTUvwxYZ_Initial1`;
    const replacementBotId = (550000000 + Math.floor(Math.random() * 100000)).toString();
    const replacementToken = `${replacementBotId}:XYZabcReplacementBotToken_2026`;

    beforeAll(async () => {
      districtId = `dist_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: districtId,
        name: `TgTestDistrict_${crypto.randomUUID().slice(0, 6)}`,
        status: 'SETUP_INCOMPLETE',
      });
    });

    afterAll(async () => {
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('GET returns { bot: null } when no bot is configured yet', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ bot: null });
    });

    it('connects a valid bot successfully with AES-256-GCM storage and audit logging (AC 3, 7, 12)', async () => {
      // Mock Telegram getMe response
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            id: Number(initialBotId),
            is_bot: true,
            first_name: 'Chilonzor Mahalla Bot',
            username: 'chilonzor_mahalla_bot',
          },
        }),
      } as Response);

      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: initialToken },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.bot).toBeDefined();
      expect(data.bot.districtId).toBe(districtId);
      expect(data.bot.botId).toBe(initialBotId);
      expect(data.bot.botUsername).toBe('chilonzor_mahalla_bot');
      expect(data.bot.botFirstName).toBe('Chilonzor Mahalla Bot');
      expect(data.bot.tokenMasked).toBe(`${initialBotId}:••••••••••••`);
      expect(data.bot.status).toBe('VALID');

      // Secret Exclusion Invariant: Response must NEVER contain raw token or cipher keys
      expect(data.bot).not.toHaveProperty('encryptedToken');
      expect(data.bot).not.toHaveProperty('tokenIv');
      expect(data.bot).not.toHaveProperty('tokenTag');
      expect(JSON.stringify(data)).not.toContain(initialToken);

      // Verify Database Record & Encryption at Rest
      const [storedBot] = await db
        .select()
        .from(districtTelegramBots)
        .where(eq(districtTelegramBots.districtId, districtId));

      expect(storedBot).toBeDefined();
      expect(storedBot!.botId).toBe(initialBotId);
      expect(storedBot!.encryptedToken).toBeDefined();
      expect(storedBot!.tokenIv).toBeDefined();
      expect(storedBot!.tokenTag).toBeDefined();
      expect(storedBot!.tokenKeyVersion).toBe('v1');
      expect(storedBot!.status).toBe('VALID');

      // Decrypt stored ciphertext to verify authenticity
      const decrypted = decryptToken({
        encryptedToken: storedBot!.encryptedToken,
        tokenIv: storedBot!.tokenIv,
        tokenTag: storedBot!.tokenTag,
      });
      expect(decrypted).toBe(initialToken);

      // Verify Privacy-Safe Audit Event (AD-9)
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'DISTRICT_TELEGRAM_BOT_CONNECTED'))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(auditEvent).toBeDefined();
      expect(auditEvent!.metadata).toMatchObject({
        districtId,
        botId: initialBotId,
        botUsername: 'chilonzor_mahalla_bot',
        keyVersion: 'v1',
      });
      // Zero secrets in audit logs
      expect(JSON.stringify(auditEvent!.metadata)).not.toContain(initialToken);
      expect(JSON.stringify(auditEvent!.metadata)).not.toContain(storedBot!.encryptedToken);
    });

    it('GET returns safe masked bot metadata when bot is connected (AC 1, 9)', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.bot).toBeDefined();
      expect(data.bot.botId).toBe(initialBotId);
      expect(data.bot.botUsername).toBe('chilonzor_mahalla_bot');
      expect(data.bot.tokenMasked).toBe(`${initialBotId}:••••••••••••`);
      expect(data.bot.status).toBe('VALID');
      expect(data.bot).not.toHaveProperty('encryptedToken');
    });

    it('dynamically reflects telegram_bot as passed in readiness endpoint (AC 7, 11)', async () => {
      const readinessRes = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtId}/readiness`,
        headers: { cookie: authCookie },
      });

      expect(readinessRes.statusCode).toBe(200);
      const data = readinessRes.json();
      const tgItem = data.readiness.items.find((item: { key: string }) => item.key === 'telegram_bot');

      expect(tgItem).toBeDefined();
      expect(tgItem.status).toBe('passed');
      expect(tgItem.actionRequired).toBe(false);
      expect(tgItem.description).toContain('@chilonzor_mahalla_bot');
      expect(tgItem.completedAt).toBeDefined();
    });

    it('rejects cross-district collision when attaching already-assigned bot (AC 5)', async () => {
      const district2Id = `dist_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: district2Id,
        name: `District2_${crypto.randomUUID().slice(0, 6)}`,
        status: 'SETUP_INCOMPLETE',
      });

      // Mock Telegram getMe returning same bot ID
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            id: Number(initialBotId),
            is_bot: true,
            first_name: 'Chilonzor Mahalla Bot',
            username: 'chilonzor_mahalla_bot',
          },
        }),
      } as Response);

      const collisionRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${district2Id}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: initialToken },
      });

      expect(collisionRes.statusCode).toBe(409);
      expect(collisionRes.json().error.code).toBe('BOT_ALREADY_ASSIGNED');

      // Verify District 2 has no bot attached
      const [bot2] = await db
        .select()
        .from(districtTelegramBots)
        .where(eq(districtTelegramBots.districtId, district2Id));
      expect(bot2).toBeUndefined();

      // Clean up District 2
      await db.delete(districts).where(eq(districts.id, district2Id));
    });

    it('replaces existing bot atomically with a new valid bot (AC 10)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            id: Number(replacementBotId),
            is_bot: true,
            first_name: 'Replaced Bot',
            username: 'replaced_bot',
          },
        }),
      } as Response);

      const replaceRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: replacementToken },
      });

      expect(replaceRes.statusCode).toBe(200);
      const data = replaceRes.json();
      expect(data.bot.botId).toBe(replacementBotId);
      expect(data.bot.botUsername).toBe('replaced_bot');
      expect(data.bot.tokenMasked).toBe(`${replacementBotId}:••••••••••••`);

      // Verify DB updated to replacement
      const [updatedBot] = await db
        .select()
        .from(districtTelegramBots)
        .where(eq(districtTelegramBots.districtId, districtId));
      expect(updatedBot).toBeDefined();
      expect(updatedBot!.botId).toBe(replacementBotId);

      const decrypted = decryptToken({
        encryptedToken: updatedBot!.encryptedToken,
        tokenIv: updatedBot!.tokenIv,
        tokenTag: updatedBot!.tokenTag,
      });
      expect(decrypted).toBe(replacementToken);
    });

    it('disconnects bot and marks readiness incomplete (AC 10, 11, 12)', async () => {
      const deleteRes = await server.inject({
        method: 'DELETE',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.json()).toEqual({
        success: true,
        disconnectedBotId: replacementBotId,
      });

      // Verify deleted from DB
      const [botAfterDelete] = await db
        .select()
        .from(districtTelegramBots)
        .where(eq(districtTelegramBots.districtId, districtId));
      expect(botAfterDelete).toBeUndefined();

      // Verify Audit Event logged
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'DISTRICT_TELEGRAM_BOT_DISCONNECTED'))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      expect(auditEvent).toBeDefined();
      expect(auditEvent!.metadata).toMatchObject({
        districtId,
        botId: replacementBotId,
      });

      // Verify Readiness prerequisite returns to incomplete
      const readinessRes = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtId}/readiness`,
        headers: { cookie: authCookie },
      });
      const tgItem = readinessRes
        .json()
        .readiness.items.find((item: { key: string }) => item.key === 'telegram_bot');
      expect(tgItem.status).toBe('incomplete');
      expect(tgItem.actionRequired).toBe(true);
      expect(tgItem.actionPath).toBe('/telegram-setup');
    });

    it('rejects disconnect when no bot is attached with 404', async () => {
      const deleteRes = await server.inject({
        method: 'DELETE',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(deleteRes.statusCode).toBe(404);
      expect(deleteRes.json().error.code).toBe('TELEGRAM_BOT_NOT_FOUND');
    });
  });

  describe('Invalid Token & Upstream Telegram Error Handling', () => {
    let districtId: string;

    beforeAll(async () => {
      districtId = `dist_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: districtId,
        name: `ErrorDistrict_${crypto.randomUUID().slice(0, 6)}`,
        status: 'SETUP_INCOMPLETE',
      });
    });

    afterAll(async () => {
      await db.delete(districts).where(eq(districts.id, districtId));
    });

    it('returns 400 VALIDATION_ERROR for syntactically invalid token failing schema', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: 'invalid_token' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 TELEGRAM_INVALID_TOKEN when Telegram API responds with 400 Bad Request', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: invalid token' }),
      } as Response);

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_Invalid' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('TELEGRAM_INVALID_TOKEN');
    });

    it('returns 400 when Telegram API responds with 401 Unauthorized', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }),
      } as Response);

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_Invalid' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('TELEGRAM_INVALID_TOKEN');
    });

    it('returns 429 when Telegram rate limits request', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests' }),
      } as Response);

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_RateLim' },
      });

      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('TELEGRAM_RATE_LIMITED');
    });

    it('returns 504 on Telegram network timeout', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'TimeoutError';
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortError);

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_Timeout' },
      });

      expect(res.statusCode).toBe(504);
      expect(res.json().error.code).toBe('TELEGRAM_TIMEOUT');
    });
  });

  describe('District Status Guard (ACTIVE District Mutation & CANCELLED Protection)', () => {
    let activeDistrictId: string;
    let cancelledDistrictId: string;
    const activeBotId = (600000000 + Math.floor(Math.random() * 100000)).toString();
    const activeToken = `${activeBotId}:ABCdefGHIjklMNOpqrSTUvwxYZ_ActiveAllowed`;

    beforeAll(async () => {
      activeDistrictId = `dist_${crypto.randomUUID()}`;
      cancelledDistrictId = `dist_${crypto.randomUUID()}`;

      await db.insert(districts).values([
        {
          id: activeDistrictId,
          name: `ActiveDistrict_${crypto.randomUUID().slice(0, 6)}`,
          status: 'ACTIVE',
        },
        {
          id: cancelledDistrictId,
          name: `CancelledDistrict_${crypto.randomUUID().slice(0, 6)}`,
          status: 'CANCELLED',
        },
      ]);
    });

    afterAll(async () => {
      await db.delete(districts).where(eq(districts.id, activeDistrictId));
      await db.delete(districts).where(eq(districts.id, cancelledDistrictId));
    });

    it('allows POST /telegram-bot to connect or replace bot when district is ACTIVE', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            id: Number(activeBotId),
            is_bot: true,
            first_name: 'Sharof Rashidov Open Budjet',
            username: 'sharof_rashidov_bot',
          },
        }),
      } as Response);

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: activeToken },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.bot).toBeDefined();
      expect(data.bot.botId).toBe(activeBotId);
      expect(data.bot.botUsername).toBe('sharof_rashidov_bot');
    });

    it('allows DELETE /telegram-bot to disconnect bot when district is ACTIVE', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/v1/districts/${activeDistrictId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().disconnectedBotId).toBe(activeBotId);
    });

    it('rejects POST /telegram-bot with 409 DISTRICT_CANCELLED when district is CANCELLED', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${cancelledDistrictId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
        payload: { token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_Cancelled' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DISTRICT_CANCELLED');
    });

    it('rejects DELETE /telegram-bot with 409 DISTRICT_CANCELLED when district is CANCELLED', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/v1/districts/${cancelledDistrictId}/telegram-bot`,
        headers: { cookie: authCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DISTRICT_CANCELLED');
    });
  });
});
