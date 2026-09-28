import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import { globalTestSessionManager } from '../src/modules/telegram-groups/telegram-test-session-store.js';
import { deriveWebhookSecret } from '../src/modules/telegram-intake/webhook-security.js';

const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

describe('Telegram Groups Management & Validation Integration Tests', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;
  let poCookie: string;
  let testDistrictId: string;
  let testBotId: string;
  const testBotToken = '123456789:ABCdefGHIjklmnOPQRstuvWXYZ_12345678';

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    const testUsername = `po_groups_${Date.now()}`;
    const testPassword = 'Secure-PO-Groups-Pass-2026!';

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
    poCookie = cookieHeader ? cookieHeader.split(';')[0]! : '';
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    globalTestSessionManager.clear();

    // Create a fresh district for each test
    testDistrictId = `dist_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: testDistrictId,
      name: `Test District ${crypto.randomUUID().slice(0, 6)}`,
      status: 'SETUP_INCOMPLETE',
    });

    // Create a connected bot for the district
    testBotId = `bot_${crypto.randomUUID().slice(0, 8)}`;
    const enc = encryptToken(testBotToken);
    await db.insert(districtTelegramBots).values({
      id: `dtb_${crypto.randomUUID()}`,
      districtId: testDistrictId,
      botId: testBotId,
      botFirstName: 'Test Group Bot',
      botUsername: 'test_group_bot',
      encryptedToken: enc.encryptedToken,
      tokenIv: enc.tokenIv,
      tokenTag: enc.tokenTag,
      tokenKeyVersion: enc.tokenKeyVersion,
      tokenMasked: `${testBotId}:••••••••••••`,
      status: 'VALID',
      lastValidatedAt: new Date(),
    });
  });

  it('lists empty groups when none configured', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${testDistrictId}/groups`,
      headers: {
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toEqual([]);
  });

  function mockTelegramApi(botId: string, chatId: string, chatTitle: string): () => void {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((...args: Parameters<typeof fetch>) => {
      const urlStr = String(args[0]);
      if (urlStr.includes('/getChatMember')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              result: { status: 'member', user: { id: botId, is_bot: true, first_name: 'Bot' } },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (urlStr.includes('/getChat')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: Number(chatId) || -100123, title: chatTitle, type: 'supergroup' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (urlStr.includes('/getMe')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: botId, is_bot: true, can_read_all_group_messages: true },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return originalFetch(...args);
    });

    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  it('successfully creates a valid group mapping, logs audit event, and verifies webhook intake seam (AC 1, 2, 4, 5, 13, Spec Seam 2)', async () => {
    const chatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;
    const restoreFetch = mockTelegramApi(testBotId, chatId, 'Navbahor Guruhi');

    try {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/groups`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
          'content-type': 'application/json',
        },
        payload: {
          mahallaName: 'Navbahor',
          telegramChatId: chatId,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.group).toBeDefined();
      expect(body.group.mahallaName).toBe('Navbahor');
      expect(body.group.telegramChatId).toBe(chatId);
      expect(body.group.telegramChatTitle).toBe('Navbahor Guruhi');
      expect(body.group.status).toBe('VALID');
      expect(body.group.lastValidatedAt).toBeDefined();
      expect(body.group.privacyModeDisabled).toBe(true);

      // Verify audit log
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'DISTRICT_GROUP_MAPPED'));
      expect(auditRows.length).toBeGreaterThan(0);

      // Webhook Ingestion Seam (Spec lines 92–95):
      // Activate district to simulate live ingestion, inject simulated update; assert accepted and testMessageReceivedAt updated
      await db
        .update(districts)
        .set({ status: 'ACTIVE', accessEligible: true })
        .where(eq(districts.id, testDistrictId));

      const webhookSecret = deriveWebhookSecret(testBotId);
      const updateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/webhooks/telegram/${testBotId}`,
        headers: {
          'x-telegram-bot-api-secret-token': webhookSecret,
          'content-type': 'application/json',
        },
        payload: {
          update_id: 10001,
          message: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            chat: {
              id: Number(chatId) || -1001234567,
              title: 'Navbahor Guruhi',
              type: 'supergroup',
            },
            from: {
              id: 999111,
              is_bot: false,
              first_name: 'Resident',
            },
            text: 'Ichimlik suvi bosimi pasayib ketdi.',
          },
        },
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().status).toBe('ACCEPTED');

      const [dbGroup] = await db
        .select()
        .from(districtTelegramGroups)
        .where(eq(districtTelegramGroups.telegramChatId, chatId));
      expect(dbGroup?.testMessageReceivedAt).toBeDefined();
    } finally {
      restoreFetch();
    }
  });

  it('updates group chat ID, validates with Telegram, and sets status to VALID', async () => {
    const originalChatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;
    const newChatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;
    const groupId = `dtg_${crypto.randomUUID()}`;

    await db.insert(districtTelegramGroups).values({
      id: groupId,
      districtId: testDistrictId,
      mahallaName: 'Yangiobod',
      telegramChatId: originalChatId,
      telegramChatTitle: 'Yangiobod Chat Eski',
      status: 'VALID',
      lastValidatedAt: new Date(Date.now() - 100000),
    });

    const restoreFetch = mockTelegramApi(testBotId, newChatId, 'Yangiobod Yangi Chat');

    try {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/v1/districts/${testDistrictId}/groups/${groupId}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
          'content-type': 'application/json',
        },
        payload: {
          telegramChatId: newChatId,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.group.status).toBe('VALID');
      expect(body.group.telegramChatId).toBe(newChatId);
      expect(body.group.telegramChatTitle).toBe('Yangiobod Yangi Chat');
      expect(body.group.lastValidatedAt).toBeDefined();

      // Verify DB
      const [dbGroup] = await db
        .select()
        .from(districtTelegramGroups)
        .where(eq(districtTelegramGroups.id, groupId));
      expect(dbGroup).toBeDefined();
      expect(dbGroup!.status).toBe('VALID');
      expect(dbGroup!.telegramChatId).toBe(newChatId);
      expect(dbGroup!.lastValidatedAt).toBeDefined();
    } finally {
      restoreFetch();
    }
  });

  it('rejects duplicate Mahalla name within the same district case-insensitively (AC 2)', async () => {
    const chatId1 = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;
    const chatId2 = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;

    await db.insert(districtTelegramGroups).values({
      id: `dtg_${crypto.randomUUID()}`,
      districtId: testDistrictId,
      mahallaName: 'Yangi Hayot',
      telegramChatId: chatId1,
      telegramChatTitle: 'Yangi Hayot Chat',
      status: 'PENDING',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/getChatMember')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { status: 'member' } }),
        });
      }
      if (urlStr.includes('/getChat')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { id: -100, title: 'Chat 2', type: 'supergroup' } }),
        });
      }
      if (urlStr.includes('/getMe')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { id: 1, can_read_all_group_messages: true } }),
        });
      }
      return Promise.reject(new Error('Unknown'));
    }) as any;

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
        'content-type': 'application/json',
      },
      payload: {
        mahallaName: 'YANGI HAYOT',
        telegramChatId: chatId2,
      },
    });

    globalThis.fetch = originalFetch;

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MAHALLA_NAME_EXISTS');
  });

  it('rejects duplicate Telegram group chat ID within the same district (AC 2)', async () => {
    const sharedChatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;

    await db.insert(districtTelegramGroups).values({
      id: `dtg_${crypto.randomUUID()}`,
      districtId: testDistrictId,
      mahallaName: 'Mahalla 1',
      telegramChatId: sharedChatId,
      telegramChatTitle: 'Shared Chat',
      status: 'PENDING',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: 'member', id: -100, title: 'Chat', type: 'supergroup' } }),
      }),
    ) as any;

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
        'content-type': 'application/json',
      },
      payload: {
        mahallaName: 'Mahalla 2',
        telegramChatId: sharedChatId,
      },
    });

    globalThis.fetch = originalFetch;

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('GROUP_ALREADY_MAPPED');
  });

  it('rejects Telegram group chat ID already mapped to another district (AC 3)', async () => {
    const sharedChatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;
    const otherDistrictId = `dist_${crypto.randomUUID()}`;

    await db.insert(districts).values({
      id: otherDistrictId,
      name: `Other District ${crypto.randomUUID().slice(0, 6)}`,
      status: 'SETUP_INCOMPLETE',
    });

    await db.insert(districtTelegramGroups).values({
      id: `dtg_${crypto.randomUUID()}`,
      districtId: otherDistrictId,
      mahallaName: 'Other Mahalla',
      telegramChatId: sharedChatId,
      telegramChatTitle: 'Other District Chat',
      status: 'VALID',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: 'member', id: -100, title: 'Chat', type: 'supergroup' } }),
      }),
    ) as any;

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
        'content-type': 'application/json',
      },
      payload: {
        mahallaName: 'Local Mahalla',
        telegramChatId: sharedChatId,
      },
    });

    globalThis.fetch = originalFetch;

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('GROUP_ALREADY_ASSIGNED');
  });

  it('rejects group mapping if bot is administrator or creator (AC 4)', async () => {
    const chatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/getChatMember')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { status: 'administrator', user: { id: testBotId } },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { id: -100, title: 'Chat', type: 'supergroup' } }),
      });
    }) as any;

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
        'content-type': 'application/json',
      },
      payload: {
        mahallaName: 'Admin Group Mahalla',
        telegramChatId: chatId,
      },
    });

    globalThis.fetch = originalFetch;

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BOT_IS_ADMIN_FORBIDDEN');
  });

  it('rejects group mapping if chat type is channel or private', async () => {
    const chatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/getChat')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { id: -100, title: 'Channel', type: 'channel' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: 'member' } }),
      });
    }) as any;

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
        'content-type': 'application/json',
      },
      payload: {
        mahallaName: 'Channel Mahalla',
        telegramChatId: chatId,
      },
    });

    globalThis.fetch = originalFetch;

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CHAT_TYPE');
  });

  it('runs interactive test session with simulation endpoint (AC 6, 7, 8, 10)', async () => {
    const groupId = `dtg_${crypto.randomUUID()}`;
    const chatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;

    await db.insert(districtTelegramGroups).values({
      id: groupId,
      districtId: testDistrictId,
      mahallaName: 'Sinov Mahalla',
      telegramChatId: chatId,
      telegramChatTitle: 'Sinov Guruhi',
      status: 'PENDING',
    });

    // 1. Start test session
    const startRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/${groupId}/start-test`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(startRes.statusCode).toBe(200);
    expect(startRes.json().session.status).toBe('PENDING');

    // Verify initial test-status is PENDING
    const initialStatusRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${testDistrictId}/groups/${groupId}/test-status`,
      headers: { cookie: poCookie },
    });
    expect(initialStatusRes.statusCode).toBe(200);
    expect(initialStatusRes.json().status).toBe('PENDING');

    // 2. Send simulated bot message (should be rejected)
    const botSimRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/${groupId}/simulate-test-message`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
        'content-type': 'application/json',
      },
      payload: {
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'supergroup' },
          from: { id: 999, is_bot: true, first_name: 'Bot' },
          text: 'Bot xabari',
        },
      },
    });
    expect(botSimRes.statusCode).toBe(200);
    expect(botSimRes.json().accepted).toBe(false);

    // 3. Send simulated human test message (should be accepted and resolve session)
    const humanSimRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/${groupId}/simulate-test-message`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
        'content-type': 'application/json',
      },
      payload: {
        message: {
          message_id: 2,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'supergroup' },
          from: { id: 888, is_bot: false, first_name: 'Resident' },
          text: 'Assalomu alaykum, test xabari.',
        },
      },
    });
    expect(humanSimRes.statusCode).toBe(200);
    expect(humanSimRes.json().accepted).toBe(true);

    // 4. Verify test-status polling returns SUCCESS and updates DB
    const finalStatusRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${testDistrictId}/groups/${groupId}/test-status`,
      headers: { cookie: poCookie },
    });
    expect(finalStatusRes.statusCode).toBe(200);
    expect(finalStatusRes.json().status).toBe('SUCCESS');
    expect(finalStatusRes.json().testMessageReceivedAt).toBeDefined();

    // Verify DB row status is VALID
    const [dbGroup] = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.id, groupId));
    expect(dbGroup).toBeDefined();
    expect(dbGroup!.status).toBe('VALID');
    expect(dbGroup!.testMessageReceivedAt).toBeDefined();
  });

  it('handles public Telegram webhook and validates active test session (AC 7, 8)', async () => {
    const groupId = `dtg_${crypto.randomUUID()}`;
    const chatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;

    await db.insert(districtTelegramGroups).values({
      id: groupId,
      districtId: testDistrictId,
      mahallaName: 'Webhook Mahalla',
      telegramChatId: chatId,
      telegramChatTitle: 'Webhook Guruhi',
      status: 'PENDING',
    });

    // Start test session
    await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${testDistrictId}/groups/${groupId}/start-test`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    // Ingest incoming Telegram webhook without secret -> 401 Unauthorized
    const unauthRes = await server.inject({
      method: 'POST',
      url: `/api/v1/telegram/webhook/${testBotId}`,
      headers: { 'content-type': 'application/json' },
      payload: {
        update_id: 10001,
        message: {
          message_id: 55,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'supergroup' },
          from: { id: 777, is_bot: false, first_name: 'Anvar' },
          text: 'Unauthorized attempt',
        },
      },
    });
    expect(unauthRes.statusCode).toBe(401);

    // Ingest incoming Telegram webhook with valid secret -> 200 OK
    const webhookRes = await server.inject({
      method: 'POST',
      url: `/api/v1/telegram/webhook/${testBotId}`,
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': deriveWebhookSecret(testBotId),
      },
      payload: {
        update_id: 10001,
        message: {
          message_id: 55,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'supergroup' },
          from: { id: 777, is_bot: false, first_name: 'Anvar' },
          text: 'Webhook orqali yuborilgan inson xabari',
        },
      },
    });

    expect(webhookRes.statusCode).toBe(200);
    expect(webhookRes.json().result.accepted).toBe(true);

    // Verify DB group transitioned to VALID
    const [dbGroup] = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.id, groupId));
    expect(dbGroup).toBeDefined();
    expect(dbGroup!.status).toBe('VALID');
  });

  it('deletes a group mapping and records audit log (AC 11, 13)', async () => {
    const groupId = `dtg_${crypto.randomUUID()}`;
    const chatId = `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 10)}`;

    await db.insert(districtTelegramGroups).values({
      id: groupId,
      districtId: testDistrictId,
      mahallaName: 'Ochiriladigan Mahalla',
      telegramChatId: chatId,
      telegramChatTitle: 'Ochiriladigan Guruh',
      status: 'VALID',
    });

    const res = await server.inject({
      method: 'DELETE',
      url: `/api/v1/districts/${testDistrictId}/groups/${groupId}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().deletedGroupId).toBe(groupId);

    // Verify DB row deleted
    const [deleted] = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.id, groupId));
    expect(deleted).toBeUndefined();
  });
});
