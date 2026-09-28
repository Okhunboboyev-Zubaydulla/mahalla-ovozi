import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, topics, topicProjections, acceptedEvidence, telegramIntakeRecords, userDashboardVisits } from '../src/adapters/db/schema/index.js';
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

describe('Story 3.1: Hokim Topic Board & Keyset Pagination Integration Tests', () => {
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

  const testCalendarDay = getTashkentCalendarDay(Math.floor(Date.now() / 1000));

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
      name: `Яккасарой тумани ${districtAId}`,
      region: 'Тошкент шаҳри',
      status: 'ACTIVE',
    });

    districtBId = `dist_b_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtBId,
      name: `Чилонзор тумани ${districtBId}`,
      region: 'Тошкент шаҳри',
      status: 'ACTIVE',
    });

    // Create Hokim A
    hokimAId = `acc_hokim_a_${crypto.randomUUID().slice(0, 8)}`;
    const passHashA = await hashPassword('HokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimAId,
      username: `hokim_a_${Date.now()}`,
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
      username: `hokim_b_${Date.now()}`,
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
      username: `po_${Date.now()}`,
      passwordHash: passHashPO,
      role: 'PRODUCT_OWNER',
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    // Sign in Hokim A
    const resA = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: (acc, { eq }) => eq(acc.id, hokimAId) }))!.username,
        password: 'HokimPassword2026!',
      },
    });
    const cookieA = resA.cookies.find((c) => c.name === COOKIE_NAME);
    hokimACookie = `${cookieA!.name}=${cookieA!.value}`;

    // Sign in Hokim B
    const resB = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: (acc, { eq }) => eq(acc.id, hokimBId) }))!.username,
        password: 'HokimPassword2026!',
      },
    });
    const cookieB = resB.cookies.find((c) => c.name === COOKIE_NAME);
    hokimBCookie = `${cookieB!.name}=${cookieB!.value}`;

    // Sign in PO
    const resPO = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: (acc, { eq }) => eq(acc.id, poId) }))!.username,
        password: 'POPassword2026!',
      },
    });
    const cookiePO = resPO.cookies.find((c) => c.name === COOKIE_NAME);
    poCookie = `${cookiePO!.name}=${cookiePO!.value}`;
  });

  afterAll(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  // Helper to create intake record + evidence + topic + projection
  async function createTestTopic(params: {
    districtId: string;
    mahallaName: string;
    calendarDay: string;
    primaryLane: QualifyingLane;
    lanes: QualifyingLane[];
    summary: string;
    isHokimRelated?: boolean;
    evidenceCount?: number;
    activityTime?: Date;
    createdAt?: Date;
    projectionUpdatedAt?: Date;
  }) {
    const topicId = `top_${crypto.randomUUID()}`;
    const intakeId = `int_${crypto.randomUUID()}`;
    const evidenceId = `evi_${crypto.randomUUID()}`;
    const projectionId = `prj_${crypto.randomUUID()}`;

    const now = params.createdAt ?? new Date();
    const activityTimestamp = params.activityTime ?? now;
    const count = params.evidenceCount ?? 1;

    // Intake record
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '123456',
      telegramMessageId: String(Math.floor(Math.random() * 1000000)),
      rawPayload: {},
      originalTimestamp: activityTimestamp,
      calendarDay: params.calendarDay,
      createdAt: now,
    });

    // Topic
    await db.insert(topics).values({
      id: topicId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      calendarDay: params.calendarDay,
      primaryLane: params.primaryLane,
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: activityTimestamp,
      retentionExpiresAt: new Date(now.getTime() + 90 * 86400000),
      createdAt: now,
      updatedAt: now,
    });

    // Evidence
    await db.insert(acceptedEvidence).values({
      id: evidenceId,
      topicId: topicId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      calendarDay: params.calendarDay,
      intakeRecordId: intakeId,
      telegramChatId: '123456',
      telegramMessageId: String(Math.floor(Math.random() * 1000000)),
      originalTimestamp: activityTimestamp,
      verbatimText: 'Сув босими паст бўляпти.',
      contentType: 'TEXT',
      createdAt: now,
    });

    // Additional evidence if count > 1
    for (let i = 1; i < count; i++) {
      const extraIntakeId = `int_${crypto.randomUUID()}`;
      await db.insert(telegramIntakeRecords).values({
        id: extraIntakeId,
        districtId: params.districtId,
        mahallaName: params.mahallaName,
        telegramBotId: 'bot_test',
        telegramChatId: '123456',
        telegramMessageId: String(Math.floor(Math.random() * 1000000)),
        rawPayload: {},
        originalTimestamp: activityTimestamp,
        calendarDay: params.calendarDay,
        createdAt: now,
      });

      await db.insert(acceptedEvidence).values({
        id: `evi_${crypto.randomUUID()}`,
        topicId: topicId,
        districtId: params.districtId,
        mahallaName: params.mahallaName,
        calendarDay: params.calendarDay,
        intakeRecordId: extraIntakeId,
        telegramChatId: '123456',
        telegramMessageId: String(Math.floor(Math.random() * 1000000)),
        originalTimestamp: activityTimestamp,
        verbatimText: `Қўшимча хабар ${i}`,
        contentType: 'TEXT',
        createdAt: now,
      });
    }

    // Projection
    const defaultAiProfile = (await db.query.aiProfiles.findFirst())!;
    await db.insert(topicProjections).values({
      id: projectionId,
      topicId: topicId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      calendarDay: params.calendarDay,
      summary: params.summary,
      lanes: params.lanes,
      primaryLane: params.primaryLane,
      anchorEvidenceId: evidenceId,
      anchorQuote: 'Сув босими паст',
      latestMeaningfulActivityTimestamp: activityTimestamp,
      attribution: 'Маҳалла аҳолиси',
      isHokimRelated: params.isHokimRelated ?? false,
      generation: 1,
      aiProfileId: defaultAiProfile.id,
      createdAt: now,
      updatedAt: params.projectionUpdatedAt ?? now,
    });

    return { topicId, evidenceId, projectionId };
  }

  describe('AC 1: Authentication & Authorization Isolation', () => {
    it('rejects unauthenticated request to /api/v1/hokim/topics/board with 401', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/board',
        headers: SAME_ORIGIN_HEADERS,
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects non-Hokim (Product Owner) request to /api/v1/hokim/topics/board with 403', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/board',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('isolates topics strictly to authenticated Hokim district (District A vs District B)', async () => {
      // Create a topic in District A
      const { topicId: topicAId } = await createTestTopic({
        districtId: districtAId,
        mahallaName: 'Боғсарой',
        calendarDay: testCalendarDay,
        primaryLane: 'WATER',
        lanes: ['WATER'],
        summary: 'Яккасаройда сув масаласи.',
      });

      // Create a topic in District B
      const { topicId: topicBId } = await createTestTopic({
        districtId: districtBId,
        mahallaName: 'Гулистон',
        calendarDay: testCalendarDay,
        primaryLane: 'WATER',
        lanes: ['WATER'],
        summary: 'Чилонзорда сув масаласи.',
      });

      // Hokim A fetches board
      const resA = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });
      expect(resA.statusCode).toBe(200);
      const dataA = JSON.parse(resA.body);
      expect(dataA.districtId).toBe(districtAId);
      expect(dataA.districtName).toBe(`Яккасарой тумани ${districtAId}`);
      const waterTopicIdsA = dataA.lanes.WATER.topics.map((t: { id: string }) => t.id);
      expect(waterTopicIdsA).toContain(topicAId);
      expect(waterTopicIdsA).not.toContain(topicBId);

      // Hokim B fetches board
      const resB = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimBCookie,
        },
      });
      expect(resB.statusCode).toBe(200);
      const dataB = JSON.parse(resB.body);
      expect(dataB.districtId).toBe(districtBId);
      expect(dataB.districtName).toBe(`Чилонзор тумани ${districtBId}`);
      const waterTopicIdsB = dataB.lanes.WATER.topics.map((t: { id: string }) => t.id);
      expect(waterTopicIdsB).toContain(topicBId);
      expect(waterTopicIdsB).not.toContain(topicAId);
    });
  });

  describe('AC 3 & 4: Five Canonical Lanes & Multi-Lane Topic Identity', () => {
    it('returns all 5 canonical lanes and maps multi-lane topic to both lanes with correct additionalLanes and evidence count', async () => {
      // Create a multi-lane topic belonging to WATER and HOKIM_RELATED with 3 evidence items
      const { topicId } = await createTestTopic({
        districtId: districtAId,
        mahallaName: 'Тўқимачи',
        calendarDay: testCalendarDay,
        primaryLane: 'WATER',
        lanes: ['WATER', 'HOKIM_RELATED'],
        summary: 'Тўқимачи маҳалласида сув аварияси, ҳоким назоратида.',
        isHokimRelated: true,
        evidenceCount: 3,
      });

      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      // Verify 5 canonical lanes exist in response
      expect(data.lanes).toHaveProperty('HOKIM_RELATED');
      expect(data.lanes).toHaveProperty('WATER');
      expect(data.lanes).toHaveProperty('ELECTRICITY');
      expect(data.lanes).toHaveProperty('GAS');
      expect(data.lanes).toHaveProperty('WASTE');

      // Verify multi-lane presence in WATER
      const waterTopic = data.lanes.WATER.topics.find((t: { id: string }) => t.id === topicId);
      expect(waterTopic).toBeDefined();
      expect(waterTopic.mahallaName).toBe('Тўқимачи');
      expect(waterTopic.evidenceCount).toBe(3);
      expect(waterTopic.lanes).toEqual(expect.arrayContaining(['WATER', 'HOKIM_RELATED']));
      expect(waterTopic.additionalLanes).toEqual(['HOKIM_RELATED']);

      // Verify multi-lane presence in HOKIM_RELATED
      const hokimTopic = data.lanes.HOKIM_RELATED.topics.find((t: { id: string }) => t.id === topicId);
      expect(hokimTopic).toBeDefined();
      expect(hokimTopic.id).toBe(topicId); // Same canonical ID
      expect(hokimTopic.evidenceCount).toBe(3);
      expect(hokimTopic.additionalLanes).toEqual(['WATER']);
    });
  });

  describe('AC 5: Deterministic Visit Baseline & Freshness State', () => {
    it('sets isNew and isUpdated to false on initial visit, and calculates them correctly on subsequent visit', async () => {
      // Clear visits for Hokim A in District A
      await db.delete(userDashboardVisits).where(eq(userDashboardVisits.userId, hokimAId));

      const oldTime = new Date(Date.now() - 100000);
      const { topicId: initialTopicId } = await createTestTopic({
        districtId: districtAId,
        mahallaName: 'Ракат',
        calendarDay: testCalendarDay,
        primaryLane: 'GAS',
        lanes: ['GAS'],
        summary: 'Ракат маҳалласида газ босими.',
        createdAt: oldTime,
        projectionUpdatedAt: oldTime,
        activityTime: oldTime,
      });

      // 1. First visit
      const res1 = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });
      const data1 = JSON.parse(res1.body);
      expect(data1.visitBaselineTimestamp).toBeNull();
      const gasInitial1 = data1.lanes.GAS.topics.find((t: { id: string }) => t.id === initialTopicId);
      expect(gasInitial1.isNew).toBe(false);
      expect(gasInitial1.isUpdated).toBe(false);

      // Now create a brand NEW topic after visit 1
      const afterVisit1Time = new Date();
      const { topicId: newTopicId } = await createTestTopic({
        districtId: districtAId,
        mahallaName: 'Муқимий',
        calendarDay: testCalendarDay,
        primaryLane: 'GAS',
        lanes: ['GAS'],
        summary: 'Янги газ муаммоси.',
        createdAt: afterVisit1Time,
        projectionUpdatedAt: afterVisit1Time,
        activityTime: afterVisit1Time,
      });

      // Update projection for initialTopicId
      await db
        .update(topicProjections)
        .set({
          summary: 'Ракат маҳалласида газ босими янгиланди.',
          updatedAt: afterVisit1Time,
        })
        .where(eq(topicProjections.topicId, initialTopicId));

      // 2. Second visit
      const res2 = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });
      const data2 = JSON.parse(res2.body);
      expect(data2.visitBaselineTimestamp).toBeDefined();
      expect(data2.visitBaselineTimestamp).not.toBeNull();

      const gasInitial2 = data2.lanes.GAS.topics.find((t: { id: string }) => t.id === initialTopicId);
      expect(gasInitial2.isNew).toBe(false);
      expect(gasInitial2.isUpdated).toBe(true); // Updated after baseline

      const gasNew = data2.lanes.GAS.topics.find((t: { id: string }) => t.id === newTopicId);
      expect(gasNew.isNew).toBe(true); // Created after baseline
    });
  });

  describe('AC 5 (A2): visit append semantics on a GET read path', () => {
    it('appends one immutable visit row per board load, never updating or colliding', async () => {
      await db.delete(userDashboardVisits).where(eq(userDashboardVisits.userId, hokimAId));

      const before = await db
        .select()
        .from(userDashboardVisits)
        .where(eq(userDashboardVisits.userId, hokimAId));
      expect(before).toHaveLength(0);

      for (const _ of [1, 2]) {
        const res = await server.inject({
          method: 'GET',
          url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
          headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimACookie },
        });
        expect(res.statusCode).toBe(200);
      }

      const rows = await db
        .select()
        .from(userDashboardVisits)
        .where(eq(userDashboardVisits.userId, hokimAId));

      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.id)).size).toBe(2);
      expect(rows.every((r) => r.id.startsWith('vis_'))).toBe(true);
    });
  });

  describe('AC 6: Keyset Pagination & Lane-Local Continuation', () => {
    it('paginates lane topics deterministically using keyset cursor without skipping or duplicating', async () => {
      const now = Date.now();
      const baseLane: QualifyingLane = 'ELECTRICITY';

      // Insert 25 topics into ELECTRICITY lane with distinct activity timestamps
      const createdTopicIds: string[] = [];
      for (let i = 0; i < 25; i++) {
        const time = new Date(now - (25 - i) * 60000);
        const { topicId } = await createTestTopic({
          districtId: districtAId,
          mahallaName: `Маҳалла ${i}`,
          calendarDay: testCalendarDay,
          primaryLane: baseLane,
          lanes: [baseLane],
          summary: `Электр таъминоти масаласи ${i}`,
          activityTime: time,
          createdAt: time,
        });
        createdTopicIds.push(topicId);
      }

      // Query board: should return first 20 topics with hasNextPage: true and nextCursor
      const resBoard = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });
      const boardData = JSON.parse(resBoard.body);
      const laneData = boardData.lanes.ELECTRICITY;

      expect(laneData.topics.length).toBe(20);
      expect(laneData.hasNextPage).toBe(true);
      expect(laneData.nextCursor).toBeDefined();
      expect(laneData.totalCount).toBeGreaterThanOrEqual(25);

      const firstPageIds = laneData.topics.map((t: { id: string }) => t.id);

      // Continuation query with cursor
      const resNext = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/lane?lane=ELECTRICITY&calendarDay=${testCalendarDay}&cursor=${laneData.nextCursor}&limit=20`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });
      expect(resNext.statusCode).toBe(200);
      const nextData = JSON.parse(resNext.body);
      const secondPageIds = nextData.topics.map((t: { id: string }) => t.id);

      // Verify no overlap between page 1 and page 2
      for (const id of secondPageIds) {
        expect(firstPageIds).not.toContain(id);
      }
      expect(secondPageIds.length).toBeGreaterThanOrEqual(5);
    });


    it('returns a null summary for a newly created unprojected topic (no projection row)', async () => {
      const unprojectedTopicId = `top_unproj_${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date();
      await db.insert(topics).values({
        id: unprojectedTopicId,
        districtId: districtAId,
        mahallaName: 'Гулистон',
        calendarDay: testCalendarDay,
        primaryLane: 'WATER',
        status: 'ACTIVE',
        latestRelevantEvidenceTimestamp: now,
        retentionExpiresAt: new Date(now.getTime() + 86400000),
        requiredDerivedGeneration: 1,
        appliedDerivedGeneration: 0,
      });

      // Query board
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      const waterTopics = data.lanes.WATER.topics;
      const found = waterTopics.find((t: { id: string }) => t.id === unprojectedTopicId);
      expect(found).toBeDefined();
      expect(found.summary).toBeNull();
      expect(found.primaryLane).toBe('WATER');
      expect(found.lanes).toEqual(['WATER']);
    });

    it('rejects invalid calendarDay format on GET /board with 400 VALIDATION_ERROR', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/board?calendarDay=not-a-date',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects malformed or non-date cursor on GET /lane with 400 INVALID_CURSOR', async () => {
      const invalidCursor = Buffer.from(JSON.stringify({ t: 'not-a-date', id: 'top_1' })).toString('base64url');
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/hokim/topics/lane?lane=WATER&cursor=${invalidCursor}`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INVALID_CURSOR');
      expect(body.error.message).toBe('Курсор нотўғри ёки муддати ўтган.');
    });
  });
});
