import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import {
  accounts,
  districts,
  districtTelegramUserbotSessions,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import { getDecryptedUserbotSession } from '../src/modules/userbot-session/index.js';
import {
  resolveDistrictSessionScope,
  UnauthorizedError,
  ForbiddenError,
} from '../src/modules/userbot-session/userbot-session-routes.js';
import { DistrictNotFoundError } from '../src/modules/districts/districts-service.js';

const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

describe('Ticket 12: Userbot Session HTTP Routes Integration Tests', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;
  let poCookie: string;
  let hokimCookie: string;
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

    // Create a District Hokim account to test role authorization boundaries
    const hokimDistrictId = `dist_hokim_scope_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: hokimDistrictId,
      name: `Hokim Test District ${crypto.randomUUID()}`,
      status: 'ACTIVE',
      accessEligible: true,
    });
    const hokimUsername = `hokim_routes_${Date.now()}`;
    const hokimPassword = 'Secure-Hokim-Pass-2026!';
    const hokimPassHash = await hashPassword(hokimPassword);
    await db.insert(accounts).values({
      id: `acc_hokim_${crypto.randomUUID().slice(0, 8)}`,
      username: hokimUsername,
      passwordHash: hokimPassHash,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: hokimDistrictId,
      mustChangePassword: false,
    });

    const hokimSignInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: hokimUsername,
        password: hokimPassword,
      },
    });
    expect(hokimSignInRes.statusCode).toBe(200);
    const hokimSetCookie = hokimSignInRes.headers['set-cookie'];
    const hokimCookieHeader = Array.isArray(hokimSetCookie) ? hokimSetCookie[0] : hokimSetCookie;
    hokimCookie = hokimCookieHeader ? hokimCookieHeader.split(';')[0]! : '';
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
      expect(row?.apiHashEncrypted).toBeDefined();
      expect(row?.apiHashEncrypted).not.toBeNull();

      const decrypted = await getDecryptedUserbotSession(db, testDistrictId);
      expect(decrypted?.apiHash).toBe('test_hash_secret_value');
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
      const encHash = encryptToken('super_secret_api_hash');
      await db.insert(districtTelegramUserbotSessions).values({
        id: `dtus_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        phoneNumber: '+998901234567',
        apiId: '12345678',
        apiHashEncrypted: encHash.encryptedToken,
        apiHashIv: encHash.tokenIv,
        apiHashTag: encHash.tokenTag,
        apiHashKeyVersion: encHash.tokenKeyVersion,
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
    it('enabling a DISABLED session yields PENDING rather than ACTIVE and clears residual secrets', async () => {
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
      expect(body.session.status).toBe('PENDING');
      expect(body.session.hasSession).toBe(false);

      // Verify DB row secrets were cleared
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, testDistrictId));
      expect(row?.status).toBe('PENDING');
      expect(row?.sessionEncrypted).toBeNull();
      expect(row?.sessionIv).toBeNull();
      expect(row?.sessionTag).toBeNull();

      // Verify audit event emitted
      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, testDistrictId));
      expect(audit).toBeDefined();
      expect(audit?.action).toBe('USERBOT_SESSION_ENABLED');
      expect(audit?.metadata).toMatchObject({
        previousStatus: 'DISABLED',
        newStatus: 'PENDING',
      });
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

  // --- 5. Ticket 13: Credential Boundary Validation ---
  describe('Ticket 13: Credential Boundary Validation (HTTP Routes)', () => {
    describe('phoneNumber validation', () => {
      it('rejects short malformed phone number ("123") with 400 VALIDATION_ERROR naming phoneNumber', async () => {
        const res = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '123',
            apiId: '12345678',
          },
        });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toContain('phoneNumber');
        expect(body.error.validationErrors?.[0]?.path).toContain('phoneNumber');
      });

      it('rejects phone number missing leading plus ("998901234567") with 400 VALIDATION_ERROR naming phoneNumber', async () => {
        const res = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '998901234567',
            apiId: '12345678',
          },
        });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toContain('phoneNumber');
        expect(body.error.validationErrors?.[0]?.path).toContain('phoneNumber');
      });

      it('rejects phone number containing spaces ("+998 90 123 45 67") rather than normalizing, naming phoneNumber', async () => {
        const res = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+998 90 123 45 67',
            apiId: '12345678',
          },
        });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toContain('phoneNumber');
        expect(body.error.validationErrors?.[0]?.path).toContain('phoneNumber');
      });

      it('rejects phone number containing dashes ("+998-90-1234567") rather than normalizing, naming phoneNumber', async () => {
        const res = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+998-90-1234567',
            apiId: '12345678',
          },
        });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toContain('phoneNumber');
        expect(body.error.validationErrors?.[0]?.path).toContain('phoneNumber');
      });

      it('rejects phone number containing letters ("+abcdef") with 400 VALIDATION_ERROR naming phoneNumber', async () => {
        const res = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+abcdef',
            apiId: '12345678',
          },
        });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toContain('phoneNumber');
        expect(body.error.validationErrors?.[0]?.path).toContain('phoneNumber');
      });

      it('rejects phone number with fewer than 7 digits ("+12345") or more than 15 digits ("+1234567890123456")', async () => {
        const resShort = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+12345',
            apiId: '12345678',
          },
        });
        expect(resShort.statusCode).toBe(400);
        expect(resShort.json().error.code).toBe('VALIDATION_ERROR');
        expect(resShort.json().error.message).toContain('phoneNumber');

        const resLong = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+1234567890123456',
            apiId: '12345678',
          },
        });
        expect(resLong.statusCode).toBe(400);
        expect(resLong.json().error.code).toBe('VALIDATION_ERROR');
        expect(resLong.json().error.message).toContain('phoneNumber');
      });
    });

    describe('apiId validation', () => {
      it('rejects non-numeric API id ("abc") naming apiId', async () => {
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
            apiId: 'abc',
          },
        });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toContain('apiId');
        expect(body.error.validationErrors?.[0]?.path).toContain('apiId');
      });

      it('rejects negative API id as string ("-5") and as number (-5) naming apiId', async () => {
        const resStr = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+998901234567',
            apiId: '-5',
          },
        });
        expect(resStr.statusCode).toBe(400);
        expect(resStr.json().error.code).toBe('VALIDATION_ERROR');
        expect(resStr.json().error.message).toContain('apiId');

        const resNum = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+998901234567',
            apiId: -5,
          },
        });
        expect(resNum.statusCode).toBe(400);
        expect(resNum.json().error.code).toBe('VALIDATION_ERROR');
        expect(resNum.json().error.message).toContain('apiId');
      });

      it('rejects zero API id as string ("0") and as number (0) naming apiId', async () => {
        const resStr = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+998901234567',
            apiId: '0',
          },
        });
        expect(resStr.statusCode).toBe(400);
        expect(resStr.json().error.code).toBe('VALIDATION_ERROR');
        expect(resStr.json().error.message).toContain('apiId');

        const resNum = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+998901234567',
            apiId: 0,
          },
        });
        expect(resNum.statusCode).toBe(400);
        expect(resNum.json().error.code).toBe('VALIDATION_ERROR');
        expect(resNum.json().error.message).toContain('apiId');
      });

      it('rejects floating point API id as string ("12.34") and as number (12.34) naming apiId', async () => {
        const resStr = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+998901234567',
            apiId: '12.34',
          },
        });
        expect(resStr.statusCode).toBe(400);
        expect(resStr.json().error.code).toBe('VALIDATION_ERROR');
        expect(resStr.json().error.message).toContain('apiId');

        const resNum = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+998901234567',
            apiId: 12.34,
          },
        });
        expect(resNum.statusCode).toBe(400);
        expect(resNum.json().error.code).toBe('VALIDATION_ERROR');
        expect(resNum.json().error.message).toContain('apiId');
      });

      it('rejects API id containing spaces (" 12345 ") naming apiId', async () => {
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
            apiId: ' 12345 ',
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
        expect(res.json().error.message).toContain('apiId');
      });

      it('accepts API id supplied as a numeric JSON value when it parses as a positive integer', async () => {
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
            apiId: 12345678,
          },
        });

        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.session.apiId).toBe('12345678');
      });
    });

    describe('apiHash validation', () => {
      it('treats whitespace-only API hash as absent rather than storing non-empty value', async () => {
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
            apiHash: '   ',
          },
        });

        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.session).toBeDefined();

        // Verify DB row has null encrypted apiHash
        const [row] = await db
          .select()
          .from(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, testDistrictId));
        expect(row?.apiHashEncrypted).toBeNull();

        const decrypted = await getDecryptedUserbotSession(db, testDistrictId);
        expect(decrypted?.apiHash).toBeNull();
      });

      it('accepts non-empty API hash matching no expected pattern (non-emptiness check, not pattern match)', async () => {
        const unusualHash = 'unusual_non_hex_custom_hash_xyz_123';
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
            apiHash: unusualHash,
          },
        });

        expect(res.statusCode).toBe(201);

        const decrypted = await getDecryptedUserbotSession(db, testDistrictId);
        expect(decrypted?.apiHash).toBe(unusualHash);
      });

      it('rejects invalid API hash type (e.g. number) with 400 VALIDATION_ERROR naming apiHash', async () => {
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
            apiHash: 12345,
          },
        });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.message).toContain('apiHash');
      });
    });

    describe('valid credential set acceptance', () => {
      it('accepts valid credential set: integer positive API id, international-format phone, non-empty hash', async () => {
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
            apiId: '87654321',
            apiHash: 'my_application_api_hash_val_999',
          },
        });

        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.session.status).toBe('PENDING');
        expect(body.session.phoneNumber).toBe('+998901234567');
        expect(body.session.apiId).toBe('87654321');
      });
    });
  });

  // --- 6. Ticket 19: District Scoping, Zero-Leakage & Product Owner Entitlement ---
  describe('Ticket 19: District Scoping, Information Leakage Prevention & Product Owner Entitlement', () => {
    describe('Product Owner Entitlement Invariant', () => {
      it('allows a Product Owner to manage userbot sessions across multiple distinct districts', async () => {
        // District A
        const resA = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+998901111111',
            apiId: '11111111',
          },
        });
        expect(resA.statusCode).toBe(201);
        expect(resA.json().session.districtId).toBe(testDistrictId);

        // District B
        const secondDistrictId = `dist_po_second_${crypto.randomUUID().slice(0, 8)}`;
        await db.insert(districts).values({
          id: secondDistrictId,
          name: `Second District ${crypto.randomUUID()}`,
          status: 'ACTIVE',
          accessEligible: true,
        });

        const resB = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${secondDistrictId}/userbot-session`,
          headers: {
            ...SAME_ORIGIN_HEADERS,
            cookie: poCookie,
            'content-type': 'application/json',
          },
          payload: {
            phoneNumber: '+998902222222',
            apiId: '22222222',
          },
        });
        expect(resB.statusCode).toBe(201);
        expect(resB.json().session.districtId).toBe(secondDistrictId);

        // GET across both districts
        const getA = await server.inject({
          method: 'GET',
          url: `/api/v1/districts/${testDistrictId}/userbot-session`,
          headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        });
        expect(getA.statusCode).toBe(200);
        expect(getA.json().session.phoneNumber).toBe('+998901111111');

        const getB = await server.inject({
          method: 'GET',
          url: `/api/v1/districts/${secondDistrictId}/userbot-session`,
          headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        });
        expect(getB.statusCode).toBe(200);
        expect(getB.json().session.phoneNumber).toBe('+998902222222');

        // Disable and Enable on District B
        const disableB = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${secondDistrictId}/userbot-session/disable`,
          headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        });
        expect(disableB.statusCode).toBe(200);
        expect(disableB.json().session.status).toBe('DISABLED');

        const enableB = await server.inject({
          method: 'POST',
          url: `/api/v1/districts/${secondDistrictId}/userbot-session/enable`,
          headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        });
        expect(enableB.statusCode).toBe(200);
        expect(enableB.json().session.status).toBe('PENDING');
      });
    });

    describe('Information Leakage Prevention: Auth Evaluated Before District Existence', () => {
      const nonExistentDistrictId = `dist_nonexistent_${crypto.randomUUID()}`;

      describe('POST /api/v1/districts/:districtId/userbot-session', () => {
        it('returns 401 UNAUTHENTICATED without cookie before district existence is probed', async () => {
          const res = await server.inject({
            method: 'POST',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session`,
            headers: { ...SAME_ORIGIN_HEADERS, 'content-type': 'application/json' },
            payload: { phoneNumber: '+998901234567', apiId: '12345678' },
          });
          expect(res.statusCode).toBe(401);
          expect(res.json().error.code).toBe('UNAUTHENTICATED');
        });

        it('returns 403 FORBIDDEN for non-PO (Hokim) before district existence is probed', async () => {
          const res = await server.inject({
            method: 'POST',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session`,
            headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie, 'content-type': 'application/json' },
            payload: { phoneNumber: '+998901234567', apiId: '12345678' },
          });
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('FORBIDDEN');
        });

        it('returns 404 DISTRICT_NOT_FOUND only after valid PO authentication succeeds', async () => {
          const res = await server.inject({
            method: 'POST',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session`,
            headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie, 'content-type': 'application/json' },
            payload: { phoneNumber: '+998901234567', apiId: '12345678' },
          });
          expect(res.statusCode).toBe(404);
          expect(res.json().error.code).toBe('DISTRICT_NOT_FOUND');
        });
      });

      describe('GET /api/v1/districts/:districtId/userbot-session', () => {
        it('returns 401 UNAUTHENTICATED without cookie before district existence is probed', async () => {
          const res = await server.inject({
            method: 'GET',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session`,
            headers: SAME_ORIGIN_HEADERS,
          });
          expect(res.statusCode).toBe(401);
          expect(res.json().error.code).toBe('UNAUTHENTICATED');
        });

        it('returns 403 FORBIDDEN for non-PO (Hokim) before district existence is probed', async () => {
          const res = await server.inject({
            method: 'GET',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session`,
            headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
          });
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('FORBIDDEN');
        });

        it('returns 404 DISTRICT_NOT_FOUND only after valid PO authentication succeeds', async () => {
          const res = await server.inject({
            method: 'GET',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session`,
            headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
          });
          expect(res.statusCode).toBe(404);
          expect(res.json().error.code).toBe('DISTRICT_NOT_FOUND');
        });
      });

      describe('POST /api/v1/districts/:districtId/userbot-session/disable', () => {
        it('returns 401 UNAUTHENTICATED without cookie before district existence is probed', async () => {
          const res = await server.inject({
            method: 'POST',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session/disable`,
            headers: SAME_ORIGIN_HEADERS,
          });
          expect(res.statusCode).toBe(401);
          expect(res.json().error.code).toBe('UNAUTHENTICATED');
        });

        it('returns 403 FORBIDDEN for non-PO (Hokim) before district existence is probed', async () => {
          const res = await server.inject({
            method: 'POST',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session/disable`,
            headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
          });
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('FORBIDDEN');
        });

        it('returns 404 DISTRICT_NOT_FOUND only after valid PO authentication succeeds', async () => {
          const res = await server.inject({
            method: 'POST',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session/disable`,
            headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
          });
          expect(res.statusCode).toBe(404);
          expect(res.json().error.code).toBe('DISTRICT_NOT_FOUND');
        });
      });

      describe('POST /api/v1/districts/:districtId/userbot-session/enable', () => {
        it('returns 401 UNAUTHENTICATED without cookie before district existence is probed', async () => {
          const res = await server.inject({
            method: 'POST',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session/enable`,
            headers: SAME_ORIGIN_HEADERS,
          });
          expect(res.statusCode).toBe(401);
          expect(res.json().error.code).toBe('UNAUTHENTICATED');
        });

        it('returns 403 FORBIDDEN for non-PO (Hokim) before district existence is probed', async () => {
          const res = await server.inject({
            method: 'POST',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session/enable`,
            headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
          });
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('FORBIDDEN');
        });

        it('returns 404 DISTRICT_NOT_FOUND only after valid PO authentication succeeds', async () => {
          const res = await server.inject({
            method: 'POST',
            url: `/api/v1/districts/${nonExistentDistrictId}/userbot-session/enable`,
            headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
          });
          expect(res.statusCode).toBe(404);
          expect(res.json().error.code).toBe('DISTRICT_NOT_FOUND');
        });
      });
    });

    describe('resolveDistrictSessionScope Helper Unit Semantics', () => {
      it('throws UnauthorizedError when req.actor is missing', async () => {
        const mockReq = { actor: undefined, params: { districtId: testDistrictId } } as any;
        await expect(resolveDistrictSessionScope(db, mockReq)).rejects.toThrow(UnauthorizedError);
      });

      it('throws ForbiddenError when req.actor.role is not PRODUCT_OWNER', async () => {
        const mockReq = {
          actor: { id: 'hokim_1', role: 'DISTRICT_HOKIM', districtId: testDistrictId },
          params: { districtId: testDistrictId },
        } as any;
        await expect(resolveDistrictSessionScope(db, mockReq)).rejects.toThrow(ForbiddenError);
      });

      it('throws DistrictNotFoundError when districtId param is missing or empty', async () => {
        const mockReq = {
          actor: { id: 'po_1', role: 'PRODUCT_OWNER' },
          params: { districtId: '   ' },
        } as any;
        await expect(resolveDistrictSessionScope(db, mockReq)).rejects.toThrow(DistrictNotFoundError);
      });

      it('throws DistrictNotFoundError when districtId does not exist in DB', async () => {
        const mockReq = {
          actor: { id: 'po_1', role: 'PRODUCT_OWNER' },
          params: { districtId: 'dist_unknown_99999' },
        } as any;
        await expect(resolveDistrictSessionScope(db, mockReq)).rejects.toThrow(DistrictNotFoundError);
      });

      it('resolves districtId and district entity when authenticated PO requests existing district', async () => {
        const mockReq = {
          actor: { id: 'po_1', role: 'PRODUCT_OWNER' },
          params: { districtId: testDistrictId },
        } as any;
        const result = await resolveDistrictSessionScope(db, mockReq);
        expect(result.districtId).toBe(testDistrictId);
        expect(result.district.id).toBe(testDistrictId);
      });
    });
  });
});
