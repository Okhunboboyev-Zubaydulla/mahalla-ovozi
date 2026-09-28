import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { sessions, auditEvents, accounts, districts } from '../src/adapters/db/schema/index.js';
import { COOKIE_NAME, hashSessionToken, validateAndTouchSession, createSession } from '../src/modules/auth/session-manager.js';
import { SessionResponseSchema } from '@mahalla-ovozi/api-contracts';
import { eq } from 'drizzle-orm';
import pg from 'pg';

// Simulate a same-origin browser request — all state-changing requests must pass the B3 origin guard.
const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

describe('Auth Module, Session Engine & Threat Defenses Integration Tests', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;

  const testUsername = `po_auth_${Date.now()}`;
  const testPassword = 'Secure-PO-Password-2026-Test!';
  const newPassword = 'New-Secure-PO-Password-2026!';

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    // Provision Product Owner account
    await createOrResetProductOwner(db, {
      username: testUsername,
      password: testPassword,
    });
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  describe('Sign In (POST /api/v1/auth/sign-in)', () => {
    it('successfully signs in with valid credentials, sets cookie, and records audit', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username: testUsername,
          password: testPassword,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.actor.username).toBe(testUsername);
      expect(body.actor.role).toBe('PRODUCT_OWNER');
      expect(body.session.expiresAt).toBeDefined();

      // Check Set-Cookie header
      const setCookie = response.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(typeof setCookie === 'string' ? setCookie : setCookie?.[0]).toContain(COOKIE_NAME);
      expect(typeof setCookie === 'string' ? setCookie : setCookie?.[0]).toContain('HttpOnly');
      expect(typeof setCookie === 'string' ? setCookie : setCookie?.[0]).toContain('SameSite=Strict');

      // Verify audit event
      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'AUTH_SIGN_IN_SUCCESS'))
        .limit(1);

      expect(audit).toBeDefined();
      expect(audit?.metadata).not.toHaveProperty('password');
      expect(audit?.metadata).not.toHaveProperty('passwordHash');
    });

    it('rejects invalid credentials with generic Uzbek Cyrillic error', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username: testUsername,
          password: 'Wrong-Password-Attempt-123!',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
      expect(body.error.message).toBe('Нотўғри фойдаланувчи номи ёки парол.');
    });

    it('rejects non-existent user with identical generic error', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username: `non_existent_${Date.now()}`,
          password: 'Some-Random-Password-123!',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
      expect(body.error.message).toBe('Нотўғри фойдаланувчи номи ёки парол.');
    });
  });

  describe('Rate Limiting on Failed Attempts', () => {
    it('enforces lockout after 5 consecutive failed attempts', async () => {
      const attackUser = `attack_target_${Date.now()}`;
      // 5 failed attempts
      for (let i = 0; i < 5; i++) {
        const res = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/sign-in',
          headers: SAME_ORIGIN_HEADERS,
          payload: {
            username: attackUser,
            password: 'Bad-Password-Attempt-123!',
          },
        });
        expect(res.statusCode).toBe(401);
      }

      // 6th attempt must be rate-limited
      const lockedResponse = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username: attackUser,
          password: 'Bad-Password-Attempt-123!',
        },
      });

      expect(lockedResponse.statusCode).toBe(429);
      expect(lockedResponse.headers['retry-after']).toBeDefined();
      const body = lockedResponse.json();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.message).toBe('Уринишлар сони ошди. Илтимос, кейинроқ қайта уриниб кўринг.');
    });
  });

  describe('Origin & Cross-Site Defenses', () => {
    it('rejects Sec-Fetch-Site: cross-site before credential check', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: {
          'sec-fetch-site': 'cross-site',
        },
        payload: {
          username: testUsername,
          password: testPassword,
        },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('rejects disallowed external Origin on state-changing request', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: {
          origin: 'https://malicious-attacker-site.com',
          host: 'mahalla-ovozi.uz',
        },
        payload: {
          username: testUsername,
          password: testPassword,
        },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe('FORBIDDEN_ORIGIN');
    });
  });

  describe('Session Lifecycle & Invalidation', () => {
    let sessionCookie: string;

    it('authorizes authenticated requests via cookie', async () => {
      const loginRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username: testUsername,
          password: testPassword,
        },
      });

      const setCookie = loginRes.headers['set-cookie'];
      const rawCookie = typeof setCookie === 'string' ? setCookie : setCookie?.[0];
      const match = rawCookie?.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
      sessionCookie = match ? match[1]! : '';
      expect(sessionCookie).toBeTruthy();

      const sessionRes = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        cookies: {
          [COOKIE_NAME]: sessionCookie,
        },
      });

      expect(sessionRes.statusCode).toBe(200);
      const body = sessionRes.json();
      const parseResult = SessionResponseSchema.safeParse(body);
      expect(parseResult.success).toBe(true);
      expect(body.actor.username).toBe(testUsername);
      expect(body.session).toBeDefined();
      expect(typeof body.session.expiresAt).toBe('string');
    });

    it('rejects session after 12 hours of idle inactivity', async () => {
      // Simulate 13 hours of idle inactivity for this specific session in database
      const tokenHash = hashSessionToken(sessionCookie);
      const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
      await db
        .update(sessions)
        .set({ lastActiveAt: thirteenHoursAgo })
        .where(eq(sessions.tokenHash, tokenHash));

      const sessionRes = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        cookies: {
          [COOKIE_NAME]: sessionCookie,
        },
      });

      expect(sessionRes.statusCode).toBe(401);
      expect(sessionRes.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects session after password reset (credential version mismatch)', async () => {
      // Login to get a fresh session
      const loginRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username: testUsername,
          password: testPassword,
        },
      });
      const rawCookie = loginRes.cookies.find((c) => c.name === COOKIE_NAME);
      const freshToken = rawCookie?.value || '';

      // Reset password to advance credential version
      await createOrResetProductOwner(db, {
        username: testUsername,
        password: newPassword,
      });

      // Verify the old session is rejected
      const sessionRes = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        cookies: {
          [COOKIE_NAME]: freshToken,
        },
      });

      expect(sessionRes.statusCode).toBe(401);
    });

    it('explicit sign-out revokes session and clears cookie', async () => {
      // Login with new password
      const loginRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username: testUsername,
          password: newPassword,
        },
      });
      const rawCookie = loginRes.cookies.find((c) => c.name === COOKIE_NAME);
      const activeToken = rawCookie?.value || '';

      // Sign out
      const signOutRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-out',
        headers: SAME_ORIGIN_HEADERS,
        cookies: {
          [COOKIE_NAME]: activeToken,
        },
      });

      expect(signOutRes.statusCode).toBe(200);
      expect(signOutRes.json().success).toBe(true);

      // Verify session check fails after sign out
      const checkRes = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        cookies: {
          [COOKIE_NAME]: activeToken,
        },
      });

      expect(checkRes.statusCode).toBe(401);
    });
  });

  describe('Privacy-Safe Audit & Zero Credential Leakage', () => {
    it('proves no plaintext passwords, hashes, tokens, or cookies exist in audit logs', async () => {
      const allAuditEvents = await db.select().from(auditEvents);
      expect(allAuditEvents.length).toBeGreaterThan(0);

      for (const event of allAuditEvents) {
        const metadataStr = JSON.stringify(event.metadata || {});
        expect(metadataStr).not.toContain(testPassword);
        expect(metadataStr).not.toContain(newPassword);
        expect(metadataStr).not.toContain('$argon2id$');
        expect(metadataStr).not.toContain('__Host-session');
      }
    });
  });

  describe('Active Session Sliding & Role-Aware Absolute Ceiling', () => {
    it('enforces strict ABSOLUTE_EXPIRY on PRODUCT_OWNER sessions older than 24 hours', async () => {
      // Find PO account
      const [poAccount] = await db.select().from(accounts).where(eq(accounts.username, testUsername)).limit(1);
      expect(poAccount).toBeDefined();

      const { sessionToken, sessionId } = await createSession(db, {
        accountId: poAccount!.id,
        expectedCredentialVersion: poAccount!.credentialVersion,
      });

      // Manually backdate createdAt to 25 hours ago, but keep lastActiveAt fresh (5 min ago)
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);

      await db
        .update(sessions)
        .set({ createdAt: twentyFiveHoursAgo, lastActiveAt: fiveMinsAgo })
        .where(eq(sessions.id, sessionId));

      const validation = await validateAndTouchSession(db, sessionToken);
      expect(validation.isValid).toBe(false);
      expect(validation.reason).toBe('ABSOLUTE_EXPIRY');
    });

    it('allows active DISTRICT_HOKIM sessions older than 24 hours to slide continuously', async () => {
      // Provision test district and hokim account
      const timestamp = Date.now();
      const districtId = `dis_test_${timestamp}`;
      await db.insert(districts).values({
        id: districtId,
        name: `Слайдинг Тумани ${timestamp}`,
        status: 'ACTIVE',
      });

      const hokimAccountId = `acc_hokim_${Date.now()}`;
      await db.insert(accounts).values({
        id: hokimAccountId,
        username: `hokim_${Date.now()}`,
        role: 'DISTRICT_HOKIM',
        districtId,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dummyhash$dummyhash',
        status: 'ACTIVE',
        credentialVersion: 1,
        mustChangePassword: false,
      });

      const { sessionToken, sessionId } = await createSession(db, {
        accountId: hokimAccountId,
        expectedCredentialVersion: 1,
      });

      // Manually backdate createdAt to 25 hours ago, but keep lastActiveAt fresh (1 min ago)
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);

      await db
        .update(sessions)
        .set({ createdAt: twentyFiveHoursAgo, lastActiveAt: oneMinuteAgo })
        .where(eq(sessions.id, sessionId));

      const validation = await validateAndTouchSession(db, sessionToken);
      expect(validation.isValid).toBe(true);
      expect(validation.account?.role).toBe('DISTRICT_HOKIM');
      // Verify sliding expiry was granted 12 hours from now
      expect(validation.session?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
    });
  });
});
