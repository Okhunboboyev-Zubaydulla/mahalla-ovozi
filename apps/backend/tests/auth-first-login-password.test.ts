import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import {
  districts,
  accounts,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { eq, desc, and } from 'drizzle-orm';
import pg from 'pg';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from '../src/adapters/crypto/argon2.js';

const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

describe('Hokim First Sign-In Password Replacement Integration Tests (AC 10, 11, 12, 13, 15)', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;

  const testPoUsername = `po_pwd_test_${Date.now()}`;
  const testPoPassword = 'Secure-PO-Password-2026-Test!';
  let testDistrictId: string;
  let hokimAccountId: string;
  const hokimUsername = `hokim_${crypto.randomUUID().slice(0, 8)}`;
  const temporaryPassword = 'Hokim-Temporary-Password-2026!';
  let hokimAuthCookie: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    // 1. Create Product Owner and Active District
    await createOrResetProductOwner(db, {
      username: testPoUsername,
      password: testPoPassword,
    });

    testDistrictId = `dist_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: testDistrictId,
      name: `PwdTestDistrict_${crypto.randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
      activatedAt: new Date(),
    });

    // 2. Create Hokim Account with mustChangePassword = true
    hokimAccountId = `acc_${crypto.randomUUID()}`;
    const passwordHash = await hashPassword(temporaryPassword);
    await db.insert(accounts).values({
      id: hokimAccountId,
      username: hokimUsername,
      passwordHash,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: testDistrictId,
      mustChangePassword: true,
      credentialVersion: 1,
    });

    // 3. Hokim signs in using temporary password
    const signInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: hokimUsername,
        password: temporaryPassword,
      },
    });
    expect(signInRes.statusCode).toBe(200);
    const body = signInRes.json();
    expect(body.actor.mustChangePassword).toBe(true);

    const setCookie = signInRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toBeDefined();
    hokimAuthCookie = cookieHeader ? cookieHeader.split(';')[0]! : '';
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it('blocks access to protected endpoints with 403 PASSWORD_CHANGE_REQUIRED when mustChangePassword is true (F2.1)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${testDistrictId}/topics`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimAuthCookie,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('rejects password change if unauthenticated with 401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/change-first-login-password',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        currentPassword: temporaryPassword,
        newPassword: 'MyNewSuperSecurePermanentPassword2026!',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects password change if current password is incorrect with 401 (AC 12)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/change-first-login-password',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimAuthCookie,
      },
      payload: {
        currentPassword: 'Wrong-Temporary-Password!',
        newPassword: 'MyNewSuperSecurePermanentPassword2026!',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects password change if new password violates policy (<15 chars) with 400 (AC 10)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/change-first-login-password',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimAuthCookie,
      },
      payload: {
        currentPassword: temporaryPassword,
        newPassword: 'ShortPass123!',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects password change if new password is in common passwords blocklist with 400 (AC 10)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/change-first-login-password',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimAuthCookie,
      },
      payload: {
        currentPassword: temporaryPassword,
        newPassword: 'password1234567', // common password from blocklist
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.message).toContain('кенг тарқалган');
  });

  it('rejects password change if new password is identical to temporary password with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/change-first-login-password',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimAuthCookie,
      },
      payload: {
        currentPassword: temporaryPassword,
        newPassword: temporaryPassword,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.message).toContain('бир хил бўлиши мумкин эмас');
  });

  it('successfully replaces temporary password, sets mustChangePassword: false, updates credentialVersion, and records audit event (AC 10, 13, 15)', async () => {
    const newPermanentPassword = 'MyBrandNewPermanentSecurePassword2026!';

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/change-first-login-password',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimAuthCookie,
      },
      payload: {
        currentPassword: temporaryPassword,
        newPassword: newPermanentPassword,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.actor.mustChangePassword).toBe(false);

    // Verify DB account state
    const [updatedAcc] = await db.select().from(accounts).where(eq(accounts.id, hokimAccountId));
    expect(updatedAcc!.mustChangePassword).toBe(false);
    expect(updatedAcc!.credentialVersion).toBe(2);

    // Verify new password is valid Argon2id hash
    const isNewValid = await verifyPassword(updatedAcc!.passwordHash, newPermanentPassword);
    expect(isNewValid).toBe(true);

    // Verify temporary password no longer works
    const isOldValid = await verifyPassword(updatedAcc!.passwordHash, temporaryPassword);
    expect(isOldValid).toBe(false);

    // Verify current session is still active and updated to credentialVersion 2
    const sessionRes = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: hokimAuthCookie },
    });
    expect(sessionRes.statusCode).toBe(200);
    expect(sessionRes.json().actor.mustChangePassword).toBe(false);

    // Verify ACCOUNT_HOKIM_FIRST_LOGIN_PASSWORD_CHANGED audit event in DB
    const [auditEvent] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'ACCOUNT_HOKIM_FIRST_LOGIN_PASSWORD_CHANGED'),
          eq(auditEvents.actorId, hokimAccountId),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);

    expect(auditEvent).toBeDefined();
    expect(auditEvent!.metadata).toMatchObject({
      accountId: hokimAccountId,
      districtId: testDistrictId,
      username: hokimUsername,
      credentialVersion: 2,
    });
  });

  it('rejects subsequent password replacement attempt when mustChangePassword is already false with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/change-first-login-password',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimAuthCookie,
      },
      payload: {
        currentPassword: 'MyBrandNewPermanentSecurePassword2026!',
        newPassword: 'AnotherSuperSecurePassword2026!',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ACTION');
  });
});
