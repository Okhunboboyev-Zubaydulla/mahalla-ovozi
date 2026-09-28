import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { auditEvents } from '../src/adapters/db/schema/index.js';
import { eq, desc, and } from 'drizzle-orm';
import pg from 'pg';

import crypto from 'node:crypto';

// P6-G: Simulate a same-origin browser request — all state-changing requests must pass the B3 origin guard.
const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

describe('Districts Domain Module & Lifecycle Integration Tests', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;

  const testUsername = `po_dist_${Date.now()}`;
  const testPassword = 'Secure-PO-Password-2026-Test!';
  let authCookie: string;
  let poAccountId: string;

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
    poAccountId = signInRes.json().actor.id;
    const setCookie = signInRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toBeDefined();
    authCookie = cookieHeader ? cookieHeader.split(';')[0]! : '';
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  describe('Authentication & Authorization Guards (P6-D matrix)', () => {
    it('GET /api/v1/districts rejects unauthenticated requests with 401', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/districts',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('GET /api/v1/districts/:id rejects unauthenticated requests with 401', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/districts/some-district-id',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('POST /api/v1/districts rejects unauthenticated requests with 401', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: SAME_ORIGIN_HEADERS,
        payload: { name: 'Чилонзор' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('POST /api/v1/districts rejects cross-origin requests with 403', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: {
          'sec-fetch-site': 'cross-site',
          cookie: authCookie,
        },
        payload: { name: 'Чилонзор' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN_ORIGIN');
    });
  });

  describe('District Creation & Lifecycle (P3-G, P6-D, P6-E, P6-F)', () => {
    it('rejects creation with empty or single-character name with 400', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
        payload: { name: '  a  ' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('creates district successfully and returns HTTP 201 Created with SETUP_INCOMPLETE (P3-G)', async () => {
      const uniqueName = `Yunusobod_${crypto.randomUUID().slice(0, 6)}`;
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
        payload: {
          name: `  ${uniqueName}  `,
          region: 'Тошкент шаҳри',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.district).toBeDefined();
      expect(body.district.id).toMatch(/^dist_/);
      expect(body.district.name).toBe(uniqueName);
      expect(body.district.region).toBe('Тошкент шаҳри');
      expect(body.district.status).toBe('SETUP_INCOMPLETE');
      expect(body.district.createdAt).toBeDefined();
    });

    it('enforces case-insensitive duplicate name conflict with 409 (P6-F)', async () => {
      const uniqueName = `Shayxontohur_${crypto.randomUUID().slice(0, 6)}`;

      // 1. Create first
      const create1 = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
        payload: { name: uniqueName },
      });
      expect(create1.statusCode).toBe(201);

      // 2. Create with different casing
      const create2 = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
        payload: { name: uniqueName.toLowerCase() },
      });
      expect(create2.statusCode).toBe(409);
      expect(create2.json().error.code).toBe('DISTRICT_NAME_EXISTS');
      expect(create2.json().error.message).toBe('Бу номдаги туман аллақачон мавжуд.');
    });

    it('records DISTRICT_CREATED audit event with privacy-safe metadata (P6-E, P2-E)', async () => {
      const uniqueName = `Mirobod_${crypto.randomUUID().slice(0, 6)}`;
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
        payload: {
          name: uniqueName,
          region: 'Тошкент',
        },
      });
      expect(response.statusCode).toBe(201);
      const createdDistrictId = response.json().district.id;

      // Check audit event scoped to test actor
      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'DISTRICT_CREATED'),
            eq(auditEvents.actorId, poAccountId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(audit).toBeDefined();
      expect(audit!.actorRole).toBe('PRODUCT_OWNER');
      expect(audit!.metadata).toEqual({
        districtId: createdDistrictId,
        districtName: uniqueName,
        region: 'Тошкент',
      });

      // Verify privacy: no passwords, tokens, hashes in metadata stringification
      const stringified = JSON.stringify(audit!.metadata);
      expect(stringified).not.toContain('password');
      expect(stringified).not.toContain('token');
      expect(stringified).not.toContain('cookie');
    });
  });

  describe('District Queries (GET /api/v1/districts & GET /api/v1/districts/:id)', () => {
    it('lists all districts ordered by name ASC (P3-H)', async () => {
      const prefix = `Sort_${Date.now()}_`;
      // Seed 3 items in unordered sequence
      await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { name: `${prefix}Z` },
      });
      await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { name: `${prefix}A` },
      });
      await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { name: `${prefix}M` },
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/districts',
        headers: {
          cookie: authCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.districts)).toBe(true);
      expect(body.districts.length).toBeGreaterThanOrEqual(3);

      // Verify ASC order on the seeded subset
      const seeded = body.districts
        .filter((d: { name: string }) => d.name.startsWith(prefix))
        .map((d: { name: string }) => d.name);

      expect(seeded).toEqual([`${prefix}A`, `${prefix}M`, `${prefix}Z`]);
    });

    it('fetches existing district by ID with 200', async () => {
      // First list to get an existing ID
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/v1/districts',
        headers: { cookie: authCookie },
      });
      const firstDistrict = listRes.json().districts[0];

      const getRes = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${firstDistrict.id}`,
        headers: { cookie: authCookie },
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().district.id).toBe(firstDistrict.id);
      expect(getRes.json().district.name).toBe(firstDistrict.name);
    });

    it('returns 404 when querying non-existent district ID (P3-C)', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/districts/dist_non_existent_id_12345',
        headers: { cookie: authCookie },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('DISTRICT_NOT_FOUND');
      expect(response.json().error.message).toBe('Туман топилмади.');
    });
  });

  describe('District Updates (PATCH /api/v1/districts/:districtId)', () => {
    it('rejects unauthenticated PATCH requests with 401', async () => {
      const response = await server.inject({
        method: 'PATCH',
        url: '/api/v1/districts/dist_some_id',
        headers: SAME_ORIGIN_HEADERS,
        payload: { name: 'Чилонзор' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects cross-origin PATCH requests with 403', async () => {
      const response = await server.inject({
        method: 'PATCH',
        url: '/api/v1/districts/dist_some_id',
        headers: {
          'sec-fetch-site': 'cross-site',
          cookie: authCookie,
        },
        payload: { name: 'Чилонзор' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('rejects invalid payload with 400', async () => {
      const response = await server.inject({
        method: 'PATCH',
        url: '/api/v1/districts/dist_some_id',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
        payload: { name: ' x ' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when updating non-existent district', async () => {
      const response = await server.inject({
        method: 'PATCH',
        url: '/api/v1/districts/dist_non_existent_99999',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
        payload: { name: 'Янги ном' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('DISTRICT_NOT_FOUND');
    });

    it('updates district name and region, updates timestamp, and records DISTRICT_UPDATED audit event', async () => {
      const initialName = `EditTest_${crypto.randomUUID().slice(0, 6)}`;
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { name: initialName, region: 'Эски вилоят' },
      });
      expect(createRes.statusCode).toBe(201);
      const districtId = createRes.json().district.id;
      const initialCreatedAt = createRes.json().district.createdAt;

      const updatedName = `${initialName}_Updated`;
      const patchRes = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtId}`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: {
          name: updatedName,
          region: 'Янги вилоят',
        },
      });

      expect(patchRes.statusCode).toBe(200);
      const body = patchRes.json();
      expect(body.district.id).toBe(districtId);
      expect(body.district.name).toBe(updatedName);
      expect(body.district.region).toBe('Янги вилоят');
      expect(body.district.createdAt).toBe(initialCreatedAt);

      // Verify audit event
      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'DISTRICT_UPDATED'),
            eq(auditEvents.actorId, poAccountId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(audit).toBeDefined();
      expect(audit!.actorRole).toBe('PRODUCT_OWNER');
      expect(audit!.metadata).toEqual({
        districtId,
        oldName: initialName,
        newName: updatedName,
        oldRegion: 'Эски вилоят',
        newRegion: 'Янги вилоят',
      });
    });

    it('updates region only with unchanged name without triggering 409 conflict', async () => {
      const name = `RegionOnly_${crypto.randomUUID().slice(0, 6)}`;
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { name, region: 'Вилоят 1' },
      });
      expect(createRes.statusCode).toBe(201);
      const districtId = createRes.json().district.id;

      const patchRes = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtId}`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: {
          name: name.toLowerCase(), // same name different casing
          region: 'Вилоят 2',
        },
      });

      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().district.region).toBe('Вилоят 2');
    });

    it('rejects update with 409 if new name conflicts with another district', async () => {
      const nameA = `ConflictA_${crypto.randomUUID().slice(0, 6)}`;
      const nameB = `ConflictB_${crypto.randomUUID().slice(0, 6)}`;

      await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { name: nameA },
      });

      const createB = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { name: nameB },
      });
      const districtBId = createB.json().district.id;

      // Attempt to rename district B to district A's name
      const patchRes = await server.inject({
        method: 'PATCH',
        url: `/api/v1/districts/${districtBId}`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { name: nameA.toLowerCase() },
      });

      expect(patchRes.statusCode).toBe(409);
      expect(patchRes.json().error.code).toBe('DISTRICT_NAME_EXISTS');
      expect(patchRes.json().error.message).toBe('Бу номдаги туман аллақачон мавжуд.');
    });
  });
});

