import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, topics, topicProjections, acceptedEvidence, telegramIntakeRecords, userDashboardVisits } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import { eq, and } from 'drizzle-orm';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { COOKIE_NAME } from '../src/modules/auth/session-manager.js';
import { getTashkentCalendarDay } from '../src/modules/telegram-intake/timezone-util.js';
import { HokimTopicBoardResponse } from '@mahalla-ovozi/api-contracts';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 3.3: Background Refresh, Baseline Preservation & Delay Invariants Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let districtId: string;
  let hokimId: string;
  let hokimCookie: string;

  const testCalendarDay = getTashkentCalendarDay(Math.floor(Date.now() / 1000));

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    await ensureDefaultAiProfiles(db);

    // Create District
    districtId = `dist_ref_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: districtId,
      name: `Яшнобод тумани ${districtId}`,
      region: 'Тошкент шаҳри',
      status: 'ACTIVE',
    });

    // Create Hokim Account
    hokimId = `acc_hokim_ref_${crypto.randomUUID().slice(0, 8)}`;
    const passHash = await hashPassword('HokimRefresh2026!');
    await db.insert(accounts).values({
      id: hokimId,
      username: `hokim_refresh_${Date.now()}`,
      passwordHash: passHash,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: districtId,
      mustChangePassword: false,
    });

    // Sign in Hokim
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: (await db.query.accounts.findFirst({ where: (acc, { eq }) => eq(acc.id, hokimId) }))!.username,
        password: 'HokimRefresh2026!',
      },
    });
    const cookie = res.cookies.find((c) => c.name === COOKIE_NAME);
    hokimCookie = `${cookie!.name}=${cookie!.value}`;
  });

  afterAll(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('Test 1: Cold load creates a new visit record and returns serverEvaluatedAt & hasProcessingDelay (AC 1, 6)', async () => {
    // Count visits before cold load
    const visitsBefore = await db.query.userDashboardVisits.findMany({
      where: and(
        eq(userDashboardVisits.userId, hokimId),
        eq(userDashboardVisits.districtId, districtId),
      ),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as HokimTopicBoardResponse;
    expect(body.districtId).toBe(districtId);
    expect(body.serverEvaluatedAt).toBeDefined();
    expect(new Date(body.serverEvaluatedAt).getTime()).not.toBeNaN();
    expect(typeof body.hasProcessingDelay).toBe('boolean');

    // Verify exactly one visit record was created
    const visitsAfter = await db.query.userDashboardVisits.findMany({
      where: and(
        eq(userDashboardVisits.userId, hokimId),
        eq(userDashboardVisits.districtId, districtId),
      ),
    });
    expect(visitsAfter.length).toBe(visitsBefore.length + 1);
  });

  it('Test 2: Background refresh with baselineTimestamp skips visit row insertion and preserves baseline (AC 1, 3)', async () => {
    const fixedBaseline = new Date(Date.now() - 3600000).toISOString();

    const visitsBefore = await db.query.userDashboardVisits.findMany({
      where: and(
        eq(userDashboardVisits.userId, hokimId),
        eq(userDashboardVisits.districtId, districtId),
      ),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}&baselineTimestamp=${encodeURIComponent(fixedBaseline)}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as HokimTopicBoardResponse;
    expect(body.visitBaselineTimestamp).toBe(fixedBaseline);

    // Verify NO new visit record was inserted
    const visitsAfter = await db.query.userDashboardVisits.findMany({
      where: and(
        eq(userDashboardVisits.userId, hokimId),
        eq(userDashboardVisits.districtId, districtId),
      ),
    });
    expect(visitsAfter.length).toBe(visitsBefore.length);
  });

  async function createTopicWithProjection(params: {
    districtId: string;
    mahallaName: string;
    calendarDay: string;
    primaryLane: 'WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE' | 'HOKIM_RELATED';
    lanes: ('WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE' | 'HOKIM_RELATED')[];
    summary: string;
    createdAt: Date;
    updatedAt: Date;
    projectionUpdatedAt?: Date;
    isHokimRelated?: boolean;
  }) {
    const topicId = `top_${crypto.randomUUID().slice(0, 8)}`;
    const intakeId = `intk_${crypto.randomUUID().slice(0, 8)}`;
    const evidenceId = `evi_${crypto.randomUUID().slice(0, 8)}`;
    const projectionId = `prj_${crypto.randomUUID().slice(0, 8)}`;

    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-100123456789',
      telegramMessageId: String(Math.floor(Math.random() * 1000000)),
      rawPayload: {},
      originalTimestamp: params.createdAt,
      calendarDay: params.calendarDay,
      createdAt: params.createdAt,
      updatedAt: params.createdAt,
    });

    await db.insert(topics).values({
      id: topicId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      calendarDay: params.calendarDay,
      primaryLane: params.primaryLane,
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: params.updatedAt,
      retentionExpiresAt: new Date(Date.now() + 90 * 86400000),
      createdAt: params.createdAt,
      updatedAt: params.updatedAt,
    });

    await db.insert(acceptedEvidence).values({
      id: evidenceId,
      topicId: topicId,
      districtId: params.districtId,
      mahallaName: params.mahallaName,
      calendarDay: params.calendarDay,
      intakeRecordId: intakeId,
      telegramChatId: '-100123456789',
      telegramMessageId: String(Math.floor(Math.random() * 1000000)),
      originalTimestamp: params.createdAt,
      verbatimText: params.summary,
      contentType: 'TEXT',
      createdAt: params.createdAt,
    });

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
      anchorQuote: params.summary,
      latestMeaningfulActivityTimestamp: params.updatedAt,
      attribution: 'Маҳалла аҳолиси',
      isHokimRelated: params.isHokimRelated ?? false,
      generation: 1,
      aiProfileId: defaultAiProfile.id,
      createdAt: params.createdAt,
      updatedAt: params.projectionUpdatedAt ?? params.updatedAt,
    });

    return { topicId, evidenceId, projectionId };
  }

  it('Test 3: Freshness evaluation correctly distinguishes isNew vs isUpdated relative to baseline (AC 3, 4)', async () => {
    const baseline = new Date('2026-08-23T10:00:00.000Z');
    const baselineIso = baseline.toISOString();

    // 1. Topic created before baseline, updated before baseline -> isNew: false, isUpdated: false
    const { topicId: topicOldId } = await createTopicWithProjection({
      districtId,
      mahallaName: 'Дўстлик маҳалласи',
      calendarDay: testCalendarDay,
      primaryLane: 'WATER',
      lanes: ['WATER'],
      summary: 'Эски сув қувури таъмирланмоқда.',
      createdAt: new Date('2026-08-23T08:00:00.000Z'),
      updatedAt: new Date('2026-08-23T08:30:00.000Z'),
      projectionUpdatedAt: new Date('2026-08-23T08:30:00.000Z'),
    });

    // 2. Topic created before baseline, updated AFTER baseline -> isNew: false, isUpdated: true
    const { topicId: topicUpdatedId } = await createTopicWithProjection({
      districtId,
      mahallaName: 'Дўстлик маҳалласи',
      calendarDay: testCalendarDay,
      primaryLane: 'WATER',
      lanes: ['WATER'],
      summary: 'Янги қўшимча далиллар қўшилди.',
      createdAt: new Date('2026-08-23T09:00:00.000Z'),
      updatedAt: new Date('2026-08-23T11:00:00.000Z'),
      projectionUpdatedAt: new Date('2026-08-23T11:00:00.000Z'),
    });

    // 3. Topic created AFTER baseline -> isNew: true, isUpdated: false
    const { topicId: topicNewId } = await createTopicWithProjection({
      districtId,
      mahallaName: 'Дўстлик маҳалласи',
      calendarDay: testCalendarDay,
      primaryLane: 'WATER',
      lanes: ['WATER'],
      summary: 'Мутлақо янги сув муаммоси келиб тушди.',
      createdAt: new Date('2026-08-23T11:30:00.000Z'),
      updatedAt: new Date('2026-08-23T11:30:00.000Z'),
      projectionUpdatedAt: new Date('2026-08-23T11:30:00.000Z'),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}&baselineTimestamp=${encodeURIComponent(baselineIso)}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as HokimTopicBoardResponse;
    const waterTopics = body.lanes.WATER!.topics;

    const oldItem = waterTopics.find((t) => t.id === topicOldId);
    expect(oldItem).toBeDefined();
    expect(oldItem?.isNew).toBe(false);
    expect(oldItem?.isUpdated).toBe(false);

    const updItem = waterTopics.find((t) => t.id === topicUpdatedId);
    expect(updItem).toBeDefined();
    expect(updItem?.isNew).toBe(false);
    expect(updItem?.isUpdated).toBe(true);

    const newItem = waterTopics.find((t) => t.id === topicNewId);
    expect(newItem).toBeDefined();
    expect(newItem?.isNew).toBe(true);
    expect(newItem?.isUpdated).toBe(false);
  });

  it('Test 4: Multi-lane topic appears in multiple lanes with identical canonical ID (AC 4)', async () => {
    const { topicId: multiLaneTopicId } = await createTopicWithProjection({
      districtId,
      mahallaName: 'Олмазор маҳалласи',
      calendarDay: testCalendarDay,
      primaryLane: 'GAS',
      lanes: ['GAS', 'HOKIM_RELATED'],
      summary: 'Газ босими пасайиши ҳокимлик назоратида.',
      isHokimRelated: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as HokimTopicBoardResponse;

    const gasItem = body.lanes.GAS!.topics.find((t) => t.id === multiLaneTopicId);
    const hokimItem = body.lanes.HOKIM_RELATED!.topics.find((t) => t.id === multiLaneTopicId);

    expect(gasItem).toBeDefined();
    expect(hokimItem).toBeDefined();
    expect(gasItem?.id).toBe(hokimItem?.id);
    expect(gasItem?.summary).toBe(hokimItem?.summary);
  });

  it('Test 5: checkProcessingDelay detects pending unprocessed intake records older than 30s (AC 6)', async () => {
    // Insert an unprocessed intake record created 45 seconds ago
    const pendingIntakeId = `intk_delay_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(telegramIntakeRecords).values({
      id: pendingIntakeId,
      districtId,
      mahallaName: 'Дўстлик маҳалласи',
      telegramBotId: 'bot_test_1',
      telegramChatId: '-100999888777',
      telegramMessageId: '999111',
      originalTimestamp: new Date(Date.now() - 45000),
      calendarDay: testCalendarDay,
      rawPayload: { text: 'Test message with delay' },
      createdAt: new Date(Date.now() - 45000),
      updatedAt: new Date(Date.now() - 45000),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/hokim/topics/board?calendarDay=${testCalendarDay}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as HokimTopicBoardResponse;
    expect(body.hasProcessingDelay).toBe(true);

    // Clean up the delayed intake record
    await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.id, pendingIntakeId));
  });
});
