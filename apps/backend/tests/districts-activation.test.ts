import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  accounts,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { eq, desc, and } from 'drizzle-orm';
import pg from 'pg';
import crypto from 'node:crypto';
import { hashPassword } from '../src/adapters/crypto/argon2.js';

const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

describe('District Activation Service & Route Integration Tests (Story 1.7)', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;

  const testUsername = `po_activation_${Date.now()}`;
  const testPassword = 'Secure-PO-Password-2026-Test!';
  let poAccountId: string;
  let authCookie: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    // Provision Product Owner account
    const po = await createOrResetProductOwner(db, {
      username: testUsername,
      password: testPassword,
    });
    poAccountId = po.accountId;

    // Authenticate and obtain session cookie
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
    expect(cookieHeader).toBeDefined();
    authCookie = cookieHeader ? cookieHeader.split(';')[0]! : '';
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  describe('Authentication & Origin Security Gating (AC 2, 401/403/404)', () => {
    it('POST /api/v1/districts/:id/activate rejects unauthenticated requests with 401', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/districts/dist_test_123/activate',
        headers: SAME_ORIGIN_HEADERS,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('POST /api/v1/districts/:id/activate rejects cross-origin requests with 403', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/districts/dist_test_123/activate',
        headers: {
          'sec-fetch-site': 'cross-site',
          cookie: authCookie,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('POST /api/v1/districts/:id/activate returns 404 for non-existent district', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/districts/dist_nonexistent_9999/activate',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('DISTRICT_NOT_FOUND');
    });
  });

  describe('Incomplete Prerequisites Rejection & Blocker Envelope (AC 3, AC 15)', () => {
    let unreadyDistrictId: string;
    const districtName = `Unready District ${Date.now()}`;

    beforeAll(async () => {
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { name: districtName, region: 'Самарқанд' },
      });
      expect(createRes.statusCode).toBe(201);
      unreadyDistrictId = createRes.json().district.id;
    });

    it('rejects activation with 409 Conflict and structured blockers array when requirements are unmet', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${unreadyDistrictId}/activate`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe('DISTRICT_NOT_READY');
      expect(body.error.message).toBe('Туманни фаоллаштириш учун барча талаблар бажарилмаган.');
      expect(Array.isArray(body.error.blockers)).toBe(true);
      expect(body.error.blockers.length).toBeGreaterThanOrEqual(4); // disclosure, bot, group, hokim

      // Verify district remains SETUP_INCOMPLETE
      const [distRow] = await db.select().from(districts).where(eq(districts.id, unreadyDistrictId));
      expect(distRow!.status).toBe('SETUP_INCOMPLETE');
      expect(distRow!.activatedAt).toBeNull();

      // Verify DISTRICT_ACTIVATION_FAILED audit log recorded in DB
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'DISTRICT_ACTIVATION_FAILED'),
            eq(auditEvents.actorId, poAccountId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(auditEvent).toBeDefined();
      expect(auditEvent!.metadata).toMatchObject({
        districtId: unreadyDistrictId,
        districtName,
      });
    });
  });

  describe('Full 8-Prerequisite End-to-End Activation & Downstream Admission (AC 1, 2, 5, 6, 8, 9, 15)', () => {
    let readyDistrictId: string;
    const readyDistrictName = `Ready District ${Date.now()}`;
    const hokimUsername = `hokim_${crypto.randomUUID().slice(0, 8)}`;
    const hokimPassword = 'Hokim-Temporary-Password-2026!';
    let hokimAccountId: string;

    beforeAll(async () => {
      // 1. Create District (district_identity, access_eligibility, analysis_configuration, district_isolation)
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { name: readyDistrictName, region: 'Тошкент шаҳри' },
      });
      expect(createRes.statusCode).toBe(201);
      readyDistrictId = createRes.json().district.id;

      // 2. Confirm standing access disclosure (disclosure_confirmation)
      const confRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${readyDistrictId}/disclosure-confirmation`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
      });
      expect(confRes.statusCode).toBe(200);

      // 3. Attach VALID Telegram Bot (telegram_bot)
      await db.insert(districtTelegramBots).values({
        id: `dtb_${crypto.randomUUID()}`,
        districtId: readyDistrictId,
        botId: `bot_${crypto.randomUUID().slice(0, 8)}`,
        botFirstName: 'Ready Bot',
        botUsername: 'ReadyDistrictBot',
        encryptedToken: 'dummyenc',
        tokenIv: 'dummyiv12345678901234',
        tokenTag: 'dummytag1234567890123456789012',
        tokenKeyVersion: 'v1',
        tokenMasked: '12345:••••••••••••',
        status: 'VALID',
        lastValidatedAt: new Date(),
      });

      // 4. Attach VALID Telegram Group Mapping (group_mappings)
      await db.insert(districtTelegramGroups).values({
        id: `dtg_${crypto.randomUUID()}`,
        districtId: readyDistrictId,
        mahallaName: 'Bunyodkor',
        telegramChatId: `-100${Date.now()}`,
        telegramChatTitle: 'Bunyodkor Mahalla',
        status: 'VALID',
        lastValidatedAt: new Date(),
      });

      // 5. Create ACTIVE Hokim account (hokim_account) with mustChangePassword = true
      hokimAccountId = `acc_${crypto.randomUUID()}`;
      const passwordHash = await hashPassword(hokimPassword);
      await db.insert(accounts).values({
        id: hokimAccountId,
        username: hokimUsername,
        passwordHash,
        role: 'DISTRICT_HOKIM',
        status: 'ACTIVE',
        districtId: readyDistrictId,
        mustChangePassword: true,
        credentialVersion: 1,
      });
    });

    it('Hokim sign-in is blocked with 403 DISTRICT_NOT_ACTIVE before district activation (AC 9)', async () => {
      const signInRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username: hokimUsername,
          password: hokimPassword,
        },
      });

      expect(signInRes.statusCode).toBe(403);
      expect(signInRes.json().error.code).toBe('DISTRICT_NOT_ACTIVE');
    });

    it('activates district atomically when all 8 prerequisites evaluate to passed (AC 1, 2, 5, 15)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${readyDistrictId}/activate`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.district.id).toBe(readyDistrictId);
      expect(body.district.status).toBe('ACTIVE');
      expect(body.activatedAt).toBeDefined();
      expect(body.activatedById).toBe(poAccountId);

      // Verify DB row
      const [distRow] = await db.select().from(districts).where(eq(districts.id, readyDistrictId));
      expect(distRow!.status).toBe('ACTIVE');
      expect(distRow!.activatedAt).toBeDefined();
      expect(distRow!.activatedById).toBe(poAccountId);

      // Verify DISTRICT_ACTIVATED audit event
      const [activatedAudit] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'DISTRICT_ACTIVATED'),
            eq(auditEvents.actorId, poAccountId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(activatedAudit).toBeDefined();
      expect(activatedAudit!.metadata).toMatchObject({
        districtId: readyDistrictId,
        districtName: readyDistrictName,
        passedPrerequisitesCount: 8,
      });
    });

    it('Hokim sign-in succeeds after district activation and returns mustChangePassword: true (AC 9, 10)', async () => {
      const signInRes = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          username: hokimUsername,
          password: hokimPassword,
        },
      });

      expect(signInRes.statusCode).toBe(200);
      const body = signInRes.json();
      expect(body.actor.role).toBe('DISTRICT_HOKIM');
      expect(body.actor.districtId).toBe(readyDistrictId);
      expect(body.actor.mustChangePassword).toBe(true);
    });

    it('rejects re-activation of already ACTIVE district with 409 DISTRICT_ALREADY_ACTIVE (AC 6)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${readyDistrictId}/activate`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DISTRICT_ALREADY_ACTIVE');
    });

    it('rejects activation of SUSPENDED or CANCELLED district with 409 DISTRICT_INVALID_STATUS (AC 6)', async () => {
      // Temporarily mark as SUSPENDED
      await db
        .update(districts)
        .set({ status: 'SUSPENDED' })
        .where(eq(districts.id, readyDistrictId));

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${readyDistrictId}/activate`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DISTRICT_INVALID_STATUS');
    });
  });
});
