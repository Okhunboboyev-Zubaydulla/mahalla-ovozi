import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { eq, inArray, and } from 'drizzle-orm';
import type {
  ListArchivedMahallasResponse,
  DeleteArchivedMahallaResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import {
  accounts,
  districts,
  topics,
  topicProjections,
  acceptedEvidence,
  telegramIntakeRecords,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { getTashkentCalendarDay } from '../src/modules/telegram-intake/timezone-util.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Integration Tests: Archived Mahallas Administration & Permanent Topic Deletion', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let poCookie = '';
  let poAccountId = '';
  let hokimCookie = '';

  let district1Id: string;
  let district2Id: string;

  let topicArchived1Id: string;
  let topicArchived2Id: string;
  let topicActiveId: string;

  let evidence1Id: string;
  let evidence2Id: string;
  let projection1Id: string;
  let intake1Id: string;

  const testCalendarDay = getTashkentCalendarDay(Math.floor(Date.now() / 1000));

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    await ensureDefaultAiProfiles(db);
    const profile = await db.query.aiProfiles.findFirst();
    const defaultAiProfileId = profile!.id;

    const ts = Date.now();

    // 1. Seed Product Owner
    const poUsername = `po_arch_test_${ts}`;
    const poPassword = 'SecurePOPassword2026!';
    const poAccount = await createOrResetProductOwner(db, {
      username: poUsername,
      password: poPassword,
    });
    poAccountId = poAccount.accountId;

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
    district1Id = `dist_arch_1_${ts}`;
    district2Id = `dist_arch_2_${ts}`;

    await db.insert(districts).values([
      {
        id: district1Id,
        name: `Алмазор тумани ${ts}`,
        region: 'Тошкент шаҳри',
        status: 'ACTIVE',
      },
      {
        id: district2Id,
        name: `Бектемир тумани ${ts}`,
        region: 'Тошкент шаҳри',
        status: 'ACTIVE',
      },
    ]);

    // 3. Seed District Hokim Account (assigned to district1)
    const hokimUsername = `hokim_arch_test_${ts}`;
    const hokimPassword = 'SecureHokimPassword2026!';
    const hokimHash = await hashPassword(hokimPassword);

    await db.insert(accounts).values({
      id: `acc_hokim_arch_${ts}`,
      username: hokimUsername,
      passwordHash: hokimHash,
      role: 'DISTRICT_HOKIM',
      districtId: district1Id,
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

    // 4. Seed Archived Topic 1 (District 1, Mahalla 'Қўштут', with intake, 2 evidence, 1 projection)
    topicArchived1Id = `top_arch_1_${ts}`;
    intake1Id = `tir_arch_1_${ts}`;
    evidence1Id = `ae_arch_1_1_${ts}`;
    evidence2Id = `ae_arch_1_2_${ts}`;
    projection1Id = `tp_arch_1_${ts}`;

    const now = new Date();
    const ninetyDaysFuture = new Date(now.getTime() + 90 * 86400 * 1000);

    await db.insert(telegramIntakeRecords).values({
      id: intake1Id,
      districtId: district1Id,
      mahallaName: 'Қўштут',
      telegramBotId: `bot_arch_${ts}`,
      telegramMessageId: '1001',
      telegramChatId: '-1001234567890',
      calendarDay: testCalendarDay,
      originalTimestamp: new Date(now.getTime() - 7200 * 1000),
      rawPayload: { text: 'Биринчи архивланган мурожаат' },
    });

    await db.insert(topics).values({
      id: topicArchived1Id,
      districtId: district1Id,
      mahallaName: 'Қўштут',
      calendarDay: testCalendarDay,
      primaryLane: 'WATER',
      status: 'ARCHIVED',
      latestRelevantEvidenceTimestamp: new Date(now.getTime() - 3600 * 1000),
      retentionExpiresAt: ninetyDaysFuture,
      updatedAt: new Date(now.getTime() - 1800 * 1000),
    });

    await db.insert(acceptedEvidence).values([
      {
        id: evidence1Id,
        topicId: topicArchived1Id,
        intakeRecordId: intake1Id,
        districtId: district1Id,
        mahallaName: 'Қўштут',
        calendarDay: testCalendarDay,
        verbatimText: 'Ичимлик суви таъминоти узилган.',
        contentType: 'TEXT',
        originalTimestamp: new Date(now.getTime() - 7200 * 1000),
        telegramChatId: '-1001234567890',
        telegramMessageId: '1001',
      },
      {
        id: evidence2Id,
        topicId: topicArchived1Id,
        intakeRecordId: intake1Id,
        districtId: district1Id,
        mahallaName: 'Қўштут',
        calendarDay: testCalendarDay,
        verbatimText: 'Сув босими ҳали ҳам паст.',
        contentType: 'TEXT',
        originalTimestamp: new Date(now.getTime() - 3600 * 1000),
        telegramChatId: '-1001234567890',
        telegramMessageId: '1002',
      },
    ]);

    await db.insert(topicProjections).values({
      id: projection1Id,
      topicId: topicArchived1Id,
      districtId: district1Id,
      mahallaName: 'Қўштут',
      calendarDay: testCalendarDay,
      summary: 'Қўштут маҳалласида сув таъминоти муаммоси',
      lanes: ['WATER'],
      primaryLane: 'WATER',
      isHokimRelated: false,
      anchorQuote: 'Ичимлик суви таъминоти узилган',
      anchorEvidenceId: evidence1Id,
      latestMeaningfulActivityTimestamp: new Date(now.getTime() - 3600 * 1000),
      attribution: '2 та далил асосида',
      generation: 1,
      aiProfileId: defaultAiProfileId,
    });

    // 5. Seed Archived Topic 2 (District 2, Mahalla 'Чилонзор-1', 0 evidence, 0 projections)
    topicArchived2Id = `top_arch_2_${ts}`;
    await db.insert(topics).values({
      id: topicArchived2Id,
      districtId: district2Id,
      mahallaName: 'Чилонзор-1',
      calendarDay: testCalendarDay,
      primaryLane: 'ELECTRICITY',
      status: 'ARCHIVED',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: ninetyDaysFuture,
      updatedAt: now,
    });

    // 6. Seed ACTIVE Topic (District 1, Mahalla 'Гулистон', must NOT appear in archived list)
    topicActiveId = `top_act_1_${ts}`;
    await db.insert(topics).values({
      id: topicActiveId,
      districtId: district1Id,
      mahallaName: 'Гулистон',
      calendarDay: testCalendarDay,
      primaryLane: 'WASTE',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: ninetyDaysFuture,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    try {
      // Clean up test data in reverse FK order
      await db.delete(topicProjections).where(
        inArray(topicProjections.districtId, [district1Id, district2Id]),
      );
      await db.delete(acceptedEvidence).where(
        inArray(acceptedEvidence.districtId, [district1Id, district2Id]),
      );
      await db.delete(topics).where(
        inArray(topics.districtId, [district1Id, district2Id]),
      );
      await db.delete(telegramIntakeRecords).where(
        inArray(telegramIntakeRecords.districtId, [district1Id, district2Id]),
      );
      await db.delete(auditEvents).where(
        inArray(auditEvents.districtId, [district1Id, district2Id]),
      );
      await db.delete(accounts).where(
        inArray(accounts.id, [poAccountId, `acc_hokim_arch_${district1Id.replace('dist_arch_1_', '')}`]),
      );
      await db.delete(districts).where(
        inArray(districts.id, [district1Id, district2Id]),
      );
    } catch {
      // Ignore cleanup error if already removed
    }

    if (server) {
      await server.close();
    }
    if (pool) {
      await pool.end();
    }
  });

  // ── 1. Authentication & Role Boundaries ──
  describe('1. Authentication & Role Boundaries', () => {
    it('rejects unauthenticated GET /api/v1/admin/archived-mahallas with HTTP 401', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/archived-mahallas',
        headers: { ...SAME_ORIGIN_HEADERS },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects unauthenticated DELETE /api/v1/admin/archived-mahallas/:topicId with HTTP 401', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/v1/admin/archived-mahallas/${topicArchived1Id}`,
        headers: {
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { confirmMahallaName: 'Қўштут' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects DISTRICT_HOKIM on GET /api/v1/admin/archived-mahallas with HTTP 403', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/archived-mahallas',
        headers: {
          cookie: hokimCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects DISTRICT_HOKIM on DELETE /api/v1/admin/archived-mahallas/:topicId with HTTP 403', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/v1/admin/archived-mahallas/${topicArchived1Id}`,
        headers: {
          cookie: hokimCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { confirmMahallaName: 'Қўштут' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('FORBIDDEN');
    });
  });

  // ── 2. List Archived Mahallas & Aggregations ──
  describe('2. List Archived Mahallas Query & Aggregations', () => {
    it('returns 200 with aggregated archived mahallas and child counts', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/archived-mahallas',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as ListArchivedMahallasResponse;
      expect(Array.isArray(body.items)).toBe(true);

      // Verify topicArchived1 is present with accurate child counts
      const item1 = body.items.find((i) => i.topicId === topicArchived1Id);
      expect(item1).toBeDefined();
      expect(item1?.districtId).toBe(district1Id);
      expect(item1?.mahallaName).toBe('Қўштут');
      expect(item1?.evidenceCount).toBe(2);
      expect(item1?.projectionCount).toBe(1);
      expect(item1?.archivedAt).toBeTruthy();

      // Verify topicArchived2 is present with 0 counts
      const item2 = body.items.find((i) => i.topicId === topicArchived2Id);
      expect(item2).toBeDefined();
      expect(item2?.districtId).toBe(district2Id);
      expect(item2?.mahallaName).toBe('Чилонзор-1');
      expect(item2?.evidenceCount).toBe(0);
      expect(item2?.projectionCount).toBe(0);

      // Verify ACTIVE topics are excluded
      const activeItem = body.items.find((i) => i.topicId === topicActiveId);
      expect(activeItem).toBeUndefined();
    });
  });

  // ── 3. Permanent Deletion Guards & Validation ──
  describe('3. Permanent Deletion Guards & Validation Errors', () => {
    it('returns HTTP 404 if topicId does not exist', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: '/api/v1/admin/archived-mahallas/non_existent_topic_999999',
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { confirmMahallaName: 'Қўштут' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('ARCHIVED_MAHALLA_NOT_FOUND');
    });

    it('returns HTTP 409 if topic is ACTIVE (not archived)', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/v1/admin/archived-mahallas/${topicActiveId}`,
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { confirmMahallaName: 'Гулистон' },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('ARCHIVED_MAHALLA_NOT_ARCHIVED');

      // Verify active topic still exists in the database
      const [persistedActive] = await db
        .select()
        .from(topics)
        .where(eq(topics.id, topicActiveId))
        .limit(1);
      expect(persistedActive).toBeDefined();
    });

    it('returns HTTP 400 if confirmation mahalla name does not match', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/v1/admin/archived-mahallas/${topicArchived1Id}`,
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { confirmMahallaName: 'Нотўғри Маҳалла Номи' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('ARCHIVED_MAHALLA_CONFIRMATION_MISMATCH');

      // Verify archived topic and children are preserved
      const [persistedTopic] = await db
        .select()
        .from(topics)
        .where(eq(topics.id, topicArchived1Id))
        .limit(1);
      expect(persistedTopic).toBeDefined();
    });

    it('returns HTTP 400 if confirmMahallaName payload is missing or empty', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/v1/admin/archived-mahallas/${topicArchived1Id}`,
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { confirmMahallaName: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ── 4. Permanent Deletion Execution, Cascade & Audit Trail ──
  describe('4. Permanent Deletion Execution, Cascade & Audit Trail', () => {
    it('permanently deletes archived topic, removes child records, and writes audit event', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/v1/admin/archived-mahallas/${topicArchived1Id}`,
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { confirmMahallaName: 'Қўштут' },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as DeleteArchivedMahallaResponse;
      expect(data.topicId).toBe(topicArchived1Id);
      expect(data.deleted).toBe(true);
      expect(data.counts.topicDeletedCount).toBe(1);
      expect(data.counts.evidenceCount).toBe(2);
      expect(data.counts.projectionsCount).toBe(1);
      expect(data.counts.intakeRecordsCount).toBe(1);

      // Verify DB state: topic is gone
      const [topicRow] = await db
        .select()
        .from(topics)
        .where(eq(topics.id, topicArchived1Id))
        .limit(1);
      expect(topicRow).toBeUndefined();

      // Verify DB state: accepted_evidence rows are gone
      const evidenceRows = await db
        .select()
        .from(acceptedEvidence)
        .where(eq(acceptedEvidence.topicId, topicArchived1Id));
      expect(evidenceRows.length).toBe(0);

      // Verify DB state: topic_projections row is gone
      const projectionRows = await db
        .select()
        .from(topicProjections)
        .where(eq(topicProjections.topicId, topicArchived1Id));
      expect(projectionRows.length).toBe(0);

      // Verify DB state: telegram_intake_records row is gone
      const intakeRows = await db
        .select()
        .from(telegramIntakeRecords)
        .where(eq(telegramIntakeRecords.id, intake1Id));
      expect(intakeRows.length).toBe(0);

      // Verify GET /api/v1/admin/archived-mahallas no longer returns deleted topic
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/archived-mahallas',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = JSON.parse(listRes.payload) as ListArchivedMahallasResponse;
      expect(listBody.items.some((i) => i.topicId === topicArchived1Id)).toBe(false);
      // Other archived topics remain untouched
      expect(listBody.items.some((i) => i.topicId === topicArchived2Id)).toBe(true);

      // Verify Audit Event was recorded
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.districtId, district1Id),
            eq(auditEvents.action, 'ARCHIVED_MAHALLA_DELETED'),
          ),
        )
        .limit(1);

      expect(auditEvent).toBeDefined();
      if (!auditEvent) {
        throw new Error('Expected audit event to be defined');
      }
      expect(auditEvent.action).toBe('ARCHIVED_MAHALLA_DELETED');
      expect(auditEvent.actorId).toBe(poAccountId);
      expect(auditEvent.actorRole).toBe('PRODUCT_OWNER');
      expect((auditEvent.metadata as Record<string, unknown>).topicId).toBe(topicArchived1Id);
      expect((auditEvent.metadata as Record<string, unknown>).mahallaName).toBe('Қўштут');
    });

    it('returns HTTP 404 on attempting to delete the already deleted archived topic', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/v1/admin/archived-mahallas/${topicArchived1Id}`,
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { confirmMahallaName: 'Қўштут' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('ARCHIVED_MAHALLA_NOT_FOUND');
    });
  });
});
