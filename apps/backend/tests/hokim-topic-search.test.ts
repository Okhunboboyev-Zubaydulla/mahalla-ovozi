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
import { escapeLikePattern } from '../src/modules/topics/topic-query-helpers.js';

const SAME_ORIGIN_HEADERS = {
  'sec-fetch-site': 'same-origin',
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 3.7: Private Lexical Search Integration Tests', () => {
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

  const createdTopicIds: string[] = [];
  const createdRecordIds: string[] = [];

  beforeAll(async () => {
    const testDbUrl =
      process.env.DATABASE_URL ||
      'postgresql://mahalla_user:mahalla_dev_password@localhost:5433/mahalla_ovozi_test';
    pool = createDbPool(testDbUrl);
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    await ensureDefaultAiProfiles(db);

    // 1. Create District A
    districtAId = `dist_sa_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtAId,
      name: `Қидирув Тумани А ${districtAId}`,
      region: 'Тошкент вилояти',
      status: 'ACTIVE',
    });

    // 2. Create District B (for Tenant Isolation)
    districtBId = `dist_sb_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtBId,
      name: `Қидирув Тумани Б ${districtBId}`,
      region: 'Тошкент вилояти',
      status: 'ACTIVE',
    });

    // Seed Telegram group for District A
    await db.insert(districtTelegramGroups).values([
      {
        id: `grp_sa1_${crypto.randomUUID().slice(0, 8)}`,
        districtId: districtAId,
        telegramChatId: `-1002${Date.now()}1`,
        telegramChatTitle: 'Наврўз Қидирув Гуруҳи',
        mahallaName: 'Наврўз',
        status: 'VALID',
      },
    ]);

    // Create Hokim A account
    hokimAId = `usr_h_sa_${crypto.randomUUID().slice(0, 8)}`;
    const pwA = await hashPassword('HokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimAId,
      username: `hokim_sa_${Date.now()}`,
      passwordHash: pwA,
      role: 'DISTRICT_HOKIM',
      districtId: districtAId,
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    // Create Hokim B account
    hokimBId = `usr_h_sb_${crypto.randomUUID().slice(0, 8)}`;
    const pwB = await hashPassword('HokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimBId,
      username: `hokim_sb_${Date.now()}`,
      passwordHash: pwB,
      role: 'DISTRICT_HOKIM',
      districtId: districtBId,
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    // Create Product Owner account
    poId = `usr_po_s_${crypto.randomUUID().slice(0, 8)}`;
    const pwPO = await hashPassword('POPassword2026!');
    await db.insert(accounts).values({
      id: poId,
      username: `po_s_${Date.now()}`,
      passwordHash: pwPO,
      role: 'PRODUCT_OWNER',
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    // Log in Hokim A
    const loginResA = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: eq(accounts.id, hokimAId) }))!.username,
        password: 'HokimPassword2026!',
      },
    });
    const cookieA = loginResA.cookies.find((c) => c.name === COOKIE_NAME);
    hokimACookie = `${cookieA!.name}=${cookieA!.value}`;

    // Log in Hokim B
    const loginResB = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: eq(accounts.id, hokimBId) }))!.username,
        password: 'HokimPassword2026!',
      },
    });
    const cookieB = loginResB.cookies.find((c) => c.name === COOKIE_NAME);
    hokimBCookie = `${cookieB!.name}=${cookieB!.value}`;

    // Log in PO
    const loginResPO = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: eq(accounts.id, poId) }))!.username,
        password: 'POPassword2026!',
      },
    });
    const cookiePO = loginResPO.cookies.find((c) => c.name === COOKIE_NAME);
    poCookie = `${cookiePO!.name}=${cookiePO!.value}`;

    // Helper to create test topic with projection and evidence
    const createTestTopicWithEvidence = async (opts: {
      id: string;
      districtId: string;
      mahallaName: string;
      calendarDay: string;
      primaryLane: 'WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE' | 'HOKIM_RELATED';
      lanes: Array<'WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE' | 'HOKIM_RELATED'>;
      summary: string;
      evidenceText: string;
      userMetadata?: {
        telegramUserId?: string;
        username?: string;
        firstName?: string;
        lastName?: string;
      };
    }) => {
      createdTopicIds.push(opts.id);
      const recId = `tir_s_${crypto.randomUUID().slice(0, 8)}`;
      const eviId = `evi_s_${crypto.randomUUID().slice(0, 8)}`;
      const prjId = `prj_s_${crypto.randomUUID().slice(0, 8)}`;
      createdRecordIds.push(recId);

      const recordTime = new Date();

      await db.insert(telegramIntakeRecords).values({
        id: recId,
        districtId: opts.districtId,
        mahallaName: opts.mahallaName,
        telegramBotId: 'bot_test',
        telegramChatId: `-100200${Date.now()}`,
        telegramMessageId: `${Math.floor(Math.random() * 900000)}`,
        calendarDay: opts.calendarDay,
        rawPayload: { text: opts.evidenceText },
        originalTimestamp: recordTime,
        createdAt: recordTime,
      });

      await db.insert(topics).values({
        id: opts.id,
        districtId: opts.districtId,
        mahallaName: opts.mahallaName,
        calendarDay: opts.calendarDay,
        primaryLane: opts.primaryLane,
        status: 'ACTIVE',
        latestRelevantEvidenceTimestamp: recordTime,
        retentionExpiresAt: new Date(Date.now() + 90 * 86400 * 1000),
        requiredDerivedGeneration: 1,
        appliedDerivedGeneration: 1,
        createdAt: recordTime,
        updatedAt: recordTime,
      });

      await db.insert(acceptedEvidence).values({
        id: eviId,
        topicId: opts.id,
        districtId: opts.districtId,
        mahallaName: opts.mahallaName,
        calendarDay: opts.calendarDay,
        intakeRecordId: recId,
        telegramChatId: `-100200${Date.now()}`,
        telegramMessageId: `${Math.floor(Math.random() * 900000)}`,
        originalTimestamp: recordTime,
        verbatimText: opts.evidenceText,
        contentType: 'TEXT',
        userMetadata: opts.userMetadata || null,
        createdAt: recordTime,
      });

      await db.insert(topicProjections).values({
        id: prjId,
        topicId: opts.id,
        districtId: opts.districtId,
        mahallaName: opts.mahallaName,
        calendarDay: opts.calendarDay,
        summary: opts.summary,
        lanes: opts.lanes,
        primaryLane: opts.primaryLane,
        anchorEvidenceId: eviId,
        anchorQuote: opts.evidenceText.slice(0, 50),
        latestMeaningfulActivityTimestamp: recordTime,
        attribution: 'Mahalla bot',
        isHokimRelated: opts.primaryLane === 'HOKIM_RELATED' || opts.lanes.includes('HOKIM_RELATED'),
        generation: 1,
        aiProfileId: 'prof_proj_2026_08_v1',
        createdAt: recordTime,
        updatedAt: recordTime,
      });
    };

    // Seed test topics in District A:
    // Topic 1: Matches in SUMMARY ("Сув қувури ёрилган")
    await createTestTopicWithEvidence({
      id: `top_s1_${crypto.randomUUID().slice(0, 8)}`,
      districtId: districtAId,
      mahallaName: 'Наврўз',
      calendarDay: todayCalendarDay,
      primaryLane: 'WATER',
      lanes: ['WATER'],
      summary: 'Сув қувури ёрилган ва йўлни сув босган',
      evidenceText: 'Кўчада катта авария бўлди, илтимос ёрдам беринглар',
      userMetadata: { username: 'citizen_ali', firstName: 'Ali', lastName: 'Valiyev' },
    });

    // Topic 2: Matches in EVIDENCE ONLY ("трансформатор тутуб кетди")
    await createTestTopicWithEvidence({
      id: `top_s2_${crypto.randomUUID().slice(0, 8)}`,
      districtId: districtAId,
      mahallaName: 'Наврўз',
      calendarDay: todayCalendarDay,
      primaryLane: 'ELECTRICITY',
      lanes: ['ELECTRICITY'],
      summary: 'Электр таъминотида узилишлар кузатилмоқда',
      evidenceText: 'Маҳалламиздаги трансформатор тутуб кетди, ёнғин чиқиши мумкин',
      userMetadata: { username: 'resident_bek', firstName: 'Bekzod', lastName: 'Karimov' },
    });

    // Topic 3: Matches in USER METADATA ONLY (username @toshmatov, firstName 'Dilshod')
    await createTestTopicWithEvidence({
      id: `top_s3_${crypto.randomUUID().slice(0, 8)}`,
      districtId: districtAId,
      mahallaName: 'Наврўз',
      calendarDay: todayCalendarDay,
      primaryLane: 'GAS',
      lanes: ['GAS'],
      summary: 'Газ босими кескин пасайган',
      evidenceText: 'Ошхонада плита ёнмаяпти, совуқ бўлиб кетди',
      userMetadata: { username: 'toshmatov', firstName: 'Dilshod', lastName: 'Toshmatov' },
    });

    // Topic 4: In District B (for isolation verification with identical summary)
    await createTestTopicWithEvidence({
      id: `top_sb1_${crypto.randomUUID().slice(0, 8)}`,
      districtId: districtBId,
      mahallaName: 'Бирлик',
      calendarDay: todayCalendarDay,
      primaryLane: 'WATER',
      lanes: ['WATER'],
      summary: 'Сув қувури ёрилган ва йўлни сув босган',
      evidenceText: 'Бошқа тумандаги сув муаммоси',
      userMetadata: { username: 'dist_b_user', firstName: 'Botir', lastName: 'Nazarov' },
    });

    // Topic 5: In District A with NO username (null username) to test null username safety
    await createTestTopicWithEvidence({
      id: `top_s5_${crypto.randomUUID().slice(0, 8)}`,
      districtId: districtAId,
      mahallaName: 'Наврўз',
      calendarDay: todayCalendarDay,
      primaryLane: 'WASTE',
      lanes: ['WASTE'],
      summary: 'Чиқиндихона тўлиб кетган ва тозаланмаган',
      evidenceText: 'Маҳалла кўчасида ахлат тўпланиб қолган',
      userMetadata: { firstName: 'NoUsernameCitizen' },
    });
  });

  afterAll(async () => {
    if (createdTopicIds.length > 0) {
      for (const tId of createdTopicIds) {
        await db.delete(topicProjections).where(eq(topicProjections.topicId, tId));
        await db.delete(acceptedEvidence).where(eq(acceptedEvidence.topicId, tId));
        await db.delete(topics).where(eq(topics.id, tId));
      }
    }
    if (createdRecordIds.length > 0) {
      for (const rId of createdRecordIds) {
        await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.id, rId));
      }
    }
    await server.close();
    await pool.end();
  });

  describe('Wildcard Escaping Unit Helper', () => {
    it('escapes %, _, and \\ characters safely', () => {
      expect(escapeLikePattern('100%')).toBe('100\\%');
      expect(escapeLikePattern('user_name')).toBe('user\\_name');
      expect(escapeLikePattern('path\\to')).toBe('path\\\\to');
      expect(escapeLikePattern('normal text')).toBe('normal text');
    });
  });

  describe('Lexical Matching & Contextual Match Badges (AC 1, AC 2)', () => {
    it('matches query in Topic Summary and returns searchMatchBadge = null', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: 'Сув қувури',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.lanes.WATER.topics.length).toBeGreaterThanOrEqual(1);
      const waterTopic = json.lanes.WATER.topics.find((t: { summary: string }) =>
        t.summary.includes('Сув қувури'),
      );
      expect(waterTopic).toBeDefined();
      expect(waterTopic.searchMatchBadge).toBeNull();
    });

    it('matches query in Accepted Evidence only and returns searchMatchBadge = "evidence"', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: 'трансформатор',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.lanes.ELECTRICITY.topics.length).toBeGreaterThanOrEqual(1);
      const elecTopic = json.lanes.ELECTRICITY.topics[0];
      expect(elecTopic.summary).toBe('Электр таъминотида узилишлар кузатилмоқда');
      expect(elecTopic.searchMatchBadge).toBe('evidence');
    });

    it('matches query in Telegram username and returns searchMatchBadge = "author"', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: '@toshmatov',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.lanes.GAS.topics.length).toBeGreaterThanOrEqual(1);
      const gasTopic = json.lanes.GAS.topics[0];
      expect(gasTopic.summary).toBe('Газ босими кескин пасайган');
      expect(gasTopic.searchMatchBadge).toBe('author');
    });

    it('matches query in Telegram first/last name and returns searchMatchBadge = "author"', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: 'Dilshod Toshmatov',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.lanes.GAS.topics.length).toBeGreaterThanOrEqual(1);
      const gasTopic = json.lanes.GAS.topics[0];
      expect(gasTopic.searchMatchBadge).toBe('author');
    });

    it('strictly excludes phone numbers and non-matching resident identifiers from search (AC 1)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: '+998901234567',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      for (const lane of Object.values(json.lanes) as Array<{ topics: unknown[] }>) {
        expect(lane.topics.length).toBe(0);
      }
    });

    it('does not match evidence records with NULL usernames when searching for "@" (AC 1, AC 2)', async () => {
      // 1. Searching for specific username with '@' matches only the topic with that username
      const resSpecific = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: '@toshmatov',
          dateScope: 'today',
        },
      });

      expect(resSpecific.statusCode).toBe(200);
      const jsonSpecific = JSON.parse(resSpecific.body);
      expect(jsonSpecific.lanes.GAS.topics.length).toBeGreaterThanOrEqual(1);
      expect(jsonSpecific.lanes.GAS.topics[0].searchMatchBadge).toBe('author');
      expect(jsonSpecific.lanes.WASTE.topics.length).toBe(0);

      // 2. Searching for '@' does NOT match Topic 5 (WASTE lane, which has NULL username)
      const resAt = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: '@',
          dateScope: 'today',
        },
      });

      expect(resAt.statusCode).toBe(200);
      const jsonAt = JSON.parse(resAt.body);
      // Topic 5 (WASTE) has no username, so it must not match '@'
      expect(jsonAt.lanes.WASTE.topics.length).toBe(0);

      // 3. Searching for a non-existent username with '@' returns 0 matches
      const resNonExistent = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: '@nonexistent_citizen_123',
          dateScope: 'today',
        },
      });

      expect(resNonExistent.statusCode).toBe(200);
      const jsonNonExistent = JSON.parse(resNonExistent.body);
      for (const lane of Object.values(jsonNonExistent.lanes) as Array<{ topics: unknown[] }>) {
        expect(lane.topics.length).toBe(0);
      }
    });
  });

  describe('Lane Batch Search POST Route (AC 4, AC 5)', () => {
    it('returns searched lane results with pagination metadata', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/lane/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          lane: 'WATER',
          search: 'Сув',
          dateScope: 'today',
          limit: 10,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.lane).toBe('WATER');
      expect(Array.isArray(json.topics)).toBe(true);
      expect(json.topics.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Statistics Search POST Route (AC 3, AC 5, AC 8)', () => {
    it('calculates totalUniqueTopics accurately for searched scope', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/statistics/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: 'трансформатор',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.totalUniqueTopics).toBe(1);
      expect(json.activeMahallasCount).toBe(1);
    });

    it('returns totalUniqueTopics = 0 for unmatched search query', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/statistics/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: 'бундаймавзумавжудэмас12345',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.totalUniqueTopics).toBe(0);
    });
  });

  describe('Tenant Boundary Isolation (AD-03)', () => {
    it('never returns District B topics when Hokim A searches', async () => {
      const resA = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: 'Сув қувури',
          dateScope: 'today',
        },
      });

      expect(resA.statusCode).toBe(200);
      const jsonA = JSON.parse(resA.body);
      const allTopicsA = Object.values(jsonA.lanes).flatMap((l: any) => l.topics);
      expect(allTopicsA.every((t: any) => t.districtId === districtAId)).toBe(true);
    });

    it('returns District B topics when Hokim B searches', async () => {
      const resB = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimBCookie,
        },
        payload: {
          search: 'Сув қувури',
          dateScope: 'today',
        },
      });

      expect(resB.statusCode).toBe(200);
      const jsonB = JSON.parse(resB.body);
      const allTopicsB = Object.values(jsonB.lanes).flatMap((l: any) => l.topics);
      expect(allTopicsB.every((t: any) => t.districtId === districtBId)).toBe(true);
    });
  });

  describe('Validation & Security (AC 5, AD-09, AD-10)', () => {
    it('rejects search queries exceeding 200 characters with 400 validation error', async () => {
      const tooLongSearch = 'a'.repeat(201);
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: hokimACookie,
        },
        payload: {
          search: tooLongSearch,
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          search: 'Сув',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects non-Hokim roles (e.g. PRODUCT_OWNER) with 403', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/hokim/topics/board/search',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
        payload: {
          search: 'Сув',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
