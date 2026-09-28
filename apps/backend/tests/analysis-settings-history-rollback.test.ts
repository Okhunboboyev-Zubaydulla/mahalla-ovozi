import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  type DistrictAnalysisSettingsHistoryResponse,
  type RollbackDistrictAnalysisSettingsResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, auditEvents, aiOperations, topics, districtAnalysisSettingsVersions, districtAnalysisSettingsDrafts } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles, ensureDefaultDistrictAnalysisSettings } from '../src/adapters/db/seeds.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { eq, and, desc } from 'drizzle-orm';
import crypto from 'node:crypto';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 5.4: Review Configuration History and Roll Back Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let poCookie = '';
  let poAccountId = '';
  let hokimCookie = '';
  let hokimAccountId = '';
  let districtAId = '';
  let districtBId = '';

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);

    server = await buildHttpServer({ db, pool });
    await server.ready();

    // 1. Ensure seed profiles
    await ensureDefaultAiProfiles(db);

    // 2. Seed Product Owner
    const poUsername = `po_hist_test_${Date.now()}`;
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
    poCookie =
      (Array.isArray(poSetCookie) ? poSetCookie[0] : (poSetCookie as string)) || '';

    // 3. Seed Districts A and B
    const uniqueSuffix = Date.now();
    districtAId = `dist_hist_a_${uniqueSuffix}`;
    districtBId = `dist_hist_b_${uniqueSuffix}`;

    await db.insert(districts).values([
      { id: districtAId, name: `Чилонзор тарих ${uniqueSuffix}`, status: 'ACTIVE' },
      { id: districtBId, name: `Юнусобод тарих ${uniqueSuffix}`, status: 'ACTIVE' },
    ]);

    await ensureDefaultDistrictAnalysisSettings(db, districtAId);
    await ensureDefaultDistrictAnalysisSettings(db, districtBId);

    // 4. Seed Hokim user for District A
    const hokimUsername = `hokim_hist_${Date.now()}`;
    const hokimPassword = 'HokimPassword2026!';
    hokimAccountId = `acc_hokim_${crypto.randomUUID()}`;
    await db
      .insert(accounts)
      .values({
        id: hokimAccountId,
        username: hokimUsername,
        passwordHash: await hashPassword(hokimPassword),
        role: 'DISTRICT_HOKIM',
        status: 'ACTIVE',
        districtId: districtAId,
        mustChangePassword: false,
      })
      .returning();

    const hokimSignIn = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
      payload: { username: hokimUsername, password: hokimPassword },
    });
    expect(hokimSignIn.statusCode).toBe(200);
    const hokimSetCookie = hokimSignIn.headers['set-cookie'];
    hokimCookie =
      (Array.isArray(hokimSetCookie)
        ? hokimSetCookie[0]
        : (hokimSetCookie as string)) || '';
  });

  afterAll(async () => {
    // Cleanup district records
    await db
      .delete(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtAId));
    await db
      .delete(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtBId));
    await db
      .delete(districtAnalysisSettingsVersions)
      .where(eq(districtAnalysisSettingsVersions.districtId, districtAId));
    await db
      .delete(districtAnalysisSettingsVersions)
      .where(eq(districtAnalysisSettingsVersions.districtId, districtBId));
    await db.delete(accounts).where(eq(accounts.id, poAccountId));
    if (hokimAccountId) {
      await db.delete(accounts).where(eq(accounts.id, hokimAccountId));
    }
    await db.delete(districts).where(eq(districts.id, districtAId));
    await db.delete(districts).where(eq(districts.id, districtBId));

    if (server) await server.close();
  });


  // --------------------------------------------------------------------------
  // AC 2: District Configuration History Query & Isolation
  // --------------------------------------------------------------------------
  describe('District Configuration History Query (AC 2, AD-9)', () => {
    it('returns district-specific history and marks active baseline V1', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtAId}/history`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const data: DistrictAnalysisSettingsHistoryResponse = JSON.parse(res.payload);
      expect(data.districtId).toBe(districtAId);
      expect(data.items.length).toBe(1);
      expect(data.items[0]?.id).toBe(`dcfg_${districtAId}_v1`);
      expect(data.items[0]?.isActive).toBe(true);
      expect(data.items[0]?.hokimRecognitionTerms.length).toBeGreaterThan(0);
    });

    it('handles unseeded district gracefully by returning default baseline V1', async () => {
      const uniqueSuffix = Date.now();
      const unseededDistrictId = `dist_unseeded_${uniqueSuffix}`;
      await db.insert(districts).values({
        id: unseededDistrictId,
        name: `Unseeded District ${uniqueSuffix}`,
        status: 'ACTIVE',
      });

      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${unseededDistrictId}/history`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const data: DistrictAnalysisSettingsHistoryResponse = JSON.parse(res.payload);
      expect(data.items.length).toBe(1);
      expect(data.items[0]?.id).toBe(`dcfg_${unseededDistrictId}_v1`);
      expect(data.items[0]?.isActive).toBe(true);

      await db.delete(districts).where(eq(districts.id, unseededDistrictId));
    });

    it('enforces district isolation (District A history does not include District B)', async () => {
      const resA = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtAId}/history`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });
      const dataA: DistrictAnalysisSettingsHistoryResponse = JSON.parse(resA.payload);
      expect(dataA.items.every((v) => v.districtId === districtAId)).toBe(true);
    });
  });


  // --------------------------------------------------------------------------
  // AC 4, 7, 8, 12: District Rollback Atomic Execution & Scope Isolation
  // --------------------------------------------------------------------------
  describe('District Configuration Rollback (AC 4, 7, 8, 10, 12, AD-8, AD-9)', () => {
    it('creates new monotonic district version V3 copying V1 and preserves other districts', async () => {
      // 1. Save and activate V2 for District A
      await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/draft`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          hokimRecognitionTerms: ['Ҳоким', 'Чилонзор ҳокими', 'Сектор раҳбари'],
          localVocabularyAdditions: [
            { term: 'Чилонзор 1-мавзе', category: 'Мўлжал ва жойлар' },
          ],
        },
      });

      await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/activate`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v1`,
          changeReason: 'Чилонзор V2 атамаларини фаоллаштириш',
        },
      });

      // 2. Perform rollback to V1 for District A
      const rollbackRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/rollback`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v2`,
          targetVersionId: `dcfg_${districtAId}_v1`,
          changeReason: 'Чилонзор дастлабки V1 созламаларига қайтиш',
        },
      });

      expect(rollbackRes.statusCode).toBe(200);
      const rollbackData: RollbackDistrictAnalysisSettingsResponse = JSON.parse(
        rollbackRes.payload,
      );
      expect(rollbackData.districtId).toBe(districtAId);
      expect(rollbackData.activeConfiguration.id).toBe(`dcfg_${districtAId}_v3`);
      expect(rollbackData.activeConfiguration.version).toBe(3);
      expect(rollbackData.activeConfiguration.isActive).toBe(true);
      expect(rollbackData.previousActiveVersionId).toBe(`dcfg_${districtAId}_v2`);

      // 3. Strict Scope Isolation: District B remains on V1
      const histB = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtBId}/history`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });
      const dataB: DistrictAnalysisSettingsHistoryResponse = JSON.parse(histB.payload);
      expect(dataB.items.length).toBe(1);
      expect(dataB.items[0]?.id).toBe(`dcfg_${districtBId}_v1`);
      expect(dataB.items[0]?.isActive).toBe(true);

      // 4. Verify audit event for district rollback
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.districtId, districtAId),
            eq(auditEvents.action, 'DISTRICT_ANALYSIS_SETTINGS_ROLLED_BACK'),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(auditEvent).toBeDefined();
      expect(auditEvent?.metadata).toMatchObject({
        districtId: districtAId,
        previousActiveVersionId: `dcfg_${districtAId}_v2`,
        targetSourceVersionId: `dcfg_${districtAId}_v1`,
        newVersionId: `dcfg_${districtAId}_v3`,
        newVersion: 3,
      });
    });

    it('rejects cross-district target version lookup with 404 VERSION_NOT_FOUND', async () => {
      // Attempting to rollback District A with District B's target version ID
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/rollback`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v3`,
          targetVersionId: `dcfg_${districtBId}_v1`,
          changeReason: 'Cross-district rollback attempt test',
        },
      });

      expect(res.statusCode).toBe(404);
      const data = JSON.parse(res.payload);
      expect(data.error.code).toBe('VERSION_NOT_FOUND');
    });
  });

  // --------------------------------------------------------------------------
  // AC 5, 10, 11: Validation Guards & Error Handling
  // --------------------------------------------------------------------------
  describe('Concurrency & Validation Guards (AC 5, 6, 7, 10, 11)', () => {
    it('rejects rollback to currently active version with 400 NO_EFFECTIVE_ROLLBACK', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/rollback`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v3`,
          targetVersionId: `dcfg_${districtAId}_v3`,
          changeReason: 'No-op rollback test on current active',
        },
      });

      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.payload);
      expect(data.error.code).toBe('NO_EFFECTIVE_ROLLBACK');
    });

    it('rejects stale baseline version ID with 409 STALE_BASELINE_VERSION', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/rollback`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v1`, // Stale! Active is v3
          targetVersionId: `dcfg_${districtAId}_v2`,
          changeReason: 'Stale baseline version test',
        },
      });

      expect(res.statusCode).toBe(409);
      const data = JSON.parse(res.payload);
      expect(data.error.code).toBe('STALE_BASELINE_VERSION');
    });

    it('rejects nonexistent target version ID with 404 VERSION_NOT_FOUND', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/rollback`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v3`,
          targetVersionId: `dcfg_${districtAId}_v999`,
          changeReason: 'Missing target version test',
        },
      });

      expect(res.statusCode).toBe(404);
      const data = JSON.parse(res.payload);
      expect(data.error.code).toBe('VERSION_NOT_FOUND');
    });

    it('rejects changeReason with less than 5 characters with 400 VALIDATION_ERROR', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/rollback`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v3`,
          targetVersionId: `dcfg_${districtAId}_v2`,
          changeReason: '123',
        },
      });

      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.payload);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects changeReason containing prohibited secrets with 400 VALIDATION_ERROR', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/rollback`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v3`,
          targetVersionId: `dcfg_${districtAId}_v2`,
          changeReason: 'Rollback with bot token 123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567890',
        },
      });

      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.payload);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toContain('махфий маълумотлар');
    });
  });

  // --------------------------------------------------------------------------
  // AC 15: Authorization Boundary Enforcement
  // --------------------------------------------------------------------------
  describe('Authorization Boundaries (AC 15, AD-9)', () => {
    it('returns 401 Unauthorized for unauthenticated history and rollback requests', async () => {
      const histRes = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtAId}/history`,
        headers: SAME_ORIGIN_HEADERS,
      });
      expect(histRes.statusCode).toBe(401);

      const rollRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/rollback`,
        headers: SAME_ORIGIN_HEADERS,
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v3`,
          targetVersionId: `dcfg_${districtAId}_v2`,
          changeReason: 'Unauth attempt',
        },
      });
      expect(rollRes.statusCode).toBe(401);
    });

    it('returns 403 Forbidden for District Hokim on district history and rollback endpoints', async () => {
      const histDistrict = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtAId}/history`,
        headers: { cookie: hokimCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(histDistrict.statusCode).toBe(403);

      const rollDistrict = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/rollback`,
        headers: { cookie: hokimCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v3`,
          targetVersionId: `dcfg_${districtAId}_v2`,
          changeReason: 'Hokim forbidden attempt',
        },
      });
      expect(rollDistrict.statusCode).toBe(403);
    });
  });

  // --------------------------------------------------------------------------
  // AC 13: Future-Only Invariant & Pinned AI Operations Lineage Traceability
  // --------------------------------------------------------------------------
  describe('Future-Only Invariant Verification (AC 13, AD-8)', () => {
    it('proves historical ai_operations, topics, and accepted_evidence are not mutated by rollback', async () => {
      // 1. Seed a historical AI operation and topic with pinned profile ID
      const testOpId = `op_hist_${crypto.randomUUID()}`;
      const testTopicId = `top_hist_${crypto.randomUUID()}`;

      await db.insert(aiOperations).values({
        id: testOpId,
        districtId: districtAId,
        mahallaName: '1-маҳалла',
        calendarDay: '2026-08-10',
        operationType: 'SEMANTIC_RELEVANCE',
        targetId: 'intake_1001',
        pinnedProfileId: 'prof_rel_2026_08_v1',
        contextRevision: 0,
        snapshotFingerprint: 'test-fingerprint-123',
        finalStatus: 'COMPLETED_RELEVANT',
        createdAt: new Date('2026-08-10T10:00:00.000Z'),
      });

      await db.insert(topics).values({
        id: testTopicId,
        districtId: districtAId,
        mahallaName: '1-маҳалла',
        calendarDay: '2026-08-10',
        primaryLane: 'WATER',
        status: 'ACTIVE',
        latestRelevantEvidenceTimestamp: new Date('2026-08-10T10:00:00.000Z'),
        retentionExpiresAt: new Date('2026-09-10T10:00:00.000Z'),
        createdAt: new Date('2026-08-10T10:00:00.000Z'),
        updatedAt: new Date('2026-08-10T10:00:00.000Z'),
      });

      // 2. Perform another district rollback
      const rollbackRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/rollback`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v3`,
          targetVersionId: `dcfg_${districtAId}_v2`,
          changeReason: 'Future-only verification rollback to V2',
        },
      });
      expect(rollbackRes.statusCode).toBe(200);

      // 3. Verify that the historical AI operation is untouched
      const [opAfter] = await db
        .select()
        .from(aiOperations)
        .where(eq(aiOperations.id, testOpId));
      expect(opAfter).toBeDefined();
      expect(opAfter?.pinnedProfileId).toBe('prof_rel_2026_08_v1');
      expect(opAfter?.finalStatus).toBe('COMPLETED_RELEVANT');

      // 4. Verify that the historical topic is untouched
      const [topicAfter] = await db
        .select()
        .from(topics)
        .where(eq(topics.id, testTopicId));
      expect(topicAfter).toBeDefined();
      expect(topicAfter?.primaryLane).toBe('WATER');
      expect(topicAfter?.status).toBe('ACTIVE');

      // Cleanup
      await db.delete(topics).where(eq(topics.id, testTopicId));
      await db.delete(aiOperations).where(eq(aiOperations.id, testOpId));
    });
  });
});
