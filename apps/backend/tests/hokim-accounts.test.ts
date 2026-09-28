import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, sessions, auditEvents } from '../src/adapters/db/schema/index.js';
import { hashPassword, verifyPassword } from '../src/adapters/crypto/argon2.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { eq } from 'drizzle-orm';
import { COOKIE_NAME } from '../src/modules/auth/session-manager.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Hokim Accounts Management API & Service Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;
  let poCookie: string;
  let testDistrictId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    // Seed Product Owner
    await createOrResetProductOwner(db, {
      username: 'po_admin_hokim_tests',
      password: 'SecurePOAdminPassword2026!',
    });

    // Sign in as Product Owner to get session cookie
    const signInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: 'po_admin_hokim_tests',
        password: 'SecurePOAdminPassword2026!',
      },
    });

    expect(signInRes.statusCode).toBe(200);
    const cookies = signInRes.cookies;
    const sessionCookie = cookies.find((c) => c.name === COOKIE_NAME);
    expect(sessionCookie).toBeDefined();
    poCookie = `${sessionCookie!.name}=${sessionCookie!.value}`;
  });

  afterAll(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    testDistrictId = `dist_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: testDistrictId,
      name: `HokimTestDistrict_${crypto.randomUUID().slice(0, 8)}`,
      status: 'SETUP_INCOMPLETE',
    });
  });

  describe('GET /api/v1/districts/:districtId/hokim-account', () => {
    it('returns state: NO_ACCOUNT when no Hokim account exists for the district', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.state).toBe('NO_ACCOUNT');
      expect(json.account).toBeNull();
    });

    it('returns state: ACTIVE when an active Hokim account exists', async () => {
      const accId = `acc_${crypto.randomUUID()}`;
      await db.insert(accounts).values({
        id: accId,
        username: `hokim_get_test_${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: await hashPassword('InitialPass12345!'),
        role: 'DISTRICT_HOKIM',
        status: 'ACTIVE',
        districtId: testDistrictId,
      });

      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.state).toBe('ACTIVE');
      expect(json.account).toBeDefined();
      expect(json.account.id).toBe(accId);
      expect(json.account.role).toBe('DISTRICT_HOKIM');
      expect(json.account.status).toBe('ACTIVE');
    });

    it('returns 404 when district does not exist', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/districts/non_existent_district/hokim-account',
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
      });

      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('DISTRICT_NOT_FOUND');
    });
  });

  describe('POST /api/v1/districts/:districtId/hokim-account (Create)', () => {
    it('creates an active Hokim account and returns a cryptographically secure temporary password', async () => {
      const username = `hokim_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username },
      });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.payload);
      expect(json.account).toBeDefined();
      expect(json.account.username).toBe(username);
      expect(json.account.role).toBe('DISTRICT_HOKIM');
      expect(json.account.status).toBe('ACTIVE');
      expect(json.account.credentialVersion).toBe(1);
      expect(json.temporaryPassword).toBeDefined();
      expect(json.temporaryPassword.length).toBeGreaterThanOrEqual(15);

      // Verify password was hashed with Argon2id in DB
      const [dbAccount] = await db.select().from(accounts).where(eq(accounts.id, json.account.id)).limit(1);
      expect(dbAccount).toBeDefined();
      expect(dbAccount!.passwordHash).not.toBe(json.temporaryPassword);
      const isValid = await verifyPassword(dbAccount!.passwordHash, json.temporaryPassword);
      expect(isValid).toBe(true);

      // Verify audit event emitted without plaintext password
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'ACCOUNT_HOKIM_CREATED'));
      const event = auditRows.find((r) => (r.metadata as Record<string, unknown>)?.username === username);
      expect(event).toBeDefined();
      expect(JSON.stringify(event!.metadata)).not.toContain(json.temporaryPassword);
    });

    it('rejects invalid username format with 400', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: 'ho-kim!@#' },
      });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects creating a second active Hokim account for the same district with 409', async () => {
      const username1 = `hokim_dup1_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const username2 = `hokim_dup2_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

      // Create first
      const res1 = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: username1 },
      });
      expect(res1.statusCode).toBe(201);

      // Attempt second
      const res2 = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: username2 },
      });
      expect(res2.statusCode).toBe(409);
      const json = JSON.parse(res2.payload);
      expect(json.error.code).toBe('DISTRICT_HOKIM_ALREADY_EXISTS');
    });
  });

  describe('POST /api/v1/districts/:districtId/hokim-account/reset-password', () => {
    it('resets password, increments credentialVersion, and immediately revokes active sessions', async () => {
      const username = `hokim_reset_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

      // 1. Create account
      const createRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username },
      });
      expect(createRes.statusCode).toBe(201);
      const { account } = JSON.parse(createRes.payload);

      // 2. Create mock active session for this Hokim account
      const sessionId = `sess_${crypto.randomUUID()}`;
      await db.insert(sessions).values({
        id: sessionId,
        accountId: account.id,
        tokenHash: `hash_${crypto.randomUUID()}`,
        credentialVersion: account.credentialVersion,
        createdAt: new Date(),
        lastActiveAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
      });

      // 3. Reset password
      const resetRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account/reset-password`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
      });

      expect(resetRes.statusCode).toBe(200);
      const resetJson = JSON.parse(resetRes.payload);
      expect(resetJson.account.credentialVersion).toBe(2);
      expect(resetJson.temporaryPassword).toBeDefined();

      // Verify active session was revoked in database
      const [sessionRow] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(sessionRow).toBeDefined();
      expect(sessionRow!.revokedAt).not.toBeNull();

      // Verify audit event
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'ACCOUNT_HOKIM_PASSWORD_RESET'));
      const event = auditRows.find((r) => (r.metadata as Record<string, unknown>)?.districtId === testDistrictId);
      expect(event).toBeDefined();
    });
  });

  describe('POST /api/v1/districts/:districtId/hokim-account/disable', () => {
    it('disables active Hokim account and revokes all active sessions', async () => {
      const username = `hokim_dis_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

      // 1. Create account
      const createRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username },
      });
      const { account } = JSON.parse(createRes.payload);

      // 2. Add active session
      const sessionId = `sess_${crypto.randomUUID()}`;
      await db.insert(sessions).values({
        id: sessionId,
        accountId: account.id,
        tokenHash: `hash_${crypto.randomUUID()}`,
        credentialVersion: account.credentialVersion,
        createdAt: new Date(),
        lastActiveAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
      });

      // 3. Disable account
      const disRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account/disable`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
      });

      expect(disRes.statusCode).toBe(200);
      const disJson = JSON.parse(disRes.payload);
      expect(disJson.account.status).toBe('DISABLED');

      // Verify session revoked
      const [sessionRow] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(sessionRow!.revokedAt).not.toBeNull();

      // Verify GET returns state: DISABLED
      const getRes = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
      });
      expect(JSON.parse(getRes.payload).state).toBe('DISABLED');
    });
  });

  describe('POST /api/v1/districts/:districtId/hokim-account/replace', () => {
    it('atomically disables previous Hokim account, creates new Hokim account and returns new credentials', async () => {
      const oldUsername = `hokim_old_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const newUsername = `hokim_new_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

      // 1. Create first account
      const createRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: oldUsername },
      });
      const { account: oldAccount } = JSON.parse(createRes.payload);

      // 2. Replace account
      const replaceRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account/replace`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { newUsername },
      });

      expect(replaceRes.statusCode).toBe(200);
      const replaceJson = JSON.parse(replaceRes.payload);
      expect(replaceJson.previousAccountId).toBe(oldAccount.id);
      expect(replaceJson.account.username).toBe(newUsername);
      expect(replaceJson.account.status).toBe('ACTIVE');
      expect(replaceJson.temporaryPassword).toBeDefined();

      // Verify old account is now DISABLED
      const [oldDbAccount] = await db.select().from(accounts).where(eq(accounts.id, oldAccount.id)).limit(1);
      expect(oldDbAccount!.status).toBe('DISABLED');

      // Verify new account is ACTIVE
      const [newDbAccount] = await db.select().from(accounts).where(eq(accounts.id, replaceJson.account.id)).limit(1);
      expect(newDbAccount!.status).toBe('ACTIVE');
    });
  });

  describe('Authentication & Inactive District Lifecycle Guards (AC 6, 7, 8)', () => {
    it('rejects Hokim authentication when assigned district is not ACTIVE (e.g. SETUP_INCOMPLETE) with 403 DISTRICT_NOT_ACTIVE', async () => {
      const username = `hokim_inactive_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

      // 1. Create account on SETUP_INCOMPLETE district
      const createRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username },
      });
      const { temporaryPassword } = JSON.parse(createRes.payload);

      // 2. Attempt sign-in with valid password
      const signInRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username,
          password: temporaryPassword,
        },
      });

      expect(signInRes.statusCode).toBe(403);
      const json = JSON.parse(signInRes.payload);
      expect(json.error.code).toBe('DISTRICT_NOT_ACTIVE');
    });

    it('allows Hokim sign-in when district status is ACTIVE (Story 1.7 readiness)', async () => {
      const username = `hokim_active_dist_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

      // 1. Create account
      const createRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username },
      });
      const { temporaryPassword } = JSON.parse(createRes.payload);

      // 2. Activate district
      await db.update(districts).set({ status: 'ACTIVE' }).where(eq(districts.id, testDistrictId));

      // 3. Attempt sign-in
      const signInRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username,
          password: temporaryPassword,
        },
      });

      expect(signInRes.statusCode).toBe(200);
      const json = JSON.parse(signInRes.payload);
      expect(json.actor.role).toBe('DISTRICT_HOKIM');
      expect(json.actor.districtId).toBe(testDistrictId);
      expect(json.actor.username).toBe(username);
    });

    it('rejects disabled Hokim account sign-in with generic 401 INVALID_CREDENTIALS', async () => {
      const username = `hokim_dis_auth_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

      // 1. Create account
      const createRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username },
      });
      const { temporaryPassword } = JSON.parse(createRes.payload);

      // 2. Disable account
      await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account/disable`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
      });

      // 3. Attempt sign-in
      const signInRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username,
          password: temporaryPassword,
        },
      });

      expect(signInRes.statusCode).toBe(401);
      const json = JSON.parse(signInRes.payload);
      expect(json.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('PATCH /api/v1/districts/:districtId/hokim-account (Update Username)', () => {
    it('updates username in-place with spaces and preserves existing password & authentication', async () => {
      const initialUsername = `hokim_before_${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
      const newUsername = `Botir Zoirov ${crypto.randomUUID().replace(/-/g, '').slice(0, 4)}`;

      // 1. Create initial Hokim account
      const createRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: initialUsername },
      });
      expect(createRes.statusCode).toBe(201);
      const { account: initialAccount, temporaryPassword } = JSON.parse(createRes.payload);

      // Activate district for auth testing
      await db.update(districts).set({ status: 'ACTIVE' }).where(eq(districts.id, testDistrictId));

      // 2. Patch Hokim username
      const patchRes = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: newUsername },
      });

      expect(patchRes.statusCode).toBe(200);
      const patchJson = JSON.parse(patchRes.payload);
      expect(patchJson.account.id).toBe(initialAccount.id);
      expect(patchJson.account.username).toBe(newUsername);
      expect(patchJson.account.districtId).toBe(testDistrictId);

      // 3. Verify DB state: password hash remains intact, credentialVersion unchanged
      const [dbAccount] = await db.select().from(accounts).where(eq(accounts.id, initialAccount.id)).limit(1);
      expect(dbAccount).toBeDefined();
      expect(dbAccount!.username).toBe(newUsername);
      expect(dbAccount!.credentialVersion).toBe(initialAccount.credentialVersion);

      // 4. Verify authentication succeeds with new username and existing password
      const signInRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username: newUsername,
          password: temporaryPassword,
        },
      });
      expect(signInRes.statusCode).toBe(200);
      const signInJson = JSON.parse(signInRes.payload);
      expect(signInJson.actor.username).toBe(newUsername);

      // 5. Verify audit event was logged
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'ACCOUNT_HOKIM_USERNAME_UPDATED'));
      const event = auditRows.find(
        (r) => (r.metadata as Record<string, unknown>)?.newUsername === newUsername,
      );
      expect(event).toBeDefined();
      expect((event!.metadata as Record<string, unknown>).previousUsername).toBe(initialUsername);
    });

    it('supports Cyrillic names in username update', async () => {
      const initialUsername = `hokim_cyr_${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
      const cyrillicName = `Ботир Зоиров ${crypto.randomUUID().replace(/-/g, '').slice(0, 4)}`;

      await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: initialUsername },
      });

      const patchRes = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: cyrillicName },
      });

      expect(patchRes.statusCode).toBe(200);
      const json = JSON.parse(patchRes.payload);
      expect(json.account.username).toBe(cyrillicName);
    });

    it('rejects duplicate username with 409 USERNAME_ALREADY_EXISTS', async () => {
      const existingUser = `other_hokim_${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
      const currentHokim = `current_hokim_${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;

      // Create another account
      const otherDistrictId = `dist_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: otherDistrictId,
        name: `OtherDistrict_${crypto.randomUUID().slice(0, 6)}`,
        status: 'SETUP_INCOMPLETE',
      });
      await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${otherDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: existingUser },
      });

      // Create current hokim
      await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: currentHokim },
      });

      // Try to update current hokim to other hokim's username
      const patchRes = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: existingUser },
      });

      expect(patchRes.statusCode).toBe(409);
      const json = JSON.parse(patchRes.payload);
      expect(json.error.code).toBe('USERNAME_ALREADY_EXISTS');
    });

    it('returns 404 when district has no active Hokim account', async () => {
      const patchRes = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: 'New Valid Hokim' },
      });

      expect(patchRes.statusCode).toBe(404);
      const json = JSON.parse(patchRes.payload);
      expect(json.error.code).toBe('HOKIM_ACCOUNT_NOT_FOUND');
    });

    it('rejects invalid username formats with 400 VALIDATION_ERROR', async () => {
      const patchRes = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
        payload: { username: 'ab' }, // too short
      });

      expect(patchRes.statusCode).toBe(400);
      const json = JSON.parse(patchRes.payload);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
