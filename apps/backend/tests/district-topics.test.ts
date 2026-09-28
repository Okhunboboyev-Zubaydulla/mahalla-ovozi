import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  DistrictTopicsPageResponse,
  TopicEvidenceResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, districtTelegramGroups, topics, topicProjections, acceptedEvidence, telegramIntakeRecords } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { getTashkentCalendarDay } from '../src/modules/telegram-intake/timezone-util.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 4.5: Browse Retained District Topics and Evidence Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let poCookie = '';
  let hokimCookie = '';
  let districtAId: string;
  let districtBId: string;

  let topicA1Id: string;
  let topicA2Id: string;
  let topicAExpiredId: string;
  let topicB1Id: string;

  const testCalendarDay = getTashkentCalendarDay(Math.floor(Date.now() / 1000));
  const yesterdayCalendarDay = getTashkentCalendarDay(Math.floor(Date.now() / 1000) - 86400);

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    await ensureDefaultAiProfiles(db);
    const profile = await db.query.aiProfiles.findFirst();
    const defaultAiProfileId = profile!.id;

    // 1. Seed Product Owner
    const poUsername = `po_troubleshoot_${Date.now()}`;
    const poPassword = 'SecurePOPassword2026!';
    await createOrResetProductOwner(db, {
      username: poUsername,
      password: poPassword,
    });

    const poSignIn = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
      payload: { username: poUsername, password: poPassword },
    });
    expect(poSignIn.statusCode).toBe(200);
    const poSetCookie = poSignIn.headers['set-cookie'];
    poCookie = Array.isArray(poSetCookie) ? poSetCookie[0] || '' : (poSetCookie as string) || '';

    // 2. Seed Districts
    const ts = Date.now();
    districtAId = `dist_trouble_a_${ts}`;
    districtBId = `dist_trouble_b_${ts}`;

    await db.insert(districts).values([
      {
        id: districtAId,
        name: `Юнусобод тумани ${ts}`,
        region: 'Тошкент шаҳри',
        status: 'ACTIVE',
      },
      {
        id: districtBId,
        name: `Мирзо Улуғбек тумани ${ts}`,
        region: 'Тошкент шаҳри',
        status: 'ACTIVE',
      },
    ]);

    // 3. Seed Hokim Account for District A (to test 403 Forbidden on PO routes)
    const hokimUsername = `hokim_trouble_${Date.now()}`;
    const hokimPassword = 'SecureHokimPassword2026!';
    const hokimHash = await hashPassword(hokimPassword);

    await db.insert(accounts).values({
      id: `acc_hokim_tr_${Date.now()}`,
      username: hokimUsername,
      passwordHash: hokimHash,
      role: 'DISTRICT_HOKIM',
      districtId: districtAId,
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    const hokimSignIn = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
      payload: { username: hokimUsername, password: hokimPassword },
    });
    expect(hokimSignIn.statusCode).toBe(200);
    const hokimSetCookie = hokimSignIn.headers['set-cookie'];
    hokimCookie = Array.isArray(hokimSetCookie)
      ? hokimSetCookie[0] || ''
      : (hokimSetCookie as string) || '';

    // 4. Seed Telegram Groups
    const publicChatId = `-100${Math.floor(100000000 + Math.random() * 900000000)}`;
    const privateChatId = `-100${Math.floor(100000000 + Math.random() * 900000000)}`;

    await db.insert(districtTelegramGroups).values([
      {
        id: `dtg_tr_1_${ts}`,
        districtId: districtAId,
        mahallaName: 'Аҳмад Дониш',
        telegramChatId: publicChatId,
        telegramChatTitle: 'Аҳмад Дониш Гуруҳи',
        telegramChatUsername: 'ahmad_donish_group',
        status: 'VALID',
      },
      {
        id: `dtg_tr_2_${ts}`,
        districtId: districtAId,
        mahallaName: 'Боғишамол',
        telegramChatId: privateChatId,
        telegramChatTitle: 'Боғишамол Гуруҳи',
        telegramChatUsername: null,
        status: 'VALID',
      },
    ]);

    // 5. Seed Intake & Evidence for Topic A1 (Water issue with author "Alisher")
    topicA1Id = `top_tr_a1_${ts}`;
    const intakeA1Id = `tir_tr_a1_${ts}`;
    const evidenceA1_1Id = `ae_tr_a1_1_${ts}`;
    const evidenceA1_2Id = `ae_tr_a1_2_${ts}`;

    const now = new Date();
    const ninetyDaysFuture = new Date(now.getTime() + 90 * 86400 * 1000);
    const pastRetention = new Date(now.getTime() - 10 * 86400 * 1000);

    await db.insert(telegramIntakeRecords).values({
      id: intakeA1Id,
      districtId: districtAId,
      mahallaName: 'Аҳмад Дониш',
      telegramBotId: `bot_tr_${ts}`,
      telegramMessageId: '101',
      telegramChatId: publicChatId,
      calendarDay: testCalendarDay,
      originalTimestamp: new Date(now.getTime() - 3600 * 1000),
      rawPayload: {},
    });

    await db.insert(topics).values({
      id: topicA1Id,
      districtId: districtAId,
      mahallaName: 'Аҳмад Дониш',
      calendarDay: testCalendarDay,
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date(now.getTime() - 1800 * 1000),
      retentionExpiresAt: ninetyDaysFuture,
    });

    await db.insert(acceptedEvidence).values([
      {
        id: evidenceA1_1Id,
        topicId: topicA1Id,
        intakeRecordId: intakeA1Id,
        districtId: districtAId,
        mahallaName: 'Аҳмад Дониш',
        calendarDay: testCalendarDay,
        verbatimText: 'Ичимлик суви таъминотида узилишлар кузатилмоқда, босим жуда паст.',
        contentType: 'TEXT',
        originalTimestamp: new Date(now.getTime() - 3600 * 1000),
        telegramChatId: publicChatId,
        telegramMessageId: '101',
        userMetadata: {
          username: 'alisher_resident',
          firstName: 'Алишер',
          lastName: 'Навоий',
        },
      },
      {
        id: evidenceA1_2Id,
        topicId: topicA1Id,
        intakeRecordId: intakeA1Id,
        districtId: districtAId,
        mahallaName: 'Аҳмад Дониш',
        calendarDay: testCalendarDay,
        verbatimText: 'Сув насоси таъмирланмоқдами? Жавоб беринг.',
        contentType: 'TEXT',
        originalTimestamp: new Date(now.getTime() - 1800 * 1000),
        telegramChatId: publicChatId,
        telegramMessageId: '102',
        userMetadata: {
          username: 'nodir_77',
          firstName: 'Нодир',
        },
      },
    ]);

    await db.insert(topicProjections).values({
      id: `tp_tr_a1_${ts}`,
      topicId: topicA1Id,
      districtId: districtAId,
      mahallaName: 'Аҳмад Дониш',
      calendarDay: testCalendarDay,
      summary: 'Аҳмад Дониш маҳалласида тоза ичимлик суви босими пастлиги бўйича мурожаатлар',
      lanes: ['WATER'],
      primaryLane: 'WATER',
      isHokimRelated: false,
      anchorQuote: 'Ичимлик суви таъминотида узилишлар кузатилмоқда',
      anchorEvidenceId: evidenceA1_1Id,
      latestMeaningfulActivityTimestamp: new Date(now.getTime() - 1800 * 1000),
      attribution: '2 та далил асосида',
      generation: 1,
      aiProfileId: defaultAiProfileId,
    });

    // 6. Seed Topic A2 (Electricity issue, yesterday)
    topicA2Id = `top_tr_a2_${ts}`;
    const intakeA2Id = `tir_tr_a2_${ts}`;
    const evidenceA2Id = `ae_tr_a2_${ts}`;

    await db.insert(telegramIntakeRecords).values({
      id: intakeA2Id,
      districtId: districtAId,
      mahallaName: 'Боғишамол',
      telegramBotId: `bot_tr_${ts}`,
      telegramMessageId: '201',
      telegramChatId: privateChatId,
      calendarDay: yesterdayCalendarDay,
      originalTimestamp: new Date(now.getTime() - 86400 * 1000),
      rawPayload: {},
    });

    await db.insert(topics).values({
      id: topicA2Id,
      districtId: districtAId,
      mahallaName: 'Боғишамол',
      calendarDay: yesterdayCalendarDay,
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date(now.getTime() - 86400 * 1000),
      retentionExpiresAt: ninetyDaysFuture,
    });

    await db.insert(acceptedEvidence).values({
      id: evidenceA2Id,
      topicId: topicA2Id,
      intakeRecordId: intakeA2Id,
      districtId: districtAId,
      mahallaName: 'Боғишамол',
      calendarDay: yesterdayCalendarDay,
      verbatimText: 'Трансформаторда кучли ёнғин чиқди, чироқ ўчди 100% авария ҳолати.',
      contentType: 'TEXT',
      originalTimestamp: new Date(now.getTime() - 86400 * 1000),
      telegramChatId: privateChatId,
      telegramMessageId: '201',
      userMetadata: {
        username: null,
        firstName: 'Зафар',
        lastName: 'Умаров',
      },
    });

    await db.insert(topicProjections).values({
      id: `tp_tr_a2_${ts}`,
      topicId: topicA2Id,
      districtId: districtAId,
      mahallaName: 'Боғишамол',
      calendarDay: yesterdayCalendarDay,
      summary: 'Боғишамол маҳалласида электр энергияси узилиши ва трансформатор муаммоси',
      lanes: ['ELECTRICITY', 'HOKIM_RELATED'],
      primaryLane: 'ELECTRICITY',
      isHokimRelated: true,
      anchorQuote: 'Трансформаторда кучли ёнғин чиқди',
      anchorEvidenceId: evidenceA2Id,
      latestMeaningfulActivityTimestamp: new Date(now.getTime() - 86400 * 1000),
      attribution: '1 та далил асосида',
      generation: 1,
      aiProfileId: defaultAiProfileId,
    });

    // 7. Seed Expired Topic in District A
    topicAExpiredId = `top_tr_exp_${ts}`;
    const evidenceExpId = `ae_tr_exp_${ts}`;
    const intakeExpId = `tir_tr_exp_${ts}`;

    await db.insert(telegramIntakeRecords).values({
      id: intakeExpId,
      districtId: districtAId,
      mahallaName: 'Аҳмад Дониш',
      telegramBotId: `bot_tr_${ts}`,
      telegramMessageId: '401',
      telegramChatId: publicChatId,
      calendarDay: testCalendarDay,
      originalTimestamp: pastRetention,
      rawPayload: {},
    });

    await db.insert(topics).values({
      id: topicAExpiredId,
      districtId: districtAId,
      mahallaName: 'Аҳмад Дониш',
      calendarDay: testCalendarDay,
      primaryLane: 'GAS',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: pastRetention,
      retentionExpiresAt: pastRetention, // Expired!
    });

    await db.insert(acceptedEvidence).values({
      id: evidenceExpId,
      topicId: topicAExpiredId,
      intakeRecordId: intakeExpId,
      districtId: districtAId,
      mahallaName: 'Аҳмад Дониш',
      calendarDay: testCalendarDay,
      verbatimText: 'Газ босими жуда паст.',
      contentType: 'TEXT',
      originalTimestamp: pastRetention,
      telegramChatId: publicChatId,
      telegramMessageId: '401',
      userMetadata: { username: 'exp_user' },
    });

    await db.insert(topicProjections).values({
      id: `tp_tr_exp_${ts}`,
      topicId: topicAExpiredId,
      districtId: districtAId,
      mahallaName: 'Аҳмад Дониш',
      calendarDay: testCalendarDay,
      summary: 'Эски муддати ўтган газ босими мавзуси',
      lanes: ['GAS'],
      primaryLane: 'GAS',
      isHokimRelated: false,
      anchorQuote: 'Газ босими паст',
      anchorEvidenceId: evidenceExpId,
      latestMeaningfulActivityTimestamp: pastRetention,
      attribution: '1 та далил асосида',
      generation: 1,
      aiProfileId: defaultAiProfileId,
    });

    // 8. Seed Topic in District B (for Cross-District Isolation tests)
    topicB1Id = `top_tr_b1_${ts}`;
    const intakeB1Id = `tir_tr_b1_${ts}`;
    const evidenceB1Id = `ae_tr_b1_${ts}`;

    await db.insert(telegramIntakeRecords).values({
      id: intakeB1Id,
      districtId: districtBId,
      mahallaName: 'Олтинтепа',
      telegramBotId: `bot_tr_${ts}`,
      telegramMessageId: '301',
      telegramChatId: '-100987654321',
      calendarDay: testCalendarDay,
      originalTimestamp: now,
      rawPayload: {},
    });

    await db.insert(topics).values({
      id: topicB1Id,
      districtId: districtBId,
      mahallaName: 'Олтинтепа',
      calendarDay: testCalendarDay,
      primaryLane: 'WASTE',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: ninetyDaysFuture,
    });

    await db.insert(acceptedEvidence).values({
      id: evidenceB1Id,
      topicId: topicB1Id,
      intakeRecordId: intakeB1Id,
      districtId: districtBId,
      mahallaName: 'Олтинтепа',
      calendarDay: testCalendarDay,
      verbatimText: 'Мирзо Улуғбекда чиқиндилар 3 кундан бери олиб кетилмаган.',
      contentType: 'TEXT',
      originalTimestamp: now,
      telegramChatId: '-100987654321',
      telegramMessageId: '301',
      userMetadata: {
        username: 'secret_user_b',
        firstName: 'Бобур',
      },
    });

    await db.insert(topicProjections).values({
      id: `tp_tr_b1_${ts}`,
      topicId: topicB1Id,
      districtId: districtBId,
      mahallaName: 'Олтинтепа',
      calendarDay: testCalendarDay,
      summary: 'Олтинтепа маҳалласида чиқиндиларни ташиш кечикмоқда',
      lanes: ['WASTE'],
      primaryLane: 'WASTE',
      isHokimRelated: false,
      anchorQuote: 'Чиқиндилар олиб кетилмаган',
      anchorEvidenceId: evidenceB1Id,
      latestMeaningfulActivityTimestamp: now,
      attribution: '1 та далил асосида',
      generation: 1,
      aiProfileId: defaultAiProfileId,
    });
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  // ── AC 1: Authentication & Server-Side District Scoping ──
  describe('1. Authentication & Explicit District Scoping (AC 1)', () => {
    it('allows Product Owner to query topics with explicit districtId', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics?dateScope=today`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.districtId).toBe(districtAId);
      expect(Array.isArray(data.topics)).toBe(true);
      expect(data.topics.some((t) => t.id === topicA1Id)).toBe(true);
    });

    it('rejects unauthenticated request with HTTP 401', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics`,
        headers: { ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(401);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects Hokim role with HTTP 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics`,
        headers: { cookie: hokimCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('rejects unknown districtId with HTTP 404 DISTRICT_NOT_FOUND', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/districts/non_existent_district_9999/topics',
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('DISTRICT_NOT_FOUND');
    });
  });

  // ── AC 2: Cross-District Isolation & Read-Only Canonical Topics ──
  describe('2. Cross-District Boundary Isolation & Canonical Topics (AC 1, AC 2)', () => {
    it('never returns District B topics when querying District A', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics?dateScope=today`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.every((t) => t.districtId === districtAId)).toBe(true);
      expect(data.topics.some((t) => t.id === topicB1Id)).toBe(false);
    });

    it('returns Mahallas list strictly scoped to District A', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics/mahallas`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(Array.isArray(json.mahallas)).toBe(true);
      expect(json.mahallas).toContain('Аҳмад Дониш');
      expect(json.mahallas).not.toContain('Олтинтепа'); // Belongs to District B
    });
  });

  // ── AC 3: Lexical Plain-Text Search with Deterministic Badge Precedence ──
  describe('3. Lexical Plain-Text Search & Badge Derivation (AC 3)', () => {
    it('derives author badge when matching Telegram username or display name', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtAId}/topics/search`,
        headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          search: 'alisher',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.length).toBeGreaterThan(0);
      const matched = data.topics.find((t) => t.id === topicA1Id);
      expect(matched).toBeDefined();
      expect(matched?.searchMatchBadge).toBe('author');
    });

    it('derives evidence badge when matching verbatim text (and not author)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtAId}/topics/search`,
        headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          search: 'насоси',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.length).toBeGreaterThan(0);
      const matched = data.topics.find((t) => t.id === topicA1Id);
      expect(matched).toBeDefined();
      expect(matched?.searchMatchBadge).toBe('evidence');
    });

    it('derives null badge when matching summary only', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtAId}/topics/search`,
        headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          search: 'мурожаатлар',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.length).toBeGreaterThan(0);
      const matched = data.topics.find((t) => t.id === topicA1Id);
      expect(matched).toBeDefined();
      expect(matched?.searchMatchBadge).toBeNull();
    });

    it('safely escapes SQL wildcard characters (%, _, \\)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtAId}/topics/search`,
        headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          search: '100%',
          dateScope: 'yesterday',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.some((t) => t.id === topicA2Id)).toBe(true);
    });

    it('never crosses District boundary when searching', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtAId}/topics/search`,
        headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          search: 'secret_user_b',
          dateScope: 'today',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.length).toBe(0);
    });
  });

  // ── AC 4: Multi-Parameter Operational Filtering ──
  describe('4. Multi-Parameter Operational Filtering (AC 4)', () => {
    it('filters by dateScope=yesterday', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics?dateScope=yesterday`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.some((t) => t.id === topicA2Id)).toBe(true);
      expect(data.topics.some((t) => t.id === topicA1Id)).toBe(false);
    });

    it('filters by mahallaName', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics?dateScope=today&mahallaName=Аҳмад Дониш`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.every((t) => t.mahallaName === 'Аҳмад Дониш')).toBe(true);
    });

    it('filters by qualifying service lanes', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics?dateScope=yesterday&lanes=ELECTRICITY`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.some((t) => t.id === topicA2Id)).toBe(true);
    });
  });

  // ── AC 5: Verbatim Evidence Inspection & Privacy Boundary ──
  describe('5. Verbatim Evidence Inspection & Privacy Boundary (AC 5)', () => {
    it('returns complete evidence trail in chronological order with sanitized attribution', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics/${topicA1Id}/evidence`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as TopicEvidenceResponse;
      expect(data.topic.id).toBe(topicA1Id);
      expect(data.evidence.length).toBe(2);

      // Verify chronological ordering (oldest first: 101 then 102)
      expect(data.evidence[0]!.id).toContain('a1_1');
      expect(data.evidence[1]!.id).toContain('a1_2');

      // Verify sanitized attribution
      expect(data.evidence[0]!.authorUsername).toBe('@alisher_resident');
      expect(data.evidence[0]!.authorName).toBe('Алишер Навоий');

      // Verify zero phone numbers or raw internal user IDs
      for (const item of data.evidence) {
        expect((item as Record<string, unknown>).phoneNumber).toBeUndefined();
        expect((item as Record<string, unknown>).telegramUserId).toBeUndefined();
      }

      // Verify Telegram deep link on public group
      expect(data.evidence[0]!.telegramDeepLink).toBe('https://t.me/ahmad_donish_group/101');
    });

    it('rejects accessing Topic B evidence with District A scope', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics/${topicB1Id}/evidence`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── AC 6: Retention Expiry & Authoritative Deletion Guardrails ──
  describe('6. Retention Expiry Guardrails (AC 6)', () => {
    it('never returns expired topics in topic queries', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics?dateScope=today`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.some((t) => t.id === topicAExpiredId)).toBe(false);
    });

    it('returns HTTP 404 when requesting evidence for expired topic', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics/${topicAExpiredId}/evidence`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── AC 2, AC 10: Keyset Cursor Pagination & Validation ──
  describe('7. Keyset Cursor Pagination (AC 2, AC 10)', () => {
    it('supports limit and generates nextCursor', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics?dateScope=custom&dateFrom=${yesterdayCalendarDay}&dateTo=${testCalendarDay}&limit=1`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DistrictTopicsPageResponse;
      expect(data.topics.length).toBe(1);
      expect(data.hasNextPage).toBe(true);
      expect(typeof data.nextCursor).toBe('string');

      // Fetch next page using cursor
      const nextRes = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics?dateScope=custom&dateFrom=${yesterdayCalendarDay}&dateTo=${testCalendarDay}&limit=1&cursor=${data.nextCursor}`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(nextRes.statusCode).toBe(200);
      const nextData = JSON.parse(nextRes.payload) as DistrictTopicsPageResponse;
      expect(nextData.topics.length).toBe(1);
      expect(nextData.topics[0]!.id).not.toBe(data.topics[0]!.id);
    });

    it('rejects malformed cursor with HTTP 400 INVALID_CURSOR', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/topics?cursor=invalid_base64_json`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('INVALID_CURSOR');
    });
  });
});
