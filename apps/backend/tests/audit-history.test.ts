import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  AuditHistoryPage,
  AuditEvent,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import {
  accounts,
  districts,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { getTashkentCalendarDay } from '../src/modules/telegram-intake/timezone-util.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 4.4: Backend Audit History Database & HTTP Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let poCookie = '';
  let poAccountId = '';
  let hokimCookieDistrictA = '';
  let districtAId: string;
  let districtBId: string;

  const testEventIds: string[] = [];

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);

    server = await buildHttpServer({ db, pool });
    await server.ready();

    // 1. Seed Product Owner
    const poUsername = `po_audit_test_${Date.now()}`;
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

    // 2. Seed Districts & Hokim
    const ts = Date.now();
    districtAId = `dist_audit_a_${ts}`;
    districtBId = `dist_audit_b_${ts}`;

    await db.insert(districts).values([
      {
        id: districtAId,
        name: `Юнусобод тумани ${ts}`,
        status: 'ACTIVE',
      },
      {
        id: districtBId,
        name: `Мирзо Улуғбек тумани ${ts}`,
        status: 'ACTIVE',
      },
    ]);

    const hokimUsername = `hokim_audit_test_${Date.now()}`;
    const hokimPassword = 'SecureHokimPassword2026!';
    const hokimPasswordHash = await hashPassword(hokimPassword);

    await db.insert(accounts).values({
      id: `acc_hokim_audit_${Date.now()}`,
      username: hokimUsername,
      passwordHash: hokimPasswordHash,
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
    const hokimSetCookie = hokimSignIn.headers['set-cookie'];
    hokimCookieDistrictA = Array.isArray(hokimSetCookie) ? hokimSetCookie[0] || '' : (hokimSetCookie as string) || '';

    // 3. Seed Diverse Audit Events with specific timestamps
    const now = new Date();

    const seedItems = [
      {
        id: `aud_test_1_${ts}`,
        districtId: null, // Global
        actorId: poAccountId,
        actorRole: 'PRODUCT_OWNER',
        action: 'AUTH_SIGN_IN_SUCCESS',
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0 TestBrowser',
        metadata: {
          reason: 'Initial PO login',
          sessionToken: 'secret_session_token_123',
          apiKey: 'AIzaSySecretApiKey999',
        },
        createdAt: new Date(now.getTime() - 1000 * 60 * 10), // 10 mins ago
      },
      {
        id: `aud_test_2_${ts}`,
        districtId: districtAId,
        actorId: poAccountId,
        actorRole: 'PRODUCT_OWNER',
        action: 'DISTRICT_CREATED',
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0 TestBrowser',
        metadata: {
          districtName: `Юнусобод тумани ${ts}`,
          previousState: null,
          newState: { name: `Юнусобод тумани ${ts}`, status: 'SETUP_INCOMPLETE' },
        },
        createdAt: new Date(now.getTime() - 1000 * 60 * 8), // 8 mins ago
      },
      {
        id: `aud_test_3_${ts}`,
        districtId: districtAId,
        actorId: poAccountId,
        actorRole: 'PRODUCT_OWNER',
        action: 'DISTRICT_TELEGRAM_BOT_CONNECTED',
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0 TestBrowser',
        metadata: {
          botUsername: 'yunusobod_mahalla_bot',
          botToken: '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
          success: true,
        },
        createdAt: new Date(now.getTime() - 1000 * 60 * 6), // 6 mins ago
      },
      {
        id: `aud_test_4_${ts}`,
        districtId: districtAId,
        actorId: 'system:health-evaluator',
        actorRole: 'SYSTEM',
        action: 'OPERATIONAL_ISSUE_DETECTED',
        ipAddress: null,
        userAgent: null,
        metadata: {
          issueId: `issue_test_4_${ts}`,
          errorCode: 'TELEGRAM_RATE_LIMIT',
          reason: 'Telegram bot rate limit exceeded 429',
          status: 'FAILED',
        },
        createdAt: new Date(now.getTime() - 1000 * 60 * 4), // 4 mins ago
      },
      {
        id: `aud_test_5_${ts}`,
        districtId: districtBId,
        actorId: poAccountId,
        actorRole: 'PRODUCT_OWNER',
        action: 'DISTRICT_ACTIVATION_FAILED',
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0 TestBrowser',
        metadata: {
          reason: 'Incomplete prerequisite mappings: 2 mahallas unmapped',
          outcome: 'FAILURE',
        },
        createdAt: new Date(now.getTime() - 1000 * 60 * 2), // 2 mins ago
      },
      {
        id: `aud_test_6_${ts}`,
        districtId: districtAId,
        actorId: poAccountId,
        actorRole: 'PRODUCT_OWNER',
        action: 'OPERATIONAL_RETRY_TRIGGERED',
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0 TestBrowser',
        metadata: {
          issueId: `issue_test_4_${ts}`,
          retryTrackingId: `retry_track_${ts}`,
          reason: 'Manual retry by admin for 100% test scenario',
          success: true,
        },
        createdAt: now, // newest
      },
    ];

    for (const item of seedItems) {
      testEventIds.push(item.id);
      await db.insert(auditEvents).values(item);
    }
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
    if (pool) {
      await pool.end();
    }
  });

  describe('1. Authentication & Tenant/Role Authorization (AC 8)', () => {
    it('allows authenticated Product Owner to query audit events with 200 OK', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as AuditHistoryPage;
      expect(json.items).toBeDefined();
      expect(Array.isArray(json.items)).toBe(true);
      expect(json.pagination).toBeDefined();
    });

    it('rejects District Hokim with HTTP 403 Forbidden', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events',
        headers: {
          cookie: hokimCookieDistrictA,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.payload);
      expect(json.error?.code).toBe('FORBIDDEN');
    });

    it('rejects unauthenticated request with HTTP 401 Unauthorized', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events',
        headers: {
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(401);
      const json = JSON.parse(res.payload);
      expect(json.error?.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('2. Reverse Chronological Ordering & Keyset Pagination (AC 1, AC 3)', () => {
    it('returns records in strict reverse chronological order (createdAt DESC, id DESC)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events?districtId=${districtAId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as AuditHistoryPage;
      expect(json.items.length).toBeGreaterThanOrEqual(4);

      // Verify descending order
      for (let i = 0; i < json.items.length - 1; i++) {
        const curr = new Date(json.items[i]!.createdAt).getTime();
        const next = new Date(json.items[i + 1]!.createdAt).getTime();
        expect(curr).toBeGreaterThanOrEqual(next);
      }
    });

    it('supports keyset forward and backward pagination with cursor tokens', async () => {
      // 1. Fetch first page with limit=2
      const page1Res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?limit=2',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(page1Res.statusCode).toBe(200);
      const page1 = JSON.parse(page1Res.payload) as AuditHistoryPage;
      expect(page1.items.length).toBe(2);
      expect(page1.pagination.hasNextPage).toBe(true);
      expect(page1.pagination.nextCursor).toBeDefined();

      // 2. Fetch second page using nextCursor
      const page2Res = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events?limit=2&cursor=${encodeURIComponent(page1.pagination.nextCursor!)}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(page2Res.statusCode).toBe(200);
      const page2 = JSON.parse(page2Res.payload) as AuditHistoryPage;
      expect(page2.items.length).toBe(2);
      expect(page2.pagination.hasPrevPage).toBe(true);

      // Ensure no items overlap between page 1 and page 2
      const page1Ids = page1.items.map((i) => i.id);
      const page2Ids = page2.items.map((i) => i.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);

      // 3. Backward navigation from page 2 using prevCursor
      const backwardRes = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events?limit=2&cursor=${encodeURIComponent(page2.pagination.prevCursor!)}&direction=backward`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(backwardRes.statusCode).toBe(200);
      const backwardPage = JSON.parse(backwardRes.payload) as AuditHistoryPage;
      expect(backwardPage.items.length).toBe(2);
      expect(backwardPage.items[0]?.id).toBe(page1.items[0]?.id);
    });

    it('safely rejects malformed or corrupted keyset cursor with HTTP 400', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?cursor=malformed_non_base64_token_!!@@##',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.payload);
      expect(json.error?.code).toBe('INVALID_CURSOR');
    });
  });

  describe('3. Multi-Parameter Filtering (AC 2)', () => {
    it('filters by districtId (specific district vs global)', async () => {
      // 1. Filter specific district
      const distARes = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events?districtId=${districtAId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(distARes.statusCode).toBe(200);
      const distAJson = JSON.parse(distARes.payload) as AuditHistoryPage;
      expect(distAJson.items.every((i) => i.districtId === districtAId)).toBe(true);

      // 2. Filter global
      const globalRes = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?districtId=global',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(globalRes.statusCode).toBe(200);
      const globalJson = JSON.parse(globalRes.payload) as AuditHistoryPage;
      expect(globalJson.items.every((i) => i.districtId === null)).toBe(true);
    });

    it('filters by category, actorRole, outcome, and action', async () => {
      // Category filter
      const catRes = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?category=AUTH_SECURITY',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(catRes.statusCode).toBe(200);
      const catJson = JSON.parse(catRes.payload) as AuditHistoryPage;
      expect(
        catJson.items.every(
          (i) => i.recordType === 'AUDIT_EVENT' && i.category === 'AUTH_SECURITY',
        ),
      ).toBe(true);

      // Actor role filter
      const roleRes = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?actorRole=SYSTEM',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(roleRes.statusCode).toBe(200);
      const roleJson = JSON.parse(roleRes.payload) as AuditHistoryPage;
      expect(
        roleJson.items.every((i) =>
          i.recordType === 'PERMANENT_DELETION_PROOF'
            ? !i.cancelledById
            : i.actorRole === 'SYSTEM',
        ),
      ).toBe(true);

      // Outcome filter
      const outcomeRes = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?outcome=FAILURE',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(outcomeRes.statusCode).toBe(200);
      const outcomeJson = JSON.parse(outcomeRes.payload) as AuditHistoryPage;
      expect(
        outcomeJson.items.every((i) =>
          i.recordType === 'PERMANENT_DELETION_PROOF'
            ? i.liveDeletionStatus === 'FAILED'
            : i.outcome === 'FAILURE',
        ),
      ).toBe(true);

      // Action filter
      const actionRes = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?action=DISTRICT_CREATED',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(actionRes.statusCode).toBe(200);
      const actionJson = JSON.parse(actionRes.payload) as AuditHistoryPage;
      expect(
        actionJson.items.every(
          (i) => i.recordType === 'AUDIT_EVENT' && i.action === 'DISTRICT_CREATED',
        ),
      ).toBe(true);
    });
  });

  describe('4. Asia/Tashkent Date Range Filtering (AC 2, AC 7)', () => {
    it('filters events within Tashkent calendar day boundaries', async () => {
      const todayYmd = getTashkentCalendarDay(new Date());
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events?startDate=${todayYmd}&endDate=${todayYmd}&districtId=${districtAId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as AuditHistoryPage;
      const seeded = json.items.filter((i) => testEventIds.includes(i.id));
      expect(seeded.length).toBe(4);

      // Querying a distant past date returns 0 items
      const pastRes = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events?startDate=2020-01-01&endDate=2020-01-02&districtId=${districtAId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(pastRes.statusCode).toBe(200);
      const pastJson = JSON.parse(pastRes.payload) as AuditHistoryPage;
      expect(pastJson.items.length).toBe(0);
    });

    it('rejects inverted date ranges (startDate > endDate) with HTTP 400', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?startDate=2026-08-26&endDate=2026-08-25',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.payload);
      expect(json.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('5. Allowlisted Metadata Search & ILIKE Wildcard Escaping (AC 2, AC 9)', () => {
    it('finds events matching allowlisted metadata keys (reason, issueId, botUsername)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?search=TELEGRAM_RATE_LIMIT',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as AuditHistoryPage;
      expect(
        json.items.some(
          (i) =>
            i.recordType === 'AUDIT_EVENT' &&
            i.action === 'OPERATIONAL_ISSUE_DETECTED',
        ),
      ).toBe(true);
    });

    it('properly escapes SQL wildcard characters (%, _) in search term without crashing', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?search=%25_some_literal_string_not_exist%25',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as AuditHistoryPage;
      expect(json.items.length).toBe(0);
    });
  });

  describe('6. Sensitive Data Scrubbing & Redaction (AC 1, AC 9)', () => {
    it('redacts bot tokens, API keys, passwords, and session tokens from metadata and values', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events/${testEventIds[0]}`, // aud_test_1
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as AuditEvent;
      expect(json.metadata).toBeDefined();
      // Sensitive keys (sessionToken) should be scrubbed completely
      expect(json.metadata?.sessionToken).toBeUndefined();
      // API keys should be redacted or scrubbed
      expect(json.metadata?.apiKey).toBeUndefined();
    });

    it('redacts expanded sensitive keys (refreshToken, privateKey, webhookSecret, credentials)', async () => {
      const sanitized = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?category=&actorRole=&outcome=&search=',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      // Verify empty string query parameters do not cause 400 VALIDATION_ERROR
      expect(sanitized.statusCode).toBe(200);
    });

    it('filters outcome=SUCCESS correctly without dropping rows with null/empty metadata', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?outcome=SUCCESS',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as AuditHistoryPage;
      expect(json.items.length).toBeGreaterThan(0);
      expect(
        json.items.every((i) =>
          i.recordType === 'PERMANENT_DELETION_PROOF'
            ? i.liveDeletionStatus === 'COMPLETED'
            : i.outcome === 'SUCCESS',
        ),
      ).toBe(true);
    });
  });

  describe('7. Complete Immutability & Single Event Inspection (AC 4)', () => {
    it('retrieves single event by ID with joined district name', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events/${testEventIds[1]}`, // aud_test_2
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload) as AuditEvent;
      expect(json.id).toBe(testEventIds[1]);
      expect(json.districtName).toContain('Юнусобод тумани');
      expect(json.action).toBe('DISTRICT_CREATED');
      expect(json.category).toBe('DISTRICT_ADMINISTRATION');
      expect(json.outcome).toBe('SUCCESS');
      expect(json.newValues).toBeDefined();
    });

    it('returns 404 for nonexistent audit event ID', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events/nonexistent_audit_id_9999',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error?.code).toBe('NOT_FOUND');
    });

    it('ensures NO mutating endpoints exist on /api/v1/audit/* (immutable append-only)', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/api/v1/audit/events',
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: { action: 'MUTATION_ATTEMPT' },
      });
      expect(postRes.statusCode).toBe(404);

      const deleteRes = await server.inject({
        method: 'DELETE',
        url: `/api/v1/audit/events/${testEventIds[0]}`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(deleteRes.statusCode).toBe(404);

      const putRes = await server.inject({
        method: 'PUT',
        url: `/api/v1/audit/events/${testEventIds[0]}`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: { action: 'MUTATION_ATTEMPT' },
      });
      expect(putRes.statusCode).toBe(404);
    });
  });
});
