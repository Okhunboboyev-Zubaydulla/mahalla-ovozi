import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, districtTelegramGroups, topics, topicProjections, acceptedEvidence, telegramIntakeRecords } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import { eq, inArray } from 'drizzle-orm';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { COOKIE_NAME } from '../src/modules/auth/session-manager.js';
import { getTashkentCalendarDay } from '../src/modules/telegram-intake/timezone-util.js';
import { encodeKeysetCursor } from '@mahalla-ovozi/api-contracts';

const SAME_ORIGIN_HEADERS = {
  'sec-fetch-site': 'same-origin',
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 3.8: Keyset Pagination & Safe Continuation Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let districtAId: string;
  let districtBId: string;

  let hokimACookie: string;
  let hokimBCookie: string;

  let hokimAId: string;
  let hokimBId: string;

  const nowEpoch = Math.floor(Date.now() / 1000);
  const todayCalendarDay = getTashkentCalendarDay(nowEpoch);

  const createdTopicIds: string[] = [];
  const createdRecordIds: string[] = [];
  const createdEvidenceIds: string[] = [];

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    await ensureDefaultAiProfiles(db);

    // 1. Create District A & District B
    districtAId = `dist_pag_a_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtAId,
      name: `Пагинация Тумани А ${districtAId}`,
      region: 'Тошкент вилояти',
      status: 'ACTIVE',
    });

    districtBId = `dist_pag_b_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtBId,
      name: `Пагинация Тумани Б ${districtBId}`,
      region: 'Тошкент вилояти',
      status: 'ACTIVE',
    });

    await db.insert(districtTelegramGroups).values([
      {
        id: `dtg_pag_${crypto.randomUUID().slice(0, 8)}`,
        districtId: districtAId,
        telegramChatId: `-100${Date.now()}${Math.floor(Math.random() * 1000)}`,
        telegramChatTitle: 'Чилонзор 1-мавзе Гуруҳи',
        mahallaName: 'Чилонзор 1-мавзе',
        status: 'VALID',
      },
    ]);

    // 2. Create Hokim A and Hokim B accounts
    hokimAId = `acc_hokim_paga_${crypto.randomUUID().slice(0, 8)}`;
    const passHashA = await hashPassword('HokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimAId,
      username: `hokim_paga_${Date.now()}`,
      passwordHash: passHashA,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: districtAId,
      mustChangePassword: false,
    });

    hokimBId = `acc_hokim_pagb_${crypto.randomUUID().slice(0, 8)}`;
    const passHashB = await hashPassword('HokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimBId,
      username: `hokim_pagb_${Date.now()}`,
      passwordHash: passHashB,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: districtBId,
      mustChangePassword: false,
    });

    // 3. Login Hokim A
    const loginARes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: (acc, { eq }) => eq(acc.id, hokimAId) }))!
          .username,
        password: 'HokimPassword2026!',
      },
    });
    const cookieA = loginARes.cookies.find((c) => c.name === COOKIE_NAME);
    hokimACookie = `${cookieA!.name}=${cookieA!.value}`;

    // 4. Login Hokim B
    const loginBRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: (acc, { eq }) => eq(acc.id, hokimBId) }))!
          .username,
        password: 'HokimPassword2026!',
      },
    });
    const cookieB = loginBRes.cookies.find((c) => c.name === COOKIE_NAME);
    hokimBCookie = `${cookieB!.name}=${cookieB!.value}`;
  });

  afterAll(async () => {
    if (createdTopicIds.length > 0) {
      await db.delete(topicProjections).where(inArray(topicProjections.topicId, createdTopicIds));
    }
    if (createdEvidenceIds.length > 0) {
      await db.delete(acceptedEvidence).where(inArray(acceptedEvidence.id, createdEvidenceIds));
    }
    if (createdTopicIds.length > 0) {
      await db.delete(topics).where(inArray(topics.id, createdTopicIds));
    }
    if (createdRecordIds.length > 0) {
      await db
        .delete(telegramIntakeRecords)
        .where(inArray(telegramIntakeRecords.id, createdRecordIds));
    }
    if (districtAId) {
      await db.delete(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, districtAId));
      await db.delete(accounts).where(eq(accounts.districtId, districtAId));
      await db.delete(districts).where(eq(districts.id, districtAId));
    }
    if (districtBId) {
      await db.delete(accounts).where(eq(accounts.districtId, districtBId));
      await db.delete(districts).where(eq(districts.id, districtBId));
    }
    if (server) {
      await server.close();
    }
    if (pool) {
      await pool.end();
    }
  });

  // Helper to create a single topic with projection
  async function seedTopic(params: {
    districtId: string;
    mahallaName: string;
    calendarDay: string;
    primaryLane: 'WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE' | 'HOKIM_RELATED';
    summary: string;
    lanes?: ('WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE' | 'HOKIM_RELATED')[];
    isHokimRelated?: boolean;
    activityTimestamp: Date;
    status?: 'ACTIVE' | 'INACTIVE';
    retentionExpiresAt?: Date;
  }): Promise<string> {
    const topicId = `top_pag_${crypto.randomUUID()}`;
    createdTopicIds.push(topicId);

    const now = new Date();
    const retExpires =
      params.retentionExpiresAt || new Date(now.getTime() + 30 * 86400 * 1000);

    const recId = `tir_pag_${crypto.randomUUID()}`;
    const eviId = `evi_pag_${crypto.randomUUID()}`;
    createdRecordIds.push(recId);
    createdEvidenceIds.push(eviId);

    await db.insert(telegramIntakeRecords).values({
      id: recId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: `-100200${Date.now()}`,
      telegramMessageId: `${Math.floor(Math.random() * 900000)}`,
      calendarDay: params.calendarDay,
      rawPayload: { text: params.summary },
      originalTimestamp: params.activityTimestamp,
      createdAt: now,
    });

    await db.insert(topics).values({
      id: topicId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      calendarDay: params.calendarDay,
      primaryLane: params.primaryLane,
      status: params.status || 'ACTIVE',
      latestRelevantEvidenceTimestamp: params.activityTimestamp,
      retentionExpiresAt: retExpires,
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 1,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(acceptedEvidence).values({
      id: eviId,
      topicId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      calendarDay: params.calendarDay,
      intakeRecordId: recId,
      telegramChatId: `-100200${Date.now()}`,
      telegramMessageId: `${Math.floor(Math.random() * 900000)}`,
      originalTimestamp: params.activityTimestamp,
      verbatimText: params.summary,
      contentType: 'TEXT',
      createdAt: now,
    });

    await db.insert(topicProjections).values({
      id: `proj_${crypto.randomUUID()}`,
      topicId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      calendarDay: params.calendarDay,
      primaryLane: params.primaryLane,
      summary: params.summary,
      lanes: params.lanes || [params.primaryLane],
      anchorEvidenceId: eviId,
      anchorQuote: params.summary.slice(0, 50),
      attribution: 'Mahalla bot',
      isHokimRelated: Boolean(params.isHokimRelated),
      latestMeaningfulActivityTimestamp: params.activityTimestamp,
      generation: 1,
      aiProfileId: 'prof_proj_2026_08_v1',
      createdAt: now,
      updatedAt: now,
    });

    return topicId;
  }

  // 1. Multi-page keyset continuation across batches
  it('Task 4.1: Paginates 25 items across multi-page keyset continuation without duplicate or missing items', async () => {
    const baseTime = Date.now();
    const createdIds: string[] = [];

    // Create 25 topics in WATER lane for District A with distinct descending timestamps
    for (let i = 0; i < 25; i++) {
      const ts = new Date(baseTime - i * 10000);
      const id = await seedTopic({
        districtId: districtAId,
        mahallaName: 'Чилонзор 1-мавзе',
        calendarDay: todayCalendarDay,
        primaryLane: 'WATER',
        summary: `Сув босими муаммоси #${25 - i}`,
        activityTimestamp: ts,
      });
      createdIds.push(id);
    }

    // Page 1: limit=10
    const page1Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=WATER&limit=10`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });
    expect(page1Res.statusCode).toBe(200);
    const page1 = JSON.parse(page1Res.body);
    expect(page1.topics.length).toBe(10);
    expect(page1.hasNextPage).toBe(true);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.topics.map((t: { id: string }) => t.id)).toEqual(createdIds.slice(0, 10));

    // Page 2: limit=10 using page1.nextCursor
    const page2Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=WATER&limit=10&cursor=${page1.nextCursor}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });
    expect(page2Res.statusCode).toBe(200);
    const page2 = JSON.parse(page2Res.body);
    expect(page2.topics.length).toBe(10);
    expect(page2.hasNextPage).toBe(true);
    expect(page2.nextCursor).toBeTruthy();
    expect(page2.topics.map((t: { id: string }) => t.id)).toEqual(createdIds.slice(10, 20));

    // Page 3: limit=10 using page2.nextCursor
    const page3Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=WATER&limit=10&cursor=${page2.nextCursor}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });
    expect(page3Res.statusCode).toBe(200);
    const page3 = JSON.parse(page3Res.body);
    expect(page3.topics.length).toBe(5);
    expect(page3.hasNextPage).toBe(false);
    expect(page3.nextCursor).toBeNull();
    expect(page3.topics.map((t: { id: string }) => t.id)).toEqual(createdIds.slice(20, 25));

    // Ensure all 25 items were returned in order without duplicates
    const allRetrievedIds = [
      ...page1.topics.map((t: { id: string }) => t.id),
      ...page2.topics.map((t: { id: string }) => t.id),
      ...page3.topics.map((t: { id: string }) => t.id),
    ];
    expect(new Set(allRetrievedIds).size).toBe(25);
    expect(allRetrievedIds).toEqual(createdIds);
  });

  // 2. Continuation with active search and mahalla filter via POST body (AD-09)
  it('Task 4.2: Paginates searched results via POST /api/v1/hokim/topics/lane/search with clean URL (AD-09)', async () => {
    const baseTime = Date.now();
    const searchTopicIds: string[] = [];

    for (let i = 0; i < 5; i++) {
      const id = await seedTopic({
        districtId: districtAId,
        mahallaName: 'Чилонзор 1-мавзе',
        calendarDay: todayCalendarDay,
        primaryLane: 'ELECTRICITY',
        summary: `Трансформатор кучланиши пастлаши #${i}`,
        activityTimestamp: new Date(baseTime - i * 15000),
      });
      searchTopicIds.push(id);
    }

    // Page 1 of search: limit=2
    const searchPage1Res = await server.inject({
      method: 'POST',
      url: `/api/v1/hokim/topics/lane/search`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
      payload: {
        lane: 'ELECTRICITY',
        search: 'Трансформатор',
        mahallaName: 'Чилонзор 1-мавзе',
        limit: 2,
      },
    });
    expect(searchPage1Res.statusCode).toBe(200);
    const sPage1 = JSON.parse(searchPage1Res.body);
    expect(sPage1.topics.length).toBe(2);
    expect(sPage1.hasNextPage).toBe(true);
    expect(sPage1.nextCursor).toBeTruthy();

    // Page 2 of search using cursor
    const searchPage2Res = await server.inject({
      method: 'POST',
      url: `/api/v1/hokim/topics/lane/search`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
      payload: {
        lane: 'ELECTRICITY',
        search: 'Трансформатор',
        mahallaName: 'Чилонзор 1-мавзе',
        cursor: sPage1.nextCursor,
        limit: 2,
      },
    });
    expect(searchPage2Res.statusCode).toBe(200);
    const sPage2 = JSON.parse(searchPage2Res.body);
    expect(sPage2.topics.length).toBe(2);
    expect(sPage2.hasNextPage).toBe(true);

    // Page 3 of search
    const searchPage3Res = await server.inject({
      method: 'POST',
      url: `/api/v1/hokim/topics/lane/search`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
      payload: {
        lane: 'ELECTRICITY',
        search: 'Трансформатор',
        mahallaName: 'Чилонзор 1-мавзе',
        cursor: sPage2.nextCursor,
        limit: 2,
      },
    });
    expect(searchPage3Res.statusCode).toBe(200);
    const sPage3 = JSON.parse(searchPage3Res.body);
    expect(sPage3.topics.length).toBe(1);
    expect(sPage3.hasNextPage).toBe(false);
    expect(sPage3.nextCursor).toBeNull();
  });

  // 3. PostgreSQL millisecond precision parity under identical timestamps
  it('Task 4.3: Evaluates millisecond precision parity when topics share identical millisecond timestamp and distinct IDs', async () => {
    const fixedTime = new Date(Date.now() - 3600 * 1000);
    fixedTime.setMilliseconds(123);

    // Create 3 topics sharing exact same millisecond timestamp
    const id1 = await seedTopic({
      districtId: districtAId,
      mahallaName: 'Чилонзор 1-мавзе',
      calendarDay: todayCalendarDay,
      primaryLane: 'GAS',
      summary: 'Газ қувурида босим пасайиши А',
      activityTimestamp: fixedTime,
    });
    const id2 = await seedTopic({
      districtId: districtAId,
      mahallaName: 'Чилонзор 1-мавзе',
      calendarDay: todayCalendarDay,
      primaryLane: 'GAS',
      summary: 'Газ қувурида босим пасайиши Б',
      activityTimestamp: fixedTime,
    });
    const id3 = await seedTopic({
      districtId: districtAId,
      mahallaName: 'Чилонзор 1-мавзе',
      calendarDay: todayCalendarDay,
      primaryLane: 'GAS',
      summary: 'Газ қувурида босим пасайиши В',
      activityTimestamp: fixedTime,
    });

    const sortedIds = [id1, id2, id3].sort().reverse(); // Order by t.id DESC

    // Page 1: limit=1
    const p1Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=GAS&limit=1`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });
    expect(p1Res.statusCode).toBe(200);
    const p1 = JSON.parse(p1Res.body);
    expect(p1.topics.length).toBe(1);
    expect(p1.topics[0].id).toBe(sortedIds[0]);

    // Page 2: limit=1
    const p2Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=GAS&limit=1&cursor=${p1.nextCursor}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });
    expect(p2Res.statusCode).toBe(200);
    const p2 = JSON.parse(p2Res.body);
    expect(p2.topics.length).toBe(1);
    expect(p2.topics[0].id).toBe(sortedIds[1]);

    // Page 3: limit=1
    const p3Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=GAS&limit=1&cursor=${p2.nextCursor}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });
    expect(p3Res.statusCode).toBe(200);
    const p3 = JSON.parse(p3Res.body);
    expect(p3.topics.length).toBe(1);
    expect(p3.topics[0].id).toBe(sortedIds[2]);
  });

  // 4. Cursor validation & INVALID_CURSOR rejection
  it('Task 4.4: Rejects corrupted, malformed, and out-of-bounds cursors with HTTP 400 INVALID_CURSOR', async () => {
    // Malformed JSON cursor
    const malformedJsonCursor = Buffer.from('invalid-json').toString('base64url');
    const res1 = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=WATER&cursor=${malformedJsonCursor}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });
    expect(res1.statusCode).toBe(400);
    const body1 = JSON.parse(res1.body);
    expect(body1.error.code).toBe('INVALID_CURSOR');
    expect(body1.error.message).toBe('Курсор нотўғри ёки муддати ўтган.');

    // Out-of-bounds future cursor (>NOW + 1 min)
    const futureTimestamp = new Date(Date.now() + 10 * 86400 * 1000).toISOString();
    const futureCursor = encodeKeysetCursor({ t: futureTimestamp, id: 'top_future' });
    const res2 = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=WATER&cursor=${futureCursor}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });
    expect(res2.statusCode).toBe(400);
    const body2 = JSON.parse(res2.body);
    expect(body2.error.code).toBe('INVALID_CURSOR');

    // Out-of-bounds old cursor (>90 days ago)
    const ancientTimestamp = new Date(Date.now() - 100 * 86400 * 1000).toISOString();
    const ancientCursor = encodeKeysetCursor({ t: ancientTimestamp, id: 'top_old' });
    const res3 = await server.inject({
      method: 'POST',
      url: `/api/v1/hokim/topics/lane/search`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
      payload: {
        lane: 'WATER',
        cursor: ancientCursor,
      },
    });
    expect(res3.statusCode).toBe(400);
    const body3 = JSON.parse(res3.body);
    expect(body3.error.code).toBe('INVALID_CURSOR');
  });

  // 5. Retention policy and inactive topics exclusion during pagination
  it('Task 4.5: Excludes soft-deleted (INACTIVE) and retention-expired topics from pagination', async () => {
    const now = new Date();
    const expiredDate = new Date(now.getTime() - 1000); // in the past

    const inactiveId = await seedTopic({
      districtId: districtAId,
      mahallaName: 'Чилонзор 1-мавзе',
      calendarDay: todayCalendarDay,
      primaryLane: 'WASTE',
      summary: 'Чиқинди муаммоси нофаол',
      activityTimestamp: now,
      status: 'INACTIVE',
    });

    const expiredId = await seedTopic({
      districtId: districtAId,
      mahallaName: 'Чилонзор 1-мавзе',
      calendarDay: todayCalendarDay,
      primaryLane: 'WASTE',
      summary: 'Чиқинди муаммоси муддати ўтган',
      activityTimestamp: now,
      retentionExpiresAt: expiredDate,
    });

    const activeId = await seedTopic({
      districtId: districtAId,
      mahallaName: 'Чилонзор 1-мавзе',
      calendarDay: todayCalendarDay,
      primaryLane: 'WASTE',
      summary: 'Чиқинди муаммоси фаол',
      activityTimestamp: now,
    });

    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=WASTE`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const retrievedIds = body.topics.map((t: { id: string }) => t.id);

    expect(retrievedIds).toContain(activeId);
    expect(retrievedIds).not.toContain(inactiveId);
    expect(retrievedIds).not.toContain(expiredId);
  });

  // 6. Tenant District Isolation (AD-03) during keyset pagination
  it('Task 4.6: Strict Tenant District Isolation: Hokim B cannot access District A topics or pagination cursors (AD-03)', async () => {
    const resB = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=WATER`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimBCookie,
      },
    });

    expect(resB.statusCode).toBe(200);
    const bodyB = JSON.parse(resB.body);
    expect(bodyB.topics.length).toBe(0);
    expect(bodyB.hasNextPage).toBe(false);
    expect(bodyB.nextCursor).toBeNull();
  });
});
