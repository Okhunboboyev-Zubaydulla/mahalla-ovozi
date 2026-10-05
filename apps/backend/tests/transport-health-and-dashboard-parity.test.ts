import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import crypto from 'node:crypto';
import { eq, or, sql } from 'drizzle-orm';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import {
  accounts,
  districts,
  topics,
  topicProjections,
  acceptedEvidence,
  telegramIntakeRecords,
  districtTelegramGroups,
  districtTelegramBots,
  districtTelegramUserbotSessions,
  operationalIssues,
} from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { COOKIE_NAME } from '../src/modules/auth/session-manager.js';
import { getTashkentCalendarDay } from '../src/modules/telegram-intake/timezone-util.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import type { QualifyingLane } from '@mahalla-ovozi/api-contracts';
import {
  UserbotConnectionManager,
  type UserbotClientPort,
  type UserbotClientEvents,
} from '../src/modules/userbot/index.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

class MockUserbotClient implements UserbotClientPort {
  readonly districtId: string;
  readonly sessionString: string;
  readonly apiId: string;
  readonly phoneNumber: string;

  connectCalls: number = 0;
  disconnectCalls: number = 0;
  private connected: boolean = false;
  private listeners: Record<string, ((...args: unknown[]) => void)[]> = {
    message: [],
    disconnect: [],
    reconnect: [],
    error: [],
    ban: [],
    gap: [],
  };

  constructor(params: {
    districtId: string;
    sessionString: string;
    apiId: string;
    phoneNumber: string;
  }) {
    this.districtId = params.districtId;
    this.sessionString = params.sessionString;
    this.apiId = params.apiId;
    this.phoneNumber = params.phoneNumber;
  }

  async connect(): Promise<void> {
    this.connectCalls++;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.connected = false;
    this.emit('disconnect');
  }

  isConnected(): boolean {
    return this.connected;
  }

  on<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void;
  on(...[event, listener]: [string, (...args: unknown[]) => void]): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    const handlers = this.listeners[event] ?? [];
    for (const h of handlers) {
      h(...args);
    }
  }

  getUpdatePosition(): string | null {
    return '{"pts":100,"qts":50,"date":1700000000,"seq":1,"version":"teleproto-v1"}';
  }
}

