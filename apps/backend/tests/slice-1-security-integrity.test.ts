import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { districts, districtSubscriptions } from '../src/adapters/db/schema/index.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { listDistrictSubscriptions } from '../src/modules/subscriptions/subscriptions-service.js';
import {
  checkRestoreReconciliationHealth,
  clearRestoreHealthCache,
} from '../src/modules/health/health-routes.js';
import { handleDistrictTopicsError } from '../src/modules/topics/district-topics-routes.js';
import type { ExternalTombstoneStore } from '../src/modules/subscriptions/ports/external-tombstone-store.port.js';

describe('Slice 1: Backend Security & Data Integrity Unit/Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;
  let poCookie = '';

  const SAME_ORIGIN_HEADERS = {
    origin: 'http://localhost:5173',
    host: 'localhost:3000',
  };

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);

    server = await buildHttpServer({ db, pool });
    await server.ready();

    const poUsername = `po_slice1_${Date.now()}`;
    const poPassword = 'SecurePOPassword2026!';
    await createOrResetProductOwner(db, {
      username: poUsername,
      password: poPassword,
    });

    const poSignIn = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
      payload: { username: poUsername, password: poPassword },
    });
    expect(poSignIn.statusCode).toBe(200);
    const poSetCookie = poSignIn.headers['set-cookie'];
    poCookie =
      (Array.isArray(poSetCookie) ? poSetCookie[0] : (poSetCookie as string)) || '';
  });

  afterAll(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  describe('S1.2: Idempotent Subscriptions Read Path (No Writes on GET)', () => {
    it('synthesizes default in-memory subscription values without writing rows to PostgreSQL', async () => {
      const testDistrictId = `dist_idem_${crypto.randomUUID()}`;
      await db.insert(districts).values({
        id: testDistrictId,
        name: `Idempotent_District_${Date.now()}`,
        region: 'Toshkent',
        status: 'ACTIVE',
        activatedAt: new Date('2026-09-01T00:00:00.000Z'),
      });

      // Verify no subscription row exists initially
      const [initialRow] = await db
        .select()
        .from(districtSubscriptions)
        .where(eq(districtSubscriptions.districtId, testDistrictId))
        .limit(1);
      expect(initialRow).toBeUndefined();

      // Execute listDistrictSubscriptions
      const list = await listDistrictSubscriptions(db);
      const synthesized = list.find((d) => d.districtId === testDistrictId);

      expect(synthesized).toBeDefined();
      expect(synthesized!.id).toBe(`sub_${testDistrictId}`);
      expect(synthesized!.status).toBe('ACTIVE');
      expect(synthesized!.statusStartedAt).toBe(new Date('2026-09-01T00:00:00.000Z').toISOString());

      // Verify still NO subscription row in PostgreSQL (strictly read-only!)
      const [postRow] = await db
        .select()
        .from(districtSubscriptions)
        .where(eq(districtSubscriptions.districtId, testDistrictId))
        .limit(1);
      expect(postRow).toBeUndefined();
    });
  });

  describe('S1.3: Origin Guard Hooks on State-Changing Routes', () => {
    it('blocks cross-site requests to admin signals mutation routes with HTTP 403', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/signals/manual',
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        payload: {
          districtId: 'dist-1',
          mahallaName: 'Navbahor',
          verbatimText: 'Test message',
          lanes: ['WATER'],
          changeReason: 'Manual test signal creation',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('blocks cross-site requests to district analysis settings draft route with HTTP 403', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/ai/settings/districts/dist_any/draft',
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        payload: {
          confidenceThreshold: 0.8,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe('FORBIDDEN_ORIGIN');
    });
  });

  describe('S1.1: Mask Hand-rolled 5xx Error Leaks', () => {
    it('masks internal error messages for statusCode >= 500 in handleDistrictTopicsError', () => {
      let capturedStatus = 0;
      let capturedPayload: unknown = null;

      const mockReply = {
        status: (code: number) => {
          capturedStatus = code;
          return mockReply;
        },
        send: (payload: unknown) => {
          capturedPayload = payload;
          return mockReply;
        },
      } as unknown as Parameters<typeof handleDistrictTopicsError>[1];

      // 500 error with internal leakage attempt
      const internalErr = Object.assign(new Error('CRITICAL DB LEAK: password=secret'), {
        statusCode: 500,
        code: 'DB_PANIC',
      });

      handleDistrictTopicsError(internalErr, mockReply);

      expect(capturedStatus).toBe(500);
      expect(capturedPayload).toEqual({
        error: {
          code: 'DB_PANIC',
          message: 'Серверда кутилмаган хатолик юз берди.',
        },
      });

      // 400 error preserves client-safe message
      const clientErr = Object.assign(new Error('Invalid parameters supplied'), {
        statusCode: 400,
        code: 'BAD_REQUEST',
      });

      handleDistrictTopicsError(clientErr, mockReply);
      expect(capturedStatus).toBe(400);
      expect(capturedPayload).toEqual({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid parameters supplied',
        },
      });
    });
  });

  describe('S1.4: Optimize Readiness Probe Disk I/O via TTL Cache', () => {
    it('caches tombstone reconciliation status for cacheTtlMs duration without re-reading store', async () => {
      clearRestoreHealthCache();

      let loadCount = 0;
      const mockStore: ExternalTombstoneStore = {
        loadAllTombstones: async () => {
          loadCount++;
          return [];
        },
        saveTombstone: async () => {},
        saveAllTombstones: async () => {},
        getTombstone: async () => null,
      };

      // First call: store is queried
      const status1 = await checkRestoreReconciliationHealth(db, mockStore, 5000);
      expect(status1).toBe('ok');
      expect(loadCount).toBe(1);

      // Second call within TTL: served from in-memory cache, loadCount unchanged
      const status2 = await checkRestoreReconciliationHealth(db, mockStore, 5000);
      expect(status2).toBe('ok');
      expect(loadCount).toBe(1);

      // Clearing cache causes store re-read
      clearRestoreHealthCache();
      const status3 = await checkRestoreReconciliationHealth(db, mockStore, 5000);
      expect(status3).toBe('ok');
      expect(loadCount).toBe(2);

      // Clean up cache
      clearRestoreHealthCache();
    });
  });
});
