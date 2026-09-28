import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  districtTelegramUserbotSessions,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import type { GroupTransport } from '@mahalla-ovozi/api-contracts';
import {
  createDistrictTelegramGroup,
  switchDistrictTelegramGroupTransport,
  UserbotSessionNotActiveError,
} from '../src/modules/telegram-groups/telegram-groups-service.js';
import {
  resolveDistrictBotAndGroup,
  resolveDistrictUserbotAndGroup,
  processTelegramWebhookUpdate,
} from '../src/modules/telegram-intake/telegram-intake-service.js';
import type { TelegramUpdate } from '../src/adapters/telegram/telegram-types.js';

const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

describe('Ticket 06: Per-Group Transport Selection Integration Tests', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;
  let poCookie: string;
  let testDistrictId: string;
  let testBotId: string;
  const testBotToken = '123456789:ABCdefGHIjklmnOPQRstuvWXYZ_12345678';

  const usedChatIds = new Set<string>();
  function nextTestChatId(): string {
    let id: string;
    do {
      const randomSuffix = Math.floor(1000000000 + Math.random() * 9000000000);
      id = `-100${randomSuffix}`;
    } while (usedChatIds.has(id));
    usedChatIds.add(id);
    return id;
  }

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    const testUsername = `po_transport_${Date.now()}`;
    const testPassword = 'Secure-PO-Transport-Pass-2026!';

    await createOrResetProductOwner(db, {
      username: testUsername,
      password: testPassword,
    });

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
    poCookie = cookieHeader ? cookieHeader.split(';')[0]! : '';
  });

  afterAll(async () => {
    if (usedChatIds.size > 0) {
      await db
        .delete(districtTelegramGroups)
        .where(inArray(districtTelegramGroups.telegramChatId, Array.from(usedChatIds)));
    }
    await server.close();
    await pool.end();
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

  beforeEach(async () => {
    vi.restoreAllMocks();

    testDistrictId = `dist_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: testDistrictId,
      name: `Test District Transport ${crypto.randomUUID().slice(0, 6)}`,
      status: 'ACTIVE',
      accessEligible: true,
    });

    testBotId = `bot_${crypto.randomUUID().slice(0, 8)}`;
    const enc = encryptToken(testBotToken);
    await db.insert(districtTelegramBots).values({
      id: `dtb_${crypto.randomUUID()}`,
      districtId: testDistrictId,
      botId: testBotId,
      botFirstName: 'Test Transport Bot',
      botUsername: 'test_transport_bot',
      encryptedToken: enc.encryptedToken,
      tokenIv: enc.tokenIv,
      tokenTag: enc.tokenTag,
      tokenKeyVersion: enc.tokenKeyVersion,
      tokenMasked: `${testBotId}:••••••••••••`,
      status: 'VALID',
      lastValidatedAt: new Date(),
    });
  });

  async function createActiveUserbotSession(districtId: string): Promise<string> {
    const sessionId = `dtus_${crypto.randomUUID()}`;
    await db.insert(districtTelegramUserbotSessions).values({
      id: sessionId,
      districtId,
      phoneNumber: '+998901234567',
      apiId: '1234567',
      status: 'ACTIVE',
    });
    return sessionId;
  }

  async function createGroup(
    districtId: string,
    mahallaName: string,
    chatId: string,
    transport: GroupTransport,
  ): Promise<string> {
    const groupId = `dtg_${crypto.randomUUID()}`;
    await db.insert(districtTelegramGroups).values({
      id: groupId,
      districtId,
      mahallaName,
      telegramChatId: chatId,
      telegramChatTitle: `${mahallaName} Chat`,
      status: 'VALID',
      transport,
    });
    return groupId;
  }

  // --- 1. Schema & Defaults ---
  describe('Group Transport Default & Creation', () => {
    it('defaults transport to BOT_API when created via service', async () => {
      const chatId = nextTestChatId();
      const restore = mockTelegramApi(testBotId, chatId, 'Default Transport Mahalla');
      try {
        const group = await createDistrictTelegramGroup(db, testDistrictId, {
          mahallaName: 'Default Transport Mahalla',
          telegramChatId: chatId,
        });

        expect(group.transport).toBe('BOT_API');

        const [row] = await db
          .select()
          .from(districtTelegramGroups)
          .where(eq(districtTelegramGroups.id, group.id));
        expect(row?.transport).toBe('BOT_API');
      } finally {
        restore();
      }
    });

    it('defaults transport to BOT_API when created via HTTP endpoint', async () => {
      const chatId = nextTestChatId();
      const restore = mockTelegramApi(testBotId, chatId, 'HTTP Default Mahalla');
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
            mahallaName: 'HTTP Default Mahalla',
            telegramChatId: chatId,
          },
        });

        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.group.transport).toBe('BOT_API');
      } finally {
        restore();
      }
    });

    it('allows creating group with USERBOT transport when District has ACTIVE session', async () => {
      await createActiveUserbotSession(testDistrictId);
      const chatId = nextTestChatId();
      const group = await createDistrictTelegramGroup(db, testDistrictId, {
        mahallaName: 'Userbot Creation Mahalla',
        telegramChatId: chatId,
        transport: 'USERBOT',
      });

      expect(group.transport).toBe('USERBOT');
    });

    it('allows creating group with USERBOT transport when District has NO bot connected', async () => {
      const botlessDistrictId = `dist_nobot_${crypto.randomUUID().slice(0, 8)}`;
      await db.insert(districts).values({
        id: botlessDistrictId,
        name: `Botless District ${crypto.randomUUID().slice(0, 6)}`,
        status: 'ACTIVE',
        accessEligible: true,
      });
      await createActiveUserbotSession(botlessDistrictId);
      const chatId = nextTestChatId();

      const group = await createDistrictTelegramGroup(db, botlessDistrictId, {
        mahallaName: 'Botless Mahalla',
        telegramChatId: chatId,
        transport: 'USERBOT',
      });

      expect(group.transport).toBe('USERBOT');
      expect(group.telegramChatTitle).toBe('Botless Mahalla');
      expect(group.telegramChatUsername).toBeNull();
      expect(group.botMembershipStatus).toBeNull();
      expect(group.privacyModeDisabled).toBe(false);
      expect(group.status).toBe('VALID');
    });

    it('rejects creating group with USERBOT transport when District has no active userbot session', async () => {
      const chatId = nextTestChatId();
      await expect(
        createDistrictTelegramGroup(db, testDistrictId, {
          mahallaName: 'No Session Mahalla',
          telegramChatId: chatId,
          transport: 'USERBOT',
        }),
      ).rejects.toThrow(UserbotSessionNotActiveError);
    });
  });

  // --- 2. Switching Transport ---
  describe('Group Transport Switching & Validation', () => {
    it('successfully switches to USERBOT when District has an ACTIVE userbot session and records audit event', async () => {
      await createActiveUserbotSession(testDistrictId);
      const chatId = nextTestChatId();
      const groupId = await createGroup(testDistrictId, 'Switch Success Mahalla', chatId, 'BOT_API');

      const updated = await switchDistrictTelegramGroupTransport(
        db,
        testDistrictId,
        groupId,
        'USERBOT',
        { id: 'po_test_actor', role: 'PRODUCT_OWNER' },
        { ipAddress: '127.0.0.1', userAgent: 'TestAgent' },
      );

      expect(updated.transport).toBe('USERBOT');

      // Verify DB persistence
      const [row] = await db
        .select()
        .from(districtTelegramGroups)
        .where(eq(districtTelegramGroups.id, groupId));
      expect(row?.transport).toBe('USERBOT');

      // Verify Audit Event
      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'GROUP_TRANSPORT_CHANGED'),
            eq(auditEvents.districtId, testDistrictId),
          ),
        );
      expect(audit).toBeDefined();
      expect(audit?.actorId).toBe('po_test_actor');
      expect(audit?.metadata).toMatchObject({
        groupId,
        previousTransport: 'BOT_API',
        newTransport: 'USERBOT',
      });
    });

    it('successfully switches back from USERBOT to BOT_API and records audit event', async () => {
      await createActiveUserbotSession(testDistrictId);
      const chatId = nextTestChatId();
      const groupId = await createGroup(testDistrictId, 'Switch Back Mahalla', chatId, 'USERBOT');

      const updated = await switchDistrictTelegramGroupTransport(
        db,
        testDistrictId,
        groupId,
        'BOT_API',
        { id: 'po_test_actor', role: 'PRODUCT_OWNER' },
      );

      expect(updated.transport).toBe('BOT_API');

      const audits = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'GROUP_TRANSPORT_CHANGED'),
            eq(auditEvents.districtId, testDistrictId),
          ),
        );
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const lastAudit = audits[audits.length - 1];
      expect(lastAudit?.metadata).toMatchObject({
        groupId,
        previousTransport: 'USERBOT',
        newTransport: 'BOT_API',
      });
    });

    it('switches transport via PUT /api/v1/districts/:districtId/groups/:groupId HTTP route', async () => {
      await createActiveUserbotSession(testDistrictId);
      const chatId = nextTestChatId();
      const groupId = await createGroup(testDistrictId, 'HTTP Switch Mahalla', chatId, 'BOT_API');

      const res = await server.inject({
        method: 'PUT',
        url: `/api/v1/districts/${testDistrictId}/groups/${groupId}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
          'content-type': 'application/json',
        },
        payload: {
          transport: 'USERBOT',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.group.transport).toBe('USERBOT');
    });

    it('refuses switch to USERBOT when session is missing with 400 USERBOT_SESSION_NOT_ACTIVE', async () => {
      const chatId = nextTestChatId();
      const groupId = await createGroup(testDistrictId, 'Missing Session Mahalla', chatId, 'BOT_API');

      const res = await server.inject({
        method: 'PUT',
        url: `/api/v1/districts/${testDistrictId}/groups/${groupId}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
          'content-type': 'application/json',
        },
        payload: {
          transport: 'USERBOT',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('USERBOT_SESSION_NOT_ACTIVE');
    });

    it('refuses switch to USERBOT when session is PENDING', async () => {
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '1234567',
        status: 'PENDING',
      });

      const chatId = nextTestChatId();
      const groupId = await createGroup(testDistrictId, 'Pending Session Mahalla', chatId, 'BOT_API');

      await expect(
        switchDistrictTelegramGroupTransport(db, testDistrictId, groupId, 'USERBOT'),
      ).rejects.toThrow(UserbotSessionNotActiveError);
    });

    it('refuses switch to USERBOT when session is BANNED', async () => {
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '1234567',
        status: 'BANNED',
      });

      const chatId = nextTestChatId();
      const groupId = await createGroup(testDistrictId, 'Banned Session Mahalla', chatId, 'BOT_API');

      await expect(
        switchDistrictTelegramGroupTransport(db, testDistrictId, groupId, 'USERBOT'),
      ).rejects.toThrow(UserbotSessionNotActiveError);
    });

    it('refuses switch to USERBOT when session is DISABLED', async () => {
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '1234567',
        status: 'DISABLED',
      });

      const chatId = nextTestChatId();
      const groupId = await createGroup(testDistrictId, 'Disabled Session Mahalla', chatId, 'BOT_API');

      await expect(
        switchDistrictTelegramGroupTransport(db, testDistrictId, groupId, 'USERBOT'),
      ).rejects.toThrow(UserbotSessionNotActiveError);
    });
  });

  // --- 3. Authorization Resolver ---
  describe('Authorization Resolver: resolveDistrictBotAndGroup & resolveDistrictUserbotAndGroup', () => {
    it('resolveDistrictBotAndGroup authorizes when group transport is BOT_API', async () => {
      const chatId = nextTestChatId();
      const groupId = await createGroup(testDistrictId, 'Bot Api Auth Mahalla', chatId, 'BOT_API');

      const result = await resolveDistrictBotAndGroup(db, testBotId, chatId);
      expect(result.authorized).toBe(true);
      if (result.authorized) {
        expect(result.districtId).toBe(testDistrictId);
        expect(result.botId).toBe(testBotId);
        expect(result.groupId).toBe(groupId);
        expect(result.transport).toBe('BOT_API');
      }
    });

    it('resolveDistrictBotAndGroup rejects group with TRANSPORT_MISMATCH when configured as USERBOT (mutual exclusivity)', async () => {
      const chatId = nextTestChatId();
      await createGroup(testDistrictId, 'Userbot Mismatch Mahalla', chatId, 'USERBOT');

      const result = await resolveDistrictBotAndGroup(db, testBotId, chatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('TRANSPORT_MISMATCH');
      }
    });

    it('resolveDistrictUserbotAndGroup authorizes when District ACTIVE, session ACTIVE, group VALID and mapped to District with USERBOT', async () => {
      await createActiveUserbotSession(testDistrictId);
      const chatId = nextTestChatId();
      const groupId = await createGroup(testDistrictId, 'Userbot Auth Mahalla', chatId, 'USERBOT');

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(true);
      if (result.authorized) {
        expect(result.districtId).toBe(testDistrictId);
        expect(result.mahallaName).toBe('Userbot Auth Mahalla');
        expect(result.groupId).toBe(groupId);
        expect(result.botId).toBeNull();
        expect(result.transport).toBe('USERBOT');
      }
    });

    it('resolveDistrictUserbotAndGroup authorizes when District is in GRACE status', async () => {
      await createActiveUserbotSession(testDistrictId);
      await db
        .update(districts)
        .set({ status: 'GRACE' })
        .where(eq(districts.id, testDistrictId));

      const chatId = nextTestChatId();
      await createGroup(testDistrictId, 'Grace Userbot Mahalla', chatId, 'USERBOT');

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(true);
    });

    it('resolveDistrictUserbotAndGroup rejects with USERBOT_SESSION_NOT_ACTIVE when session is missing', async () => {
      const chatId = nextTestChatId();
      await createGroup(testDistrictId, 'No Session Resolver Mahalla', chatId, 'USERBOT');

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('USERBOT_SESSION_NOT_ACTIVE');
      }
    });

    it('resolveDistrictUserbotAndGroup rejects with USERBOT_SESSION_NOT_ACTIVE when session is PENDING', async () => {
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '1234567',
        status: 'PENDING',
      });

      const chatId = nextTestChatId();
      await createGroup(testDistrictId, 'Pending Resolver Mahalla', chatId, 'USERBOT');

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('USERBOT_SESSION_NOT_ACTIVE');
      }
    });

    it('resolveDistrictUserbotAndGroup rejects with USERBOT_SESSION_NOT_ACTIVE when session is BANNED', async () => {
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '1234567',
        status: 'BANNED',
      });

      const chatId = nextTestChatId();
      await createGroup(testDistrictId, 'Banned Resolver Mahalla', chatId, 'USERBOT');

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('USERBOT_SESSION_NOT_ACTIVE');
      }
    });

    it('resolveDistrictUserbotAndGroup rejects with USERBOT_SESSION_NOT_ACTIVE when session is DISABLED', async () => {
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '1234567',
        status: 'DISABLED',
      });

      const chatId = nextTestChatId();
      await createGroup(testDistrictId, 'Disabled Resolver Mahalla', chatId, 'USERBOT');

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('USERBOT_SESSION_NOT_ACTIVE');
      }
    });

    it('resolveDistrictUserbotAndGroup rejects with DISTRICT_NOT_ACTIVE when District is not ACTIVE or GRACE', async () => {
      await createActiveUserbotSession(testDistrictId);
      await db
        .update(districts)
        .set({ status: 'CANCELLED' })
        .where(eq(districts.id, testDistrictId));

      const chatId = nextTestChatId();
      await createGroup(testDistrictId, 'Cancelled District Mahalla', chatId, 'USERBOT');

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('DISTRICT_NOT_ACTIVE');
      }
    });

    it('resolveDistrictUserbotAndGroup rejects with DISTRICT_NOT_ACTIVE when district accessEligible is false', async () => {
      await createActiveUserbotSession(testDistrictId);
      await db
        .update(districts)
        .set({ accessEligible: false })
        .where(eq(districts.id, testDistrictId));

      const chatId = nextTestChatId();
      await createGroup(testDistrictId, 'Ineligible District Mahalla', chatId, 'USERBOT');

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('DISTRICT_NOT_ACTIVE');
      }
    });

    it('resolveDistrictUserbotAndGroup rejects with CROSS_DISTRICT_MISMATCH when group belongs to a different district', async () => {
      await createActiveUserbotSession(testDistrictId);

      // Create a second district with active session
      const otherDistrictId = `dist_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: otherDistrictId,
        name: `Other District ${crypto.randomUUID().slice(0, 6)}`,
        status: 'ACTIVE',
        accessEligible: true,
      });
      await createActiveUserbotSession(otherDistrictId);

      // Map group to other district
      const chatId = nextTestChatId();
      await createGroup(otherDistrictId, 'Other District Mahalla', chatId, 'USERBOT');

      // Attempt to resolve under testDistrictId
      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('CROSS_DISTRICT_MISMATCH');
      }
    });

    it('resolveDistrictUserbotAndGroup rejects with GROUP_NOT_APPROVED when group does not exist', async () => {
      await createActiveUserbotSession(testDistrictId);
      const unknownChatId = nextTestChatId();

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, unknownChatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('GROUP_NOT_APPROVED');
      }
    });

    it('resolveDistrictUserbotAndGroup rejects with GROUP_NOT_APPROVED when group status is PENDING', async () => {
      await createActiveUserbotSession(testDistrictId);
      const chatId = nextTestChatId();
      await db.insert(districtTelegramGroups).values({
        id: `dtg_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        mahallaName: 'Pending Status Mahalla',
        telegramChatId: chatId,
        telegramChatTitle: 'Pending Status Chat',
        status: 'PENDING',
        transport: 'USERBOT',
      });

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('GROUP_NOT_APPROVED');
      }
    });

    it('resolveDistrictUserbotAndGroup rejects with TRANSPORT_MISMATCH when group transport is BOT_API', async () => {
      await createActiveUserbotSession(testDistrictId);
      const chatId = nextTestChatId();
      await createGroup(testDistrictId, 'Bot Api Transport Mahalla', chatId, 'BOT_API');

      const result = await resolveDistrictUserbotAndGroup(db, testDistrictId, chatId);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('TRANSPORT_MISMATCH');
      }
    });
  });

  // --- 4. Webhook Intake Seam Mutual Exclusivity ---
  describe('Webhook Ingress Seam Mutual Exclusivity', () => {
    it('drops webhook message with TRANSPORT_MISMATCH when incoming chat has USERBOT transport', async () => {
      await createActiveUserbotSession(testDistrictId);
      const chatId = nextTestChatId();
      await createGroup(testDistrictId, 'Exclusivity Mahalla', chatId, 'USERBOT');

      const mockBoss = {
        send: vi.fn().mockResolvedValue('job-123'),
      } as any;

      const update: TelegramUpdate = {
        update_id: 12345,
        message: {
          message_id: 9999,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: Number(chatId),
            type: 'supergroup',
            title: 'Exclusivity Chat',
          },
          from: {
            id: 111222,
            is_bot: false,
            first_name: 'Citizen',
          },
          text: 'Bu guruh endi userbot transportiga otkazilgan.',
        },
      };

      const result = await processTelegramWebhookUpdate(pool, mockBoss, testBotId, update);
      expect(result.status).toBe('DROPPED');
      if (result.status === 'DROPPED') {
        expect(result.reason).toBe('TRANSPORT_MISMATCH');
      }
    });
  });
});
