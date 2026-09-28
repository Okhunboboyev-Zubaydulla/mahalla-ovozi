import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, districtTelegramGroups, topics, topicProjections, acceptedEvidence, telegramIntakeRecords } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { COOKIE_NAME } from '../src/modules/auth/session-manager.js';
import { getTashkentCalendarDay } from '../src/modules/telegram-intake/timezone-util.js';
import { QualifyingLane } from '@mahalla-ovozi/api-contracts';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 3.4: Filter Current and Retained Topics Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let districtAId: string;
  let districtBId: string;
  let hokimACookie: string;
  let hokimBCookie: string;
  let poCookie: string;

  let hokimAId: string;
  let hokimBId: string;
  let poId: string;

  const nowEpoch = Math.floor(Date.now() / 1000);
  const todayCalendarDay = getTashkentCalendarDay(nowEpoch);
  const yesterdayCalendarDay = getTashkentCalendarDay(nowEpoch - 86400);
  const sevenDaysAgoCalendarDay = getTashkentCalendarDay(nowEpoch - 7 * 86400);
  const ninetyFiveDaysAgo = getTashkentCalendarDay(nowEpoch - 95 * 86400);

  const createdTopicIds: string[] = [];
  const createdRecordIds: string[] = [];

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    await ensureDefaultAiProfiles(db);

    // Create District A & District B
    districtAId = `dist_a_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtAId,
      name: `Филтр Тест Туман А ${districtAId}`,
      region: 'Тошкент вилояти',
      status: 'ACTIVE',
    });

    districtBId = `dist_b_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtBId,
      name: `Филтр Тест Туман Б ${districtBId}`,
      region: 'Тошкент вилояти',
      status: 'ACTIVE',
    });

    // Create Hokim A
    hokimAId = `acc_hokim_a_${crypto.randomUUID().slice(0, 8)}`;
    const passHashA = await hashPassword('HokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimAId,
      username: `hokim_filter_a_${Date.now()}`,
      passwordHash: passHashA,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: districtAId,
      mustChangePassword: false,
    });

    // Create Hokim B
    hokimBId = `acc_hokim_b_${crypto.randomUUID().slice(0, 8)}`;
    const passHashB = await hashPassword('HokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimBId,
      username: `hokim_filter_b_${Date.now()}`,
      passwordHash: passHashB,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: districtBId,
      mustChangePassword: false,
    });

    // Create Product Owner
    poId = `acc_po_${crypto.randomUUID().slice(0, 8)}`;
    const passHashPO = await hashPassword('POPassword2026!');
    await db.insert(accounts).values({
      id: poId,
      username: `po_filter_${Date.now()}`,
      passwordHash: passHashPO,
      role: 'PRODUCT_OWNER',
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    // Login Hokim A
    const loginResA = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: { username: (await db.query.accounts.findFirst({ where: eq(accounts.id, hokimAId) }))!.username, password: 'HokimPassword2026!' },
    });
    const cookieA = loginResA.cookies.find((c) => c.name === COOKIE_NAME);
    hokimACookie = `${cookieA!.name}=${cookieA!.value}`;

    // Login Hokim B
    const loginResB = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: { username: (await db.query.accounts.findFirst({ where: eq(accounts.id, hokimBId) }))!.username, password: 'HokimPassword2026!' },
    });
    const cookieB = loginResB.cookies.find((c) => c.name === COOKIE_NAME);
    hokimBCookie = `${cookieB!.name}=${cookieB!.value}`;

    // Login PO
    const loginResPO = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: { username: (await db.query.accounts.findFirst({ where: eq(accounts.id, poId) }))!.username, password: 'POPassword2026!' },
    });
    const cookiePO = loginResPO.cookies.find((c) => c.name === COOKIE_NAME);
    poCookie = `${cookiePO!.name}=${cookiePO!.value}`;

    // Seed Telegram Groups for District A (Mahalla 1 and Mahalla 2) and District B (Mahalla B)
    await db.insert(districtTelegramGroups).values([
      {
        id: `grp_a1_${crypto.randomUUID().slice(0, 8)}`,
        districtId: districtAId,
        telegramChatId: `-1001${Date.now()}1`,
        telegramChatTitle: 'Наврўз Гуруҳи',
        mahallaName: 'Наврўз',
        status: 'VALID',
      },
      {
        id: `grp_a2_${crypto.randomUUID().slice(0, 8)}`,
        districtId: districtAId,
        telegramChatId: `-1001${Date.now()}2`,
        telegramChatTitle: 'Боғбон Гуруҳи',
        mahallaName: 'Боғбон',
        status: 'VALID',
      },
      {
        id: `grp_b1_${crypto.randomUUID().slice(0, 8)}`,
        districtId: districtBId,
        telegramChatId: `-1001${Date.now()}3`,
        telegramChatTitle: 'Чорсу Гуруҳи',
        mahallaName: 'Чорсу',
        status: 'VALID',
      },
    ]);

    // Helper to seed a topic with projection & evidence
    async function seedTopic(params: {
      districtId: string;
      lane: QualifyingLane;
      calendarDay: string;
      mahallaName: string;
      title: string;
      createdAt: Date;
    }) {
      const topicId = `top_flt_${crypto.randomUUID().slice(0, 8)}`;
      const intakeId = `int_flt_${crypto.randomUUID().slice(0, 8)}`;
      const evidenceId = `evi_flt_${crypto.randomUUID().slice(0, 8)}`;
      const projectionId = `prj_flt_${crypto.randomUUID().slice(0, 8)}`;

      createdTopicIds.push(topicId);
      createdRecordIds.push(intakeId);

      await db.insert(telegramIntakeRecords).values({
        id: intakeId,
        districtId: params.districtId,
        mahallaName: params.mahallaName,
        telegramBotId: 'bot_test',
        telegramChatId: '123456',
        telegramMessageId: String(Math.floor(Math.random() * 1000000)),
        rawPayload: {},
        originalTimestamp: params.createdAt,
        calendarDay: params.calendarDay,
        createdAt: params.createdAt,
      });

      await db.insert(topics).values({
        id: topicId,
        districtId: params.districtId,
        mahallaName: params.mahallaName,
        calendarDay: params.calendarDay,
        primaryLane: params.lane,
        status: 'ACTIVE',
        latestRelevantEvidenceTimestamp: params.createdAt,
        retentionExpiresAt: new Date(params.createdAt.getTime() + 90 * 86400000),
        createdAt: params.createdAt,
        updatedAt: params.createdAt,
      });

      await db.insert(acceptedEvidence).values({
        id: evidenceId,
        topicId,
        districtId: params.districtId,
        mahallaName: params.mahallaName,
        calendarDay: params.calendarDay,
        intakeRecordId: intakeId,
        telegramChatId: '123456',
        telegramMessageId: String(Math.floor(Math.random() * 1000000)),
        originalTimestamp: params.createdAt,
        verbatimText: params.title,
        contentType: 'TEXT',
        createdAt: params.createdAt,
      });

      const defaultAiProfile = (await db.query.aiProfiles.findFirst())!;
      await db.insert(topicProjections).values({
        id: projectionId,
        topicId,
        districtId: params.districtId,
        mahallaName: params.mahallaName,
        calendarDay: params.calendarDay,
        summary: params.title,
        lanes: [params.lane],
        primaryLane: params.lane,
        anchorEvidenceId: evidenceId,
        anchorQuote: params.title,
        latestMeaningfulActivityTimestamp: params.createdAt,
        attribution: 'Маҳалла аҳолиси',
        isHokimRelated: params.lane === 'HOKIM_RELATED',
        generation: 1,
        aiProfileId: defaultAiProfile.id,
        createdAt: params.createdAt,
        updatedAt: params.createdAt,
      });

      return topicId;
    }

    // Seed test topics for District A:
    // 1. Today, WATER, Наврўз
    await seedTopic({
      districtId: districtAId,
      lane: 'WATER',
      calendarDay: todayCalendarDay,
      mahallaName: 'Наврўз',
      title: 'Наврўзда сув босими паст',
      createdAt: new Date(),
    });

    // 2. Today, ELECTRICITY, Боғбон
    await seedTopic({
      districtId: districtAId,
      lane: 'ELECTRICITY',
      calendarDay: todayCalendarDay,
      mahallaName: 'Боғбон',
      title: 'Боғбонда электр узилиш',
      createdAt: new Date(),
    });

    // 3. Yesterday, GAS, Наврўз
    await seedTopic({
      districtId: districtAId,
      lane: 'GAS',
      calendarDay: yesterdayCalendarDay,
      mahallaName: 'Наврўз',
      title: 'Кеча Наврўзда газ пасайди',
      createdAt: new Date(Date.now() - 86400 * 1000),
    });

    // 4. 7 days ago, WASTE, Боғбон
    await seedTopic({
      districtId: districtAId,
      lane: 'WASTE',
      calendarDay: sevenDaysAgoCalendarDay,
      mahallaName: 'Боғбон',
      title: '7 кун олдин чиқинди тўпланган',
      createdAt: new Date(Date.now() - 7 * 86400 * 1000),
    });

    // Seed test topic for District B (Tenant isolation check):
    await seedTopic({
      districtId: districtBId,
      lane: 'WATER',
      calendarDay: todayCalendarDay,
      mahallaName: 'Чорсу',
      title: 'Чорсуда сув муаммоси',
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    // Cleanup seeded topics and records
    if (createdTopicIds.length > 0) {
      for (const topicId of createdTopicIds) {
        await db.delete(topicProjections).where(eq(topicProjections.topicId, topicId));
        await db.delete(acceptedEvidence).where(eq(acceptedEvidence.topicId, topicId));
        await db.delete(topics).where(eq(topics.id, topicId));
      }
    }
    if (createdRecordIds.length > 0) {
      for (const recId of createdRecordIds) {
        await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.id, recId));
      }
    }
    if (districtAId) {
      await db.delete(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, districtAId));
      await db.delete(accounts).where(eq(accounts.districtId, districtAId));
      await db.delete(districts).where(eq(districts.id, districtAId));
    }
    if (districtBId) {
      await db.delete(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, districtBId));
      await db.delete(accounts).where(eq(accounts.districtId, districtBId));
      await db.delete(districts).where(eq(districts.id, districtBId));
    }
    if (poId) {
      await db.delete(accounts).where(eq(accounts.id, poId));
    }
    await server.close();
    await pool.end();
  });

  describe('GET /api/v1/hokim/topics/mahallas', () => {
    it('returns 200 with distinct sorted mahallas for the Hokims district', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/mahallas',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.mahallas).toBeDefined();
      expect(Array.isArray(data.mahallas)).toBe(true);
      expect(data.mahallas).toContain('Боғбон');
      expect(data.mahallas).toContain('Наврўз');
      // Tenant isolation: must NOT contain District B mahalla 'Чорсу'
      expect(data.mahallas).not.toContain('Чорсу');
    });

    it('rejects unauthenticated request with 401 UNAUTHORIZED', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/mahallas',
        headers: SAME_ORIGIN_HEADERS,
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects non-Hokim role with 403 FORBIDDEN', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/mahallas',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns only District B mahallas for Hokim B (tenant isolation)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/mahallas',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimBCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.mahallas).toContain('Чорсу');
      expect(data.mahallas).not.toContain('Боғбон');
      expect(data.mahallas).not.toContain('Наврўз');
    });
  });

  describe('GET /api/v1/hokim/topics/board - Filter Parameters', () => {
    it('filters by dateScope=today correctly', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/board?dateScope=today',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.calendarDay).toBe(todayCalendarDay);
      expect(data.lanes.WATER.totalCount).toBe(1);
      expect(data.lanes.ELECTRICITY.totalCount).toBe(1);
      expect(data.lanes.GAS.totalCount).toBe(0); // Gas was yesterday
    });

    it('filters by dateScope=yesterday correctly', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/board?dateScope=yesterday',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.calendarDay).toBe(yesterdayCalendarDay);
      expect(data.lanes.GAS.totalCount).toBe(1);
      expect(data.lanes.WATER.totalCount).toBe(0);
    });

    it('filters by dateScope=custom with single day', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?dateScope=custom&dateFrom=${sevenDaysAgoCalendarDay}&dateTo=${sevenDaysAgoCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.calendarDay).toBe(sevenDaysAgoCalendarDay);
      expect(data.lanes.WASTE.totalCount).toBe(1);
      expect(data.lanes.WATER.totalCount).toBe(0);
    });

    it('filters by dateScope=custom with multi-day range', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?dateScope=custom&dateFrom=${sevenDaysAgoCalendarDay}&dateTo=${todayCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.lanes.WATER.totalCount).toBe(1);
      expect(data.lanes.ELECTRICITY.totalCount).toBe(1);
      expect(data.lanes.GAS.totalCount).toBe(1);
      expect(data.lanes.WASTE.totalCount).toBe(1);
    });

    it('filters by mahallaName correctly', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?dateScope=custom&dateFrom=${sevenDaysAgoCalendarDay}&dateTo=${todayCalendarDay}&mahallaName=${encodeURIComponent('Наврўз')}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      // Only Наврўз topics (WATER and GAS)
      expect(data.lanes.WATER.totalCount).toBe(1);
      expect(data.lanes.GAS.totalCount).toBe(1);
      // Боғбон topics (ELECTRICITY and WASTE) should be filtered out
      expect(data.lanes.ELECTRICITY.totalCount).toBe(0);
      expect(data.lanes.WASTE.totalCount).toBe(0);
    });

    it('filters by active lanes correctly (lanes=WATER,GAS)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?dateScope=custom&dateFrom=${sevenDaysAgoCalendarDay}&dateTo=${todayCalendarDay}&lanes=WATER,GAS`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.lanes.WATER).toBeDefined();
      expect(data.lanes.WATER.totalCount).toBe(1);
      expect(data.lanes.GAS).toBeDefined();
      expect(data.lanes.GAS.totalCount).toBe(1);
      // Unrequested lanes must not be populated
      expect(data.lanes.HOKIM_RELATED).toBeUndefined();
      expect(data.lanes.ELECTRICITY).toBeUndefined();
      expect(data.lanes.WASTE).toBeUndefined();
    });

    it('rejects dates older than 90 days with 400 TOPIC_BOARD_ERROR', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?dateScope=custom&dateFrom=${ninetyFiveDaysAgo}&dateTo=${todayCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('TOPIC_BOARD_ERROR');
    });

    it('rejects dateFrom > dateTo with 400 VALIDATION_ERROR', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?dateScope=custom&dateFrom=${todayCalendarDay}&dateTo=${yesterdayCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/hokim/topics/lane - Filter Parameters', () => {
    it('supports keyset pagination with custom date range and mahalla filter', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/lane?lane=WATER&dateScope=custom&dateFrom=${sevenDaysAgoCalendarDay}&dateTo=${todayCalendarDay}&mahallaName=${encodeURIComponent('Наврўз')}&limit=10`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.lane).toBe('WATER');
      expect(data.topics.length).toBe(1);
      expect(data.topics[0].summary).toBe('Наврўзда сув босими паст');
    });

    it('rejects future calendarDay parameter beyond today with 400 error', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?calendarDay=2099-01-01`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('TOPIC_BOARD_ERROR');
    });
  });
});
