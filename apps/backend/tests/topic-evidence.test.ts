import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, districtTelegramGroups, topics, topicProjections, acceptedEvidence, telegramIntakeRecords } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { getTashkentCalendarDay } from '../src/modules/telegram-intake/timezone-util.js';
import { TopicEvidenceResponse } from '@mahalla-ovozi/api-contracts';
import { getTopicEvidence } from '../src/modules/topics/topic-evidence-service.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 3.2: Inspect Complete Topic Evidence Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let districtAId: string;
  let districtBId: string;
  let hokimACookie: string;
  let poCookie: string;

  let topicA1Id: string;
  let topicB1Id: string;
  let anchorEvidenceId: string;
  let defaultAiProfileId: string;

  let publicChatId: string;
  let privateChatId: string;
  let legacyChatId: string;

  const testCalendarDay = getTashkentCalendarDay(Math.floor(Date.now() / 1000));

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    await ensureDefaultAiProfiles(db);
    const profile = await db.query.aiProfiles.findFirst();
    defaultAiProfileId = profile!.id;

    // 1. Create Districts
    districtAId = `dist_evi_a_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtAId,
      name: `Яккасарой тумани ${districtAId}`,
      region: 'Тошкент шаҳри',
      status: 'ACTIVE',
    });

    districtBId = `dist_evi_b_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtBId,
      name: `Чилонзор тумани ${districtBId}`,
      region: 'Тошкент шаҳри',
      status: 'ACTIVE',
    });

    publicChatId = `-100${Math.floor(100000000 + Math.random() * 900000000)}`;
    privateChatId = `-100${Math.floor(100000000 + Math.random() * 900000000)}`;
    legacyChatId = `-${Math.floor(100000000 + Math.random() * 900000000)}`;

    // 2. Create Telegram Groups for District A
    await db.insert(districtTelegramGroups).values([
      {
        id: `dtg_public_${crypto.randomUUID().slice(0, 8)}`,
        districtId: districtAId,
        mahallaName: 'Бобур',
        telegramChatId: publicChatId,
        telegramChatTitle: 'Бобур Маҳалласи Гуруҳи',
        telegramChatUsername: 'bobur_mahalla_public',
        status: 'VALID',
      },
      {
        id: `dtg_private_${crypto.randomUUID().slice(0, 8)}`,
        districtId: districtAId,
        mahallaName: 'Юнус Ражабий',
        telegramChatId: privateChatId,
        telegramChatTitle: 'Юнус Ражабий Ёпиқ Гуруҳи',
        telegramChatUsername: null,
        status: 'VALID',
      },
      {
        id: `dtg_legacy_${crypto.randomUUID().slice(0, 8)}`,
        districtId: districtAId,
        mahallaName: 'Муқимий',
        telegramChatId: legacyChatId,
        telegramChatTitle: 'Муқимий Эски Гуруҳи',
        telegramChatUsername: null,
        status: 'VALID',
      },
    ]);

    // 3. Create Accounts
    const hokimAId = `acc_h_a_${crypto.randomUUID().slice(0, 8)}`;
    const passHashA = await hashPassword('HokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimAId,
      username: `hokim_evi_a_${Date.now()}`,
      passwordHash: passHashA,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: districtAId,
      mustChangePassword: false,
    });

    const hokimBId = `acc_h_b_${crypto.randomUUID().slice(0, 8)}`;
    const passHashB = await hashPassword('HokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimBId,
      username: `hokim_evi_b_${Date.now()}`,
      passwordHash: passHashB,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: districtBId,
      mustChangePassword: false,
    });

    const poId = `acc_po_${crypto.randomUUID().slice(0, 8)}`;
    const passHashPO = await hashPassword('POPassword2026!');
    await db.insert(accounts).values({
      id: poId,
      username: `po_evi_${Date.now()}`,
      passwordHash: passHashPO,
      role: 'PRODUCT_OWNER',
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    // 4. Authenticate Sessions
    const loginResA = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: (a, { eq }) => eq(a.id, hokimAId) }))!.username,
        password: 'HokimPassword2026!',
      },
    });
    hokimACookie = loginResA.headers['set-cookie'] as string;

    const loginResPO = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: (a, { eq }) => eq(a.id, poId) }))!.username,
        password: 'POPassword2026!',
      },
    });
    poCookie = loginResPO.headers['set-cookie'] as string;

    // 5. Seed Topics and Evidence for District A
    topicA1Id = `top_a1_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(topics).values({
      id: topicA1Id,
      districtId: districtAId,
      mahallaName: 'Бобур',
      calendarDay: testCalendarDay,
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date('2026-08-23T10:00:00Z'),
      retentionExpiresAt: new Date(Date.now() + 30 * 86400000),
    });

    const intakeRecordId = `intake_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeRecordId,
      districtId: districtAId,
      mahallaName: 'Бобур',
      telegramBotId: 'bot_test_123',
      telegramChatId: publicChatId,
      telegramMessageId: '1000',
      originalTimestamp: new Date(),
      calendarDay: testCalendarDay,
      rawPayload: { text: 'test' },
      createdAt: new Date(),
    });

    anchorEvidenceId = `evi_a1_anchor_${crypto.randomUUID().slice(0, 8)}`;

    // Insert 5 chronologically sequenced evidence items for Topic A1
    await db.insert(acceptedEvidence).values([
      // Item 1: Oldest - Public Group (t.me/bobur_mahalla_public/101)
      {
        id: `evi_a1_01_${crypto.randomUUID().slice(0, 8)}`,
        topicId: topicA1Id,
        districtId: districtAId,
        mahallaName: 'Бобур',
        calendarDay: testCalendarDay,
        intakeRecordId,
        telegramChatId: publicChatId,
        telegramMessageId: '101',
        telegramUserId: '99887711', // Private user ID (MUST be filtered out)
        originalTimestamp: new Date('2026-08-23T06:00:00Z'),
        verbatimText: '1-хабар:\nИчимлик суви босими пастлаб кетди.\nИлтимос тезроқ тузатинглар.',
        contentType: 'TEXT',
        userMetadata: {
          telegramUserId: '99887711',
          username: 'anvar_uz',
          firstName: 'Anvar',
          lastName: 'Qodirov',
          phone: '+998901234567', // Phone number (MUST be filtered out)
        },
      },
      // Item 2: Anchor evidence - Private Supergroup (t.me/c/chatId/102)
      {
        id: anchorEvidenceId,
        topicId: topicA1Id,
        districtId: districtAId,
        mahallaName: 'Бобур',
        calendarDay: testCalendarDay,
        intakeRecordId,
        telegramChatId: privateChatId,
        telegramMessageId: '102',
        telegramUserId: '99887722',
        originalTimestamp: new Date('2026-08-23T07:15:00Z'),
        verbatimText: '2-хабар (Асосий):\nБобур маҳалласида сув қувури ёрилиб, кўчани сув босмоқда!',
        contentType: 'TEXT',
        userMetadata: {
          telegramUserId: '99887722',
          username: null,
          firstName: 'Dilshod',
          lastName: 'Rahimov',
        },
      },
      // Item 3: Legacy group (null Telegram link)
      {
        id: `evi_a1_03_${crypto.randomUUID().slice(0, 8)}`,
        topicId: topicA1Id,
        districtId: districtAId,
        mahallaName: 'Бобур',
        calendarDay: testCalendarDay,
        intakeRecordId,
        telegramChatId: legacyChatId,
        telegramMessageId: '103',
        originalTimestamp: new Date('2026-08-23T08:30:00Z'),
        verbatimText: '3-хабар:\nАвария хизмати келдими? Ҳали ҳам сув оқяпти.',
        contentType: 'TEXT',
        userMetadata: {
          firstName: 'Нодир',
        },
      },
      // Item 4: Media caption
      {
        id: `evi_a1_04_${crypto.randomUUID().slice(0, 8)}`,
        topicId: topicA1Id,
        districtId: districtAId,
        mahallaName: 'Бобур',
        calendarDay: testCalendarDay,
        intakeRecordId,
        telegramChatId: publicChatId,
        telegramMessageId: '104',
        originalTimestamp: new Date('2026-08-23T09:00:00Z'),
        verbatimText: '4-хабар: Воқеа жойидан расм.',
        contentType: 'MEDIA_CAPTION',
        userMetadata: null,
      },
      // Item 5: Newest
      {
        id: `evi_a1_05_${crypto.randomUUID().slice(0, 8)}`,
        topicId: topicA1Id,
        districtId: districtAId,
        mahallaName: 'Бобур',
        calendarDay: testCalendarDay,
        intakeRecordId,
        telegramChatId: publicChatId,
        telegramMessageId: '105',
        originalTimestamp: new Date('2026-08-23T10:00:00Z'),
        verbatimText: '5-хабар:\nСув таъминоти тўхтатилди, таъмирлаш ишлари бошланди.',
        contentType: 'TEXT',
        userMetadata: {
          username: '@sarvar_reporter',
        },
      },
    ]);

    // Insert Projection for Topic A1
    await db.insert(topicProjections).values({
      id: `prj_a1_${crypto.randomUUID().slice(0, 8)}`,
      topicId: topicA1Id,
      districtId: districtAId,
      mahallaName: 'Бобур',
      calendarDay: testCalendarDay,
      summary: 'Бобур маҳалласида ичимлик суви қувури ёрилиши ва таъмирлаш ишлари.',
      lanes: ['WATER'],
      primaryLane: 'WATER',
      anchorEvidenceId,
      anchorQuote: 'Бобур маҳалласида сув қувури ёрилиб, кўчани сув босмоқда!',
      latestMeaningfulActivityTimestamp: new Date('2026-08-23T10:00:00Z'),
      attribution: 'Бобур маҳалласи аҳолиси',
      isHokimRelated: false,
      generation: 1,
      aiProfileId: defaultAiProfileId,
    });

    // 6. Seed Topic for District B (Tenant Isolation verification)
    topicB1Id = `top_b1_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(topics).values({
      id: topicB1Id,
      districtId: districtBId,
      mahallaName: 'Чилонзор-9',
      calendarDay: testCalendarDay,
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date(),
      retentionExpiresAt: new Date(Date.now() + 30 * 86400000),
    });
  });

  afterAll(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('enforces fixed-district tenant isolation and denies cross-district topic access (AC 1)', async () => {
    // Hokim A requests evidence for Topic B1 (belonging to District B) -> Expect HTTP 404
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicB1Id}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('топилмади');

    // Hokim A requests non-existent topic -> Expect HTTP 404
    const nonExistentRes = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/top_non_existent/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });
    expect(nonExistentRes.statusCode).toBe(404);

    // Non-hokim (Product Owner) cannot query hokim evidence endpoint -> Expect HTTP 403
    const poRes = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(poRes.statusCode).toBe(403);
  });

  it('retrieves complete chronological evidence with line fidelity and Tashkent time (AC 2, 4)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body: TopicEvidenceResponse = JSON.parse(res.body);

    expect(body.topic.id).toBe(topicA1Id);
    expect(body.topic.districtId).toBe(districtAId);
    expect(body.totalCount).toBe(5);
    expect(body.evidence.length).toBe(5);
    expect(body.hasNextPage).toBe(false);
    expect(body.nextCursor).toBeNull();

    // Verify chronological oldest-to-newest ordering
    expect(body.evidence[0]!.telegramDeepLink).toBe('https://t.me/bobur_mahalla_public/101');
    expect(body.evidence[0]!.verbatimText).toContain('1-хабар:\nИчимлик суви босими пастлаб кетди.');
    expect(body.evidence[0]!.formattedTime).toMatch(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
    // UTC 06:00 is Tashkent 11:00 (+5)
    expect(body.evidence[0]!.formattedTime).toContain('11:00');

    expect(body.evidence[4]!.verbatimText).toContain('5-хабар:\nСув таъминоти тўхтатилди');
    // UTC 10:00 is Tashkent 15:00 (+5)
    expect(body.evidence[4]!.formattedTime).toContain('15:00');
  });

  it('correctly identifies anchor evidence and anchor quote (AC 9)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body: TopicEvidenceResponse = JSON.parse(res.body);

    expect(body.anchorEvidenceId).toBe(anchorEvidenceId);
    expect(body.anchorQuote).toContain('Бобур маҳалласида сув қувури ёрилиб');

    const anchorItem = body.evidence.find((e) => e.id === anchorEvidenceId);
    expect(anchorItem).toBeDefined();
    expect(anchorItem?.isAnchor).toBe(true);

    const nonAnchorItems = body.evidence.filter((e) => e.id !== anchorEvidenceId);
    expect(nonAnchorItems.every((e) => e.isAnchor === false)).toBe(true);
  });

  it('implements keyset pagination with cursor continuation (AC 3)', async () => {
    // Request Batch 1 (limit = 2)
    const batch1Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence?limit=2`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(batch1Res.statusCode).toBe(200);
    const batch1: TopicEvidenceResponse = JSON.parse(batch1Res.body);
    expect(batch1.evidence.length).toBe(2);
    expect(batch1.totalCount).toBe(5);
    expect(batch1.hasNextPage).toBe(true);
    expect(batch1.nextCursor).toBeTruthy();

    const cursor1 = batch1.nextCursor!;

    // Request Batch 2 (limit = 2, using cursor1)
    const batch2Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence?limit=2&cursor=${cursor1}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(batch2Res.statusCode).toBe(200);
    const batch2: TopicEvidenceResponse = JSON.parse(batch2Res.body);
    expect(batch2.evidence.length).toBe(2);
    expect(batch2.totalCount).toBe(5);
    expect(batch2.hasNextPage).toBe(true);
    expect(batch2.nextCursor).toBeTruthy();

    // Verify disjoint items between batch 1 and 2
    const batch1Ids = new Set(batch1.evidence.map((e) => e.id));
    for (const item of batch2.evidence) {
      expect(batch1Ids.has(item.id)).toBe(false);
    }

    const cursor2 = batch2.nextCursor!;

    // Request Batch 3 (final batch, limit = 2, using cursor2)
    const batch3Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence?limit=2&cursor=${cursor2}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(batch3Res.statusCode).toBe(200);
    const batch3: TopicEvidenceResponse = JSON.parse(batch3Res.body);
    expect(batch3.evidence.length).toBe(1);
    expect(batch3.totalCount).toBe(5);
    expect(batch3.hasNextPage).toBe(false);
    expect(batch3.nextCursor).toBeNull();
  });

  it('supports reverse ordering (order=DESC) with descending keyset pagination', async () => {
    // Request Batch 1 in DESC order (limit = 2)
    const batch1Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence?limit=2&order=DESC`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(batch1Res.statusCode).toBe(200);
    const batch1: TopicEvidenceResponse = JSON.parse(batch1Res.body);
    expect(batch1.evidence.length).toBe(2);
    expect(batch1.totalCount).toBe(5);
    expect(batch1.hasNextPage).toBe(true);
    expect(batch1.nextCursor).toBeTruthy();

    // First item in DESC must be the latest message (5-хабар)
    expect(batch1.evidence[0]!.verbatimText).toContain('5-хабар:\nСув таъминоти тўхтатилди');
    expect(batch1.evidence[1]!.verbatimText).toContain('4-хабар: Воқеа жойидан расм.');

    const cursor1 = batch1.nextCursor!;

    // Request Batch 2 with cursor in DESC order
    const batch2Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence?limit=2&cursor=${cursor1}&order=DESC`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(batch2Res.statusCode).toBe(200);
    const batch2: TopicEvidenceResponse = JSON.parse(batch2Res.body);
    expect(batch2.evidence.length).toBe(2);
    expect(batch2.evidence[0]!.verbatimText).toContain('3-хабар:\nАвария хизмати келдими?');
    expect(batch2.evidence[1]!.verbatimText).toContain('2-хабар (Асосий)');
    expect(batch2.hasNextPage).toBe(true);
    expect(batch2.nextCursor).toBeTruthy();

    const cursor2 = batch2.nextCursor!;

    // Request Batch 3 (terminal batch in DESC order)
    const batch3Res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence?limit=2&cursor=${cursor2}&order=DESC`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(batch3Res.statusCode).toBe(200);
    const batch3: TopicEvidenceResponse = JSON.parse(batch3Res.body);
    expect(batch3.evidence.length).toBe(1);
    expect(batch3.evidence[0]!.verbatimText).toContain('1-хабар:\nИчимлик суви босими');
    expect(batch3.hasNextPage).toBe(false);
    expect(batch3.nextCursor).toBeNull();
  });

  it('rejects invalid order query parameter with HTTP 400', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence?order=INVALID`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('strictly sanitizes sender attribution and excludes citizen phone numbers or private IDs (AC 5, AD-11)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body: TopicEvidenceResponse = JSON.parse(res.body);

    const rawResponseText = res.body;

    // Negative guardrail: No phone number in raw payload
    expect(rawResponseText).not.toContain('+998901234567');
    expect(rawResponseText).not.toContain('99887711');
    expect(rawResponseText).not.toContain('99887722');
    expect(rawResponseText).not.toContain('telegramUserId');

    // Positive attribution checks
    const item1 = body.evidence[0]!;
    expect(item1.authorUsername).toBe('@anvar_uz');
    expect(item1.authorName).toBe('Anvar Qodirov');

    const item2 = body.evidence[1]!;
    expect(item2.authorUsername).toBeNull();
    expect(item2.authorName).toBe('Dilshod Rahimov');

    const item3 = body.evidence[2]!;
    expect(item3.authorUsername).toBeNull();
    expect(item3.authorName).toBe('Нодир');

    const item4 = body.evidence[3]!;
    expect(item4.authorUsername).toBeNull();
    expect(item4.authorName).toBeNull();

    const item5 = body.evidence[4]!;
    expect(item5.authorUsername).toBe('@sarvar_reporter');
  });

  it('resolves 3-tier Telegram deep links safely (AC 6)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body: TopicEvidenceResponse = JSON.parse(res.body);

    // Tier 1: Public group with username -> https://t.me/${username}/${msgId}
    expect(body.evidence[0]!.telegramDeepLink).toBe('https://t.me/bobur_mahalla_public/101');

    // Tier 2a: Private supergroup with -100 prefix -> https://t.me/c/${chatIdWithoutPrefix}/${msgId}
    expect(body.evidence[1]!.telegramDeepLink).toBe(`https://t.me/c/${privateChatId.slice(4)}/102`);

    // Tier 2b: Private basic group with - prefix (Gulbodom production case) -> https://t.me/c/${chatIdWithoutPrefix}/${msgId}
    expect(body.evidence[2]!.telegramDeepLink).toBe(`https://t.me/c/${legacyChatId.slice(1)}/103`);
  });

  it('rejects invalid or malformed pagination cursor with HTTP 400', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${topicA1Id}/evidence?cursor=invalid_base64_json!`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    // A3: was 'VALIDATION_ERROR'. Unified with the sibling district evidence
    // route (district-topics-routes.ts:170) and with InvalidCursorError, which
    // already carries statusCode 400 / code 'INVALID_CURSOR'. Verified no
    // client under apps/web branches on 'VALIDATION_ERROR' (zero matches).
    expect(body.error.code).toBe('INVALID_CURSOR');
    expect(body.error.message).toContain('Курсор');
  });

  it('A3: service contract rejects a malformed cursor with a typed 400 error', async () => {
    // The routes pre-validate the cursor, so this branch is unreachable via HTTP.
    // It is still part of getTopicEvidence's public contract: a caller that
    // reaches it must receive a typed domain error, not a bare Error that no
    // mapper can classify.
    const thrown = await getTopicEvidence(
      db,
      {
        id: `acc_probe_${crypto.randomUUID().slice(0, 8)}`,
        role: 'DISTRICT_HOKIM',
        username: 'probe',
        districtId: districtAId,
      },
      topicA1Id,
      { cursor: 'invalid_base64_json!', limit: 50, order: 'ASC' },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(Error);
    const typed = thrown as Error & { statusCode?: number; code?: string };
    expect(typed.statusCode).toBe(400);
    expect(typed.code).toBe('INVALID_CURSOR');
  });

  it('accurately identifies and flags isHokimRelated for evidence items referencing Hokim terms', async () => {
    const hokimTopicId = `top_hokim_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(topics).values({
      id: hokimTopicId,
      districtId: districtAId,
      mahallaName: 'Бобур',
      calendarDay: testCalendarDay,
      primaryLane: 'HOKIM_RELATED',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date('2026-08-23T11:00:00Z'),
      retentionExpiresAt: new Date(Date.now() + 30 * 86400000),
    });

    const intakeRecordId = `intake_h_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeRecordId,
      districtId: districtAId,
      mahallaName: 'Бобур',
      telegramBotId: 'bot_test_123',
      telegramChatId: publicChatId,
      telegramMessageId: '2000',
      originalTimestamp: new Date(),
      calendarDay: testCalendarDay,
      rawPayload: { text: 'test' },
      createdAt: new Date(),
    });

    const eviHokimId = `evi_h_1_${crypto.randomUUID().slice(0, 8)}`;
    const eviPlainId = `evi_p_1_${crypto.randomUUID().slice(0, 8)}`;

    await db.insert(acceptedEvidence).values([
      {
        id: eviHokimId,
        topicId: hokimTopicId,
        districtId: districtAId,
        mahallaName: 'Бобур',
        calendarDay: testCalendarDay,
        intakeRecordId,
        telegramChatId: publicChatId,
        telegramMessageId: '201',
        originalTimestamp: new Date('2026-08-23T11:00:00Z'),
        verbatimText: 'Ҳурматли Ҳокимга мурожаат: маҳалламизда йўл таъмирланмаган!',
        contentType: 'TEXT',
        userMetadata: { username: 'citizen_1' },
      },
      {
        id: eviPlainId,
        topicId: hokimTopicId,
        districtId: districtAId,
        mahallaName: 'Бобур',
        calendarDay: testCalendarDay,
        intakeRecordId,
        telegramChatId: publicChatId,
        telegramMessageId: '202',
        originalTimestamp: new Date('2026-08-23T11:05:00Z'),
        verbatimText: 'Ҳақиқатан ҳам шундай, чуқурлар кўп.',
        contentType: 'TEXT',
        userMetadata: { username: 'citizen_2' },
      },
    ]);

    await db.insert(topicProjections).values({
      id: `prj_h_${crypto.randomUUID().slice(0, 8)}`,
      topicId: hokimTopicId,
      districtId: districtAId,
      mahallaName: 'Бобур',
      calendarDay: testCalendarDay,
      summary: 'Йўл таъмири бўйича ҳокимга мурожаат.',
      lanes: ['HOKIM_RELATED'],
      primaryLane: 'HOKIM_RELATED',
      anchorEvidenceId: eviHokimId,
      anchorQuote: 'Ҳурматли Ҳокимга мурожаат',
      latestMeaningfulActivityTimestamp: new Date('2026-08-23T11:05:00Z'),
      attribution: 'Бобур аҳолиси',
      isHokimRelated: true,
      generation: 1,
      aiProfileId: defaultAiProfileId,
    });

    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${hokimTopicId}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimACookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body: TopicEvidenceResponse = JSON.parse(res.body);
    expect(body.evidence.length).toBe(2);

    const hokimMsg = body.evidence.find((e) => e.id === eviHokimId);
    const plainMsg = body.evidence.find((e) => e.id === eviPlainId);

    expect(hokimMsg).toBeDefined();
    expect(hokimMsg?.isHokimRelated).toBe(true);

    expect(plainMsg).toBeDefined();
    expect(plainMsg?.isHokimRelated).toBe(false);
  });
});
