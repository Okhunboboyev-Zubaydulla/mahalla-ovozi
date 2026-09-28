import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import {
  districts,
  districtTelegramUserbotSessions,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';

const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

describe('Ticket 12: Userbot Session HTTP Routes Integration Tests', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;
  let poCookie: string;
  let testDistrictId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    const testUsername = `po_userbot_${Date.now()}`;
    const testPassword = 'Secure-Userbot-Pass-2026!';

    await createOrResetProductOwner(db, {
      username: testUsername,
      password: testPassword,
    });

    const signInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: testUsername,
        password: testPassword,
      },
    });
    expect(signInRes.statusCode).toBe(200);
    const setCookie = signInRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    poCookie = cookieHeader ? cookieHeader.split(';')[0]! : '';
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  beforeEach(async () => {
    testDistrictId = `dist_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: testDistrictId,
      name: `Test District Userbot ${crypto.randomUUID().slice(0, 6)}`,
      status: 'ACTIVE',
      accessEligible: true,
    });
  });

  // --- 1. POST /api/v1/districts/:districtId/userbot-session ---
  describe('POST /api/v1/districts/:districtId/userbot-session', () => {
    it('creates a userbot session with PENDING status and returns public DTO without secrets', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
          'content-type': 'application/json',
        },
        payload: {
          phoneNumber: '+998901234567',
          apiId: '12345678',
          apiHash: 'test_hash_secret_value',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.session).toBeDefined();
      expect(body.session.districtId).toBe(testDistrictId);
      expect(body.session.phoneNumber).toBe('+998901234567');
      expect(body.session.apiId).toBe('12345678');
      expect(body.session.status).toBe('PENDING');
      expect(body.session.hasSession).toBe(false);
      expect(body.session.lastSeenAt).toBeNull();
      expect(body.session.createdAt).toBeDefined();
      expect(body.session.updatedAt).toBeDefined();

      // Ensure NO secrets are leaked in response
      expect(body.session.apiHash).toBeUndefined();
      expect(body.session.sessionEncrypted).toBeUndefined();
      expect(body.session.sessionIv).toBeUndefined();
      expect(body.session.sessionTag).toBeUndefined();
      expect(body.session.sessionKeyVersion).toBeUndefined();

      // Verify DB persistence
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, testDistrictId));
      expect(row).toBeDefined();
      expect(row?.phoneNumber).toBe('+998901234567');
      expect(row?.apiId).toBe('12345678');
      expect(row?.apiHash).toBe('test_hash_secret_value');
    });

    it('rejects creation when required fields are missing with 400 VALIDATION_ERROR', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
          'content-type': 'application/json',
        },
        payload: {
          phoneNumber: '',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects duplicate session for the same district with 409 CONFLICT', async () => {
      // First session
      await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
          'content-type': 'application/json',
        },
        payload: {
          phoneNumber: '+998901234567',
          apiId: '12345678',
        },
      });

      // Second session
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
          'content-type': 'application/json',
        },
        payload: {
          phoneNumber: '+998909998877',
          apiId: '87654321',
        },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe('CONFLICT');
    });

    it('rejects creation for non-existent district with 404 DISTRICT_NOT_FOUND', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/districts/dist_nonexistent_123/userbot-session',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
          'content-type': 'application/json',
        },
        payload: {
          phoneNumber: '+998901234567',
          apiId: '12345678',
        },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error.code).toBe('DISTRICT_NOT_FOUND');
    });

    it('rejects unauthorized request without cookie with 401', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          'content-type': 'application/json',
        },
        payload: {
          phoneNumber: '+998901234567',
          apiId: '12345678',
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // --- 2. GET /api/v1/districts/:districtId/userbot-session ---
  describe('GET /api/v1/districts/:districtId/userbot-session', () => {
    it('returns null session when district has no session', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/userbot-session`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session).toBeNull();
    });

    it('returns public session without secrets when session exists', async () => {
      const enc = encryptToken('1BVtsOIUbuw...');
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '12345678',
        apiHash: 'super_secret_api_hash',
        sessionEncrypted: enc.encryptedToken,
        sessionIv: enc.tokenIv,
        sessionTag: enc.tokenTag,
        sessionKeyVersion: enc.tokenKeyVersion,
        status: 'ACTIVE',
      });

      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/userbot-session`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session).toBeDefined();
      expect(body.session.districtId).toBe(testDistrictId);
      expect(body.session.phoneNumber).toBe('+998901234567');
      expect(body.session.status).toBe('ACTIVE');
      expect(body.session.hasSession).toBe(true);

      // Verify secrets are strictly omitted
      expect(body.session.apiHash).toBeUndefined();
      expect(body.session.sessionEncrypted).toBeUndefined();
      expect(body.session.sessionIv).toBeUndefined();
      expect(body.session.sessionTag).toBeUndefined();
    });
  });

  // --- 3. POST /api/v1/districts/:districtId/userbot-session/disable ---
  describe('POST /api/v1/districts/:districtId/userbot-session/disable', () => {
    it('disables session and emits audit event', async () => {
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '12345678',
        status: 'ACTIVE',
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session/disable`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.status).toBe('DISABLED');

      // Verify audit event emitted
      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, testDistrictId));
      expect(audit).toBeDefined();
      expect(audit?.action).toBe('USERBOT_SESSION_DISABLED');
    });

    it('returns 404 USERBOT_SESSION_NOT_FOUND if session does not exist', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session/disable`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error.code).toBe('USERBOT_SESSION_NOT_FOUND');
    });

    it('returns 409 USERBOT_SESSION_BANNED if session is BANNED', async () => {
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '12345678',
        status: 'BANNED',
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session/disable`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe('USERBOT_SESSION_BANNED');
    });
  });

  // --- 4. POST /api/v1/districts/:districtId/userbot-session/enable ---
  describe('POST /api/v1/districts/:districtId/userbot-session/enable', () => {
    it('re-enables a DISABLED session back to ACTIVE when session token exists', async () => {
      const enc = encryptToken('1BVtsOIUbuw...');
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '12345678',
        sessionEncrypted: enc.encryptedToken,
        sessionIv: enc.tokenIv,
        sessionTag: enc.tokenTag,
        status: 'DISABLED',
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session/enable`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.status).toBe('ACTIVE');

      // Verify audit event emitted
      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, testDistrictId));
      expect(audit).toBeDefined();
      expect(audit?.action).toBe('USERBOT_SESSION_ENABLED');
    });

    it('re-enables a DISABLED session to PENDING when no session token exists', async () => {
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '12345678',
        status: 'DISABLED',
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session/enable`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.status).toBe('PENDING');
    });

    it('returns 404 USERBOT_SESSION_NOT_FOUND if session does not exist', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session/enable`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error.code).toBe('USERBOT_SESSION_NOT_FOUND');
    });

    it('returns 409 USERBOT_SESSION_BANNED if session is BANNED', async () => {
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '12345678',
        status: 'BANNED',
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/userbot-session/enable`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: poCookie,
        },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe('USERBOT_SESSION_BANNED');
    });
  });
});