describe('Ticket 22: Operator-Visible Transport Health and Dashboard Parity Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let districtId: string;
  let hokimAccountId: string;
  let poAccountId: string;
  let hokimCookie: string;
  let poCookie: string;

  let botGroupId: string;
  let userbotGroupId: string;

  let userbotTopicId: string;
  let botApiTopicId: string;

  let botChatId: string;
  let ubChatId: string;

  const now = new Date();
  const testCalendarDay = getTashkentCalendarDay(Math.floor(now.getTime() / 1000));

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    await ensureDefaultAiProfiles(db);

    // Clean up any lingering test districts from previous interrupted runs
    await db.execute(sql`
      DELETE FROM districts
      WHERE id LIKE 'dist_p22_%' OR id LIKE 'dist_sub_%';
    `);

    botChatId = String(-1000000000000 - Math.floor(Math.random() * 900000000000));
    ubChatId = String(-1000000000000 - Math.floor(Math.random() * 900000000000));

    // 1. Create test District
    districtId = `dist_p22_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtId,
      name: `Янгиобод тумани ${districtId}`,
      region: 'Тошкент вилояти',
      status: 'ACTIVE',
      accessEligible: true,
    });

    // 2. Create Hokim Account
    hokimAccountId = `acc_hokim_${crypto.randomUUID().slice(0, 8)}`;
    const hokimUsername = `hokim_${Date.now()}_${crypto.randomUUID().slice(0, 4)}`;
    const passHashHokim = await hashPassword('HokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimAccountId,
      username: hokimUsername,
      passwordHash: passHashHokim,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId,
      mustChangePassword: false,
    });

    // 3. Create Product Owner Account
    poAccountId = `acc_po_${crypto.randomUUID().slice(0, 8)}`;
    const poUsername = `po_${Date.now()}_${crypto.randomUUID().slice(0, 4)}`;
    const passHashPo = await hashPassword('ProductOwnerPass2026!');
    await db.insert(accounts).values({
      id: poAccountId,
      username: poUsername,
      passwordHash: passHashPo,
      role: 'PRODUCT_OWNER',
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    // Sign in Hokim
    const resHokim = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: hokimUsername,
        password: 'HokimPassword2026!',
      },
    });
    const cA = resHokim.cookies.find((c) => c.name === COOKIE_NAME);
    hokimCookie = `${cA!.name}=${cA!.value}`;

    // Sign in Product Owner
    const resPo = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: poUsername,
        password: 'ProductOwnerPass2026!',
      },
    });
    const cPo = resPo.cookies.find((c) => c.name === COOKIE_NAME);
    poCookie = `${cPo!.name}=${cPo!.value}`;

    // 4. Register District Telegram Bot (for Bot API transport)
    await db.insert(districtTelegramBots).values({
      id: `bot_${crypto.randomUUID().slice(0, 8)}`,
      districtId,
      botId: `123456789_${crypto.randomUUID().slice(0, 4)}`,
      botUsername: 'yangiobod_bot',
      botFirstName: 'Yangiobod Bot',
      encryptedToken: 'enc_token',
      tokenIv: 'iv_token',
      tokenTag: 'tag_token',
      tokenMasked: '123456789:AA***',
      status: 'VALID',
      lastValidatedAt: now,
    });

    // 5. Register two groups: one BOT_API, one USERBOT
    botGroupId = `grp_bot_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districtTelegramGroups).values({
      id: botGroupId,
      districtId,
      telegramChatId: botChatId,
      telegramChatTitle: 'Янгиобод Ҳокимлик Гуруҳи (Bot API)',
      mahallaName: 'Янги Ҳаёт маҳалласи',
      status: 'VALID',
      transport: 'BOT_API',
      createdAt: now,
    });

    userbotGroupId = `grp_ub_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districtTelegramGroups).values({
      id: userbotGroupId,
      districtId,
      telegramChatId: ubChatId,
      telegramChatTitle: 'Бирлик Маҳалласи Ёпиқ Гуруҳи (Userbot)',
      mahallaName: 'Бирлик маҳалласи',
      status: 'VALID',
      transport: 'USERBOT',
      createdAt: now,
    });

    // 6. Register active Userbot Session in DB
    const encSession = encryptToken('1BJWNg...dummyTelegramSessionString...');
    await db.insert(districtTelegramUserbotSessions).values({
      id: `ub_sess_${crypto.randomUUID().slice(0, 8)}`,
      districtId,
      phoneNumber: '+998901234567',
      apiId: '23456789',
      sessionEncrypted: encSession.encryptedToken,
      sessionIv: encSession.tokenIv,
      sessionTag: encSession.tokenTag,
      status: 'ACTIVE',
      inboundUpdateCounter: 15,
      isStale: false,
      lastSuccessfulConnectionAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // 7. Seed Bot API Evidence & Topic
    const botIntakeId = `int_bot_${crypto.randomUUID().slice(0, 8)}`;
    botApiTopicId = `top_bot_${crypto.randomUUID().slice(0, 8)}`;
    const botEvidenceId = `evi_bot_${crypto.randomUUID().slice(0, 8)}`;
    const botProjId = `prj_bot_${crypto.randomUUID().slice(0, 8)}`;

    await db.insert(telegramIntakeRecords).values({
      id: botIntakeId,
      districtId,
      mahallaName: 'Янги Ҳаёт маҳалласи',
      source: 'BOT_API',
      telegramBotId: 'bot_test',
      telegramChatId: botChatId,
      telegramMessageId: '101',
      rawPayload: { text: 'Электр таъминотида қисқа муддатли узилиш бўлди.' },
      originalTimestamp: now,
      calendarDay: testCalendarDay,
      createdAt: now,
    });

    await db.insert(topics).values({
      id: botApiTopicId,
      districtId,
      mahallaName: 'Янги Ҳаёт маҳалласи',
      calendarDay: testCalendarDay,
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 86400000),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(acceptedEvidence).values({
      id: botEvidenceId,
      topicId: botApiTopicId,
      districtId,
      mahallaName: 'Янги Ҳаёт маҳалласи',
      calendarDay: testCalendarDay,
      intakeRecordId: botIntakeId,
      telegramChatId: botChatId,
      telegramMessageId: '101',
      originalTimestamp: now,
      verbatimText: 'Электр таъминотида қисқа муддатли узилиш бўлди.',
      contentType: 'TEXT',
      createdAt: now,
    });

    const aiProfile = (await db.query.aiProfiles.findFirst())!;
    await db.insert(topicProjections).values({
      id: botProjId,
      topicId: botApiTopicId,
      districtId,
      mahallaName: 'Янги Ҳаёт маҳалласи',
      calendarDay: testCalendarDay,
      summary: 'Янги Ҳаёт маҳалласида электр таъминотида узилиш бўлгани ҳақида хабар қилинмоқда.',
      lanes: ['ELECTRICITY'],
      primaryLane: 'ELECTRICITY',
      anchorEvidenceId: botEvidenceId,
      anchorQuote: 'Электр таъминотида қисқа муддатли узилиш бўлди.',
      latestMeaningfulActivityTimestamp: now,
      attribution: 'Янги Ҳаёт аҳолиси',
      isHokimRelated: false,
      generation: 1,
      aiProfileId: aiProfile.id,
      createdAt: now,
      updatedAt: now,
    });

    // 8. Seed Userbot Evidence & Topic (refuses bots group, civic substance, multi-lane)
    const ubIntakeId = `int_ub_${crypto.randomUUID().slice(0, 8)}`;
    userbotTopicId = `top_ub_${crypto.randomUUID().slice(0, 8)}`;
    const ubEvidenceId = `evi_ub_${crypto.randomUUID().slice(0, 8)}`;
    const ubProjId = `prj_ub_${crypto.randomUUID().slice(0, 8)}`;

    await db.insert(telegramIntakeRecords).values({
      id: ubIntakeId,
      districtId,
      mahallaName: 'Бирлик маҳалласи',
      source: 'USERBOT',
      telegramBotId: null, // Userbot has zero botId
      telegramChatId: ubChatId,
      telegramMessageId: '502',
      rawPayload: { text: 'Сув қувури ёрилиб кўчани сув босди, масъуллар ҳали келмади!' },
      originalTimestamp: now,
      calendarDay: testCalendarDay,
      createdAt: now,
    });

    await db.insert(topics).values({
      id: userbotTopicId,
      districtId,
      mahallaName: 'Бирлик маҳалласи',
      calendarDay: testCalendarDay,
      primaryLane: 'HOKIM_RELATED',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 86400000),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(acceptedEvidence).values({
      id: ubEvidenceId,
      topicId: userbotTopicId,
      districtId,
      mahallaName: 'Бирлик маҳалласи',
      calendarDay: testCalendarDay,
      intakeRecordId: ubIntakeId,
      telegramChatId: ubChatId,
      telegramMessageId: '502',
      originalTimestamp: now,
      verbatimText: 'Сув қувури ёрилиб кўчани сув босди, масъуллар ҳали келмади!',
      contentType: 'TEXT',
      createdAt: now,
    });

    await db.insert(topicProjections).values({
      id: ubProjId,
      topicId: userbotTopicId,
      districtId,
      mahallaName: 'Бирлик маҳалласи',
      calendarDay: testCalendarDay,
      summary: 'Бирлик маҳалласида сув қувури шикастланиши оқибатида сув босими йўқолгани ҳақида аҳоли томонидан хабар қилинмоқда.',
      lanes: ['HOKIM_RELATED', 'WATER'],
      primaryLane: 'HOKIM_RELATED',
      anchorEvidenceId: ubEvidenceId,
      anchorQuote: 'Сув қувури ёрилиб кўчани сув босди',
      latestMeaningfulActivityTimestamp: now,
      attribution: 'Бирлик аҳолиси',
      isHokimRelated: true,
      generation: 1,
      aiProfileId: aiProfile.id,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    try {
      await db.execute(sql`
        DELETE FROM districts
        WHERE id = ${districtId} OR id LIKE 'dist_sub_%';
      `);
    } catch {
      // Ignore cleanup error on teardown
    }
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('Criterion 1: Userbot-sourced evidence synthesizes into a Topic appearing alongside Bot API topics on the 5-lane board', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Check that both Bot API topic and Userbot topic are present on the board
    const allTopics = Object.values(body.lanes).flatMap(
      (laneData: unknown) => (laneData as { topics: Array<{ id: string }> }).topics,
    );
    const topicIds = allTopics.map((t) => t.id);

    expect(topicIds).toContain(botApiTopicId);
    expect(topicIds).toContain(userbotTopicId);
  });

  it('Criterion 2: Topic is bound to a single Asia/Tashkent calendar day regardless of transport', async () => {
    // Both topics created from Bot API and Userbot have the exact same Tashkent calendarDay
    const [botTopicRow] = await db.select().from(topics).where(eq(topics.id, botApiTopicId));
    const [ubTopicRow] = await db.select().from(topics).where(eq(topics.id, userbotTopicId));

    expect(botTopicRow?.calendarDay).toBe(testCalendarDay);
    expect(ubTopicRow?.calendarDay).toBe(testCalendarDay);
    expect(botTopicRow?.calendarDay).toBe(ubTopicRow?.calendarDay);

    // Querying with an unrelated calendar day returns zero topics for this day
    const yesterdaySeconds = Math.floor(now.getTime() / 1000) - 86400;
    const yesterdayCalendarDay = getTashkentCalendarDay(yesterdaySeconds);
    const resOtherDay = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${yesterdayCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });
    expect(resOtherDay.statusCode).toBe(200);
    const otherBody = resOtherDay.json();
    const otherTopics = Object.values(otherBody.lanes).flatMap(
      (laneData: unknown) => (laneData as { topics: Array<{ id: string }> }).topics,
    );
    expect(otherTopics.length).toBe(0);
  });

  it('Criterion 3: Zero indicators distinguish bot-sourced from userbot-sourced evidence (Transport-Agnostic Hokim View)', async () => {
    // 1. Check Hokim board response
    const resBoard = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });
    expect(resBoard.statusCode).toBe(200);
    const boardJson = resBoard.body;

    // Transport keywords and credentials must never appear anywhere in the Hokim JSON
    expect(boardJson).not.toMatch(/"transport"/i);
    expect(boardJson).not.toMatch(/"groupTransport"/i);
    expect(boardJson).not.toMatch(/"USERBOT"/);
    expect(boardJson).not.toMatch(/"BOT_API"/);
    expect(boardJson).not.toMatch(/"botId"/i);
    expect(boardJson).not.toMatch(/"telegramBotId"/i);
    expect(boardJson).not.toMatch(/"sessionString"/i);
    expect(boardJson).not.toMatch(/"sessionEncrypted"/i);
    expect(boardJson).not.toMatch(/"sessionIv"/i);
    expect(boardJson).not.toMatch(/"sessionTag"/i);

    // 2. Check Hokim evidence response for userbot topic
    const resEvidenceUb = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${userbotTopicId}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });
    expect(resEvidenceUb.statusCode).toBe(200);
    const evidenceUbJson = resEvidenceUb.body;

    expect(evidenceUbJson).not.toMatch(/"transport"/i);
    expect(evidenceUbJson).not.toMatch(/"groupTransport"/i);
    expect(evidenceUbJson).not.toMatch(/"USERBOT"/);
    expect(evidenceUbJson).not.toMatch(/"BOT_API"/);
    expect(evidenceUbJson).not.toMatch(/"botId"/i);
    expect(evidenceUbJson).not.toMatch(/"telegramBotId"/i);
    expect(evidenceUbJson).not.toMatch(/"sessionString"/i);

    // 3. Check Hokim evidence response for bot topic
    const resEvidenceBot = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${botApiTopicId}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });
    expect(resEvidenceBot.statusCode).toBe(200);
    const evidenceBotJson = resEvidenceBot.body;

    expect(evidenceBotJson).not.toMatch(/"transport"/i);
    expect(evidenceBotJson).not.toMatch(/"USERBOT"/);
    expect(evidenceBotJson).not.toMatch(/"BOT_API"/);
  });

  it('Criterion 4: District whose transport has failed reads as visibly degraded rather than silently empty', async () => {
    // A) In healthy state: hasProcessingDelay is false
    const resHealthy = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });
    expect(resHealthy.statusCode).toBe(200);
    expect(resHealthy.json().hasProcessingDelay).toBe(false);

    // B) Inject active degraded issue: UNRECOVERABLE_GAP
    const gapIssueId = `iss_gap_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(operationalIssues).values({
      id: gapIssueId,
      logicalKey: `DISTRICT:${districtId}:USERBOT:UNRECOVERABLE_GAP`,
      scope: 'DISTRICT',
      districtId,
      component: 'USERBOT',
      issueCategory: 'UNRECOVERABLE_GAP',
      severity: 'Warning',
      status: 'ACTIVE',
      healthStatus: 'Degraded',
      sanitizedTitle: 'Telegram хабарлар узилиши (Incomplete Awareness)',
      sanitizedDescription: 'Туман Telegram гуруҳида тиклаб бўлмайдиган хабарлар узилиши юз берди.',
      recommendedAction: 'Ўтказиб юборилган хабарларни текширинг.',
      startedAt: new Date(),
      latestCheckAt: new Date(),
    });

    // 1. Hokim board visibly shows degradation notice (hasProcessingDelay = true)
    const resDegraded = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });
    expect(resDegraded.statusCode).toBe(200);
    expect(resDegraded.json().hasProcessingDelay).toBe(true);

    // 2. Operator / Product Owner health endpoint surfaces Degraded
    const resHealth = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtId}/health`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(resHealth.statusCode).toBe(200);
    const healthBody = resHealth.json();
    expect(healthBody.status).toBe('Degraded');
    const intakeComponent = healthBody.components.find((c: { component: string }) => c.component === 'message_intake');
    expect(intakeComponent).toBeDefined();
    expect(intakeComponent.status).toBe('Degraded');
    expect(intakeComponent.errorCode).toBe('UNRECOVERABLE_GAP');

    // Clean up gap issue
    await db.delete(operationalIssues).where(eq(operationalIssues.id, gapIssueId));
  });

  it('Criterion 5: Topic summary uses cautious and clearly unverified language', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const hokimLanes = body.lanes as Record<string, { topics: Array<{ id: string; summary: string }> }>;
    const allTopics = Object.values(hokimLanes).flatMap((l) => l.topics);

    const ubTopic = allTopics.find((t) => t.id === userbotTopicId);
    expect(ubTopic).toBeDefined();
    // Cautious probability phrasing in Uzbek: contains "хабар қилинмоқда"
    expect(ubTopic!.summary).toContain('хабар қилинмоқда');
  });

  it('Criterion 6: Evidence behind a Topic is preserved verbatim', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${userbotTopicId}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.evidence).toBeDefined();
    expect(body.evidence.length).toBeGreaterThan(0);

    const firstEvidence = body.evidence[0];
    // Exact civic substance preserved verbatim
    expect(firstEvidence.verbatimText).toBe(
      'Сув қувури ёрилиб кўчани сув босди, масъуллар ҳали келмади!',
    );
  });

  it('Criterion 7: Topic signal is projected into every Lane it genuinely concerns (Multi-Lane Projection)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const lanes = body.lanes as Record<string, { topics: Array<{ id: string }> }>;

    // userbotTopicId was projected into ['HOKIM_RELATED', 'WATER']
    const inHokimRelated = lanes.HOKIM_RELATED.topics.some((t) => t.id === userbotTopicId);
    const inWater = lanes.WATER.topics.some((t) => t.id === userbotTopicId);

    expect(inHokimRelated).toBe(true);
    expect(inWater).toBe(true);
  });

  it('Criterion 8: Hokim dashboard is read-only with respect to transport (zero mutations on userbot sessions)', async () => {
    // 1. Capture userbot session before dashboard queries
    const [beforeSession] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    expect(beforeSession).toBeDefined();

    // 2. Execute dashboard board, lane, and evidence endpoints
    await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/lane?lane=HOKIM_RELATED&calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/${userbotTopicId}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    // 3. Capture userbot session after queries
    const [afterSession] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    // Zero mutations asserted
    expect(afterSession?.status).toBe(beforeSession?.status);
    expect(afterSession?.inboundUpdateCounter).toBe(beforeSession?.inboundUpdateCounter);
    expect(afterSession?.updatePosition).toBe(beforeSession?.updatePosition);
    expect(afterSession?.updatedAt.getTime()).toBe(beforeSession?.updatedAt.getTime());
    expect(afterSession?.lastSeenAt?.getTime()).toBe(beforeSession?.lastSeenAt?.getTime());
  });

  it('Criterion 9: Where recovery cannot be guaranteed, platform raises incomplete-awareness notice on operational issue', async () => {
    const mockFactory = () =>
      new MockUserbotClient({
        districtId,
        sessionString: 'session_mock',
        apiId: '12345',
        phoneNumber: '+998901234567',
      });

    const manager = new UserbotConnectionManager({
      db,
      pool,
      clientFactory: mockFactory,
    });

    // Invoke handleUnrecoverableGap
    await manager.handleUnrecoverableGap(districtId, {
      reason: 'Server state desynchronized; gap detected in message sequence',
    });

    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(
        eq(operationalIssues.logicalKey, `DISTRICT:${districtId}:USERBOT:UNRECOVERABLE_GAP`),
      );

    expect(issue).toBeDefined();
    expect(issue?.status).toBe('ACTIVE');
    expect(issue?.issueCategory).toBe('UNRECOVERABLE_GAP');
    expect(issue?.healthStatus).toBe('Degraded');
    // Notice must state incomplete awareness in Uzbek and metadata
    expect(issue?.sanitizedDescription).toContain('Билиш даражаси тўлиқ эмас (incomplete awareness)');
    expect(issue?.metadata).toMatchObject({
      districtId,
      incompleteAwareness: true,
      errorCode: 'UNRECOVERABLE_GAP',
    });

    // Clean up issue
    await db.delete(operationalIssues).where(eq(operationalIssues.id, issue!.id));
  });

  it('Criterion 10: District whose subscription has lapsed stops consuming transport resources and reads as NOT_ENTITLED rather than broken', async () => {
    // 1. Create a dedicated district for subscription testing
    const subDistrictId = `dist_sub_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: subDistrictId,
      name: `Мустақиллик тумани ${subDistrictId}`,
      region: 'Тошкент',
      status: 'ACTIVE',
      accessEligible: true,
    });

    const encSubSession = encryptToken('1BJWNg...dummySubDistrictSessionString...');
    await db.insert(districtTelegramUserbotSessions).values({
      id: `ub_sess_${crypto.randomUUID().slice(0, 8)}`,
      districtId: subDistrictId,
      phoneNumber: '+998909876543',
      apiId: '98765432',
      sessionEncrypted: encSubSession.encryptedToken,
      sessionIv: encSubSession.tokenIv,
      sessionTag: encSubSession.tokenTag,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    let mockClientInstance: MockUserbotClient | null = null;
    const mockFactory = (params: {
      districtId: string;
      sessionString: string;
      apiId: string;
      phoneNumber: string;
    }) => {
      mockClientInstance = new MockUserbotClient(params);
      return mockClientInstance;
    };

    const manager = new UserbotConnectionManager({
      db,
      pool,
      clientFactory: mockFactory,
    });

    // Connect sessions
    await manager.syncSessions();
    expect(mockClientInstance).not.toBeNull();
    expect(mockClientInstance!.isConnected()).toBe(true);

    // Initial check: subscription is active, session is healthy
    const activeHealth = await manager.checkSessionHealth(subDistrictId);
    expect(activeHealth.isHealthy).toBe(true);
    expect(activeHealth.isConnected).toBe(true);
    expect(activeHealth.status).toBe('ACTIVE');

    // 2. Now lapse subscription: update district to SUSPENDED
    await db
      .update(districts)
      .set({ status: 'SUSPENDED', accessEligible: false })
      .where(eq(districts.id, subDistrictId));

    // 3. checkSessionHealth immediately reads as NOT_ENTITLED and disconnects
    const lapsedHealth = await manager.checkSessionHealth(subDistrictId);
    expect(lapsedHealth.isHealthy).toBe(false);
    expect(lapsedHealth.isConnected).toBe(false);
    expect(lapsedHealth.status).toBe('NOT_ENTITLED');
    expect(lapsedHealth.reason).toBe('District subscription is not active or eligible');

    // Assert client was disconnected and no longer consuming resources
    expect(mockClientInstance!.isConnected()).toBe(false);

    // Syncing sessions confirms district is unmanaged
    await manager.syncSessions();
    const finalReport = await manager.checkSessionHealth(subDistrictId);
    expect(finalReport.status).toBe('NOT_ENTITLED');
    expect(finalReport.isConnected).toBe(false);
  });
});
