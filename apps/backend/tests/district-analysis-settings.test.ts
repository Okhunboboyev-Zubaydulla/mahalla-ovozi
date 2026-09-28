import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  GetDistrictAnalysisSettingsResponse,
  SaveDistrictAnalysisSettingsDraftResponse,
  SaveDistrictAnalysisSettingsDraftRequest,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, auditEvents, aiProfiles, districtAnalysisSettingsVersions, districtAnalysisSettingsDrafts } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles, ensureDefaultDistrictAnalysisSettings } from '../src/adapters/db/seeds.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { eq, and, desc } from 'drizzle-orm';
import crypto from 'node:crypto';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 5.2: District Recognition Settings & Drafts Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let poCookie = '';
  let poAccountId = '';
  let hokimCookie = '';
  let districtAId = '';
  let districtBId = '';

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);

    server = await buildHttpServer({ db, pool });
    await server.ready();

    // 1. Ensure default seed AI profiles
    await ensureDefaultAiProfiles(db);

    // 2. Seed Product Owner
    const poUsername = `po_dist_settings_${Date.now()}`;
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
      (Array.isArray(poSetCookie) ? poSetCookie[0] : (poSetCookie as string)) ||
      '';

    // 3. Seed District A and District B
    districtAId = `dist_a_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: districtAId,
      name: `DistrictA_${crypto.randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    await ensureDefaultDistrictAnalysisSettings(db, districtAId);

    districtBId = `dist_b_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: districtBId,
      name: `DistrictB_${crypto.randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    await ensureDefaultDistrictAnalysisSettings(db, districtBId);

    // 4. Seed Hokim for District A
    const hokimUsername = `hokim_dist_${Date.now()}`;
    const hokimPassword = 'HokimPassword2026!';
    const hokimPasswordHash = await hashPassword(hokimPassword);
    const hokimAccountId = `acc_hokim_${crypto.randomUUID()}`;

    await db.insert(accounts).values({
      id: hokimAccountId,
      username: hokimUsername,
      passwordHash: hokimPasswordHash,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: districtAId,
      mustChangePassword: false,
    });

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
    // Cleanup test records
    await db
      .delete(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtAId));
    await db
      .delete(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtBId));
    await db.delete(accounts).where(eq(accounts.id, poAccountId));
    await db.delete(districts).where(eq(districts.id, districtAId));
    await db.delete(districts).where(eq(districts.id, districtBId));
    await server.close();
    await pool.end();
  });

  beforeEach(async () => {
    // Reset drafts before each test
    await db
      .delete(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtAId));
    await db
      .delete(districtAnalysisSettingsDrafts)
      .where(eq(districtAnalysisSettingsDrafts.districtId, districtBId));
  });

  describe('Authorization Boundary & District Scoping (AC 1, 9)', () => {
    it('allows Product Owner to fetch district settings (200)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtAId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as GetDistrictAnalysisSettingsResponse;
      expect(data.districtId).toBe(districtAId);
      expect(data.activeConfiguration).toBeDefined();
      expect(data.activeConfiguration.id).toBe(`dcfg_${districtAId}_v1`);
      expect(data.activeConfiguration.version).toBe(1);
    });

    it('denies District Hokim with 403 Forbidden on GET district settings', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtAId}`,
        headers: {
          cookie: hokimCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(403);
      const err = JSON.parse(res.payload);
      expect(err.error?.code).toBe('FORBIDDEN');
    });

    it('denies District Hokim with 403 Forbidden on POST district settings draft', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/draft`,
        headers: {
          cookie: hokimCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          hokimRecognitionTerms: ['Ҳоким', 'Туман ҳокими'],
          localVocabularyAdditions: [],
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('denies unauthenticated request with 401 Unauthorized', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtAId}`,
        headers: SAME_ORIGIN_HEADERS,
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 404 DISTRICT_NOT_FOUND for non-existent districtId', async () => {
      const nonExistentId = `dist_nonexistent_${crypto.randomUUID()}`;
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${nonExistentId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(404);
      const err = JSON.parse(res.payload);
      expect(err.error?.code).toBe('DISTRICT_NOT_FOUND');
      expect(err.error?.message).toBe('Туман топилмади.');
    });
  });

  describe('Active Configuration Presentation & Initial Draft State (AC 2, 3)', () => {
    it('returns active configuration with null draft when no draft exists', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtAId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as GetDistrictAnalysisSettingsResponse;
      expect(data.districtId).toBe(districtAId);
      expect(data.activeConfiguration.id).toBe(`dcfg_${districtAId}_v1`);
      expect(data.activeConfiguration.version).toBe(1);
      expect(data.activeConfiguration.isActive).toBe(true);
      expect(data.activeConfiguration.hokimRecognitionTerms.length).toBeGreaterThanOrEqual(5);
      expect(data.draft).toBeNull();
    });
  });

  describe('Valid Draft Persistence, Resumption & Cross-District Isolation (AC 3, 4, 8)', () => {
    it('saves draft for District A and preserves cross-district isolation from District B', async () => {
      const initialProfiles = await db.select().from(aiProfiles);
      const initialVersions = await db.select().from(districtAnalysisSettingsVersions);

      const validPayload: SaveDistrictAnalysisSettingsDraftRequest = {
        hokimRecognitionTerms: [
          'Ҳоким',
          'Туман ҳокими',
          'Ҳоким ёрдамчиси',
          'Сектор раҳбари',
          'Tuman hokimi',
          '1-сектор раҳбари',
        ],
        localVocabularyAdditions: [
          {
            term: 'Қўшчинор маҳалласи',
            category: 'Маҳалла номлари',
            description: 'Шимолий ҳудуд маҳалласи',
          },
          {
            term: 'Катта кўприк',
            category: 'Мўлжал ва жойлар',
          },
        ],
      };

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/draft`,
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: validPayload,
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as SaveDistrictAnalysisSettingsDraftResponse;
      expect(data.message).toBe('Қоралама муваффақиятли сақланди');
      expect(data.draft.districtId).toBe(districtAId);
      expect(data.draft.baseActiveVersionId).toBe(`dcfg_${districtAId}_v1`);
      expect(data.draft.hokimRecognitionTerms).toHaveLength(6);
      expect(data.draft.localVocabularyAdditions).toHaveLength(2);

      // Verify subsequent GET for District A returns the draft
      const getARes = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtAId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      const getAData = JSON.parse(getARes.payload) as GetDistrictAnalysisSettingsResponse;
      expect(getAData.draft).not.toBeNull();
      expect(getAData.draft?.hokimRecognitionTerms).toContain('1-сектор раҳбари');

      // Verify Cross-District Isolation: District B has null draft
      const getBRes = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${districtBId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      const getBData = JSON.parse(getBRes.payload) as GetDistrictAnalysisSettingsResponse;
      expect(getBData.draft).toBeNull();

      // Verify Audit Event was recorded
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'DISTRICT_ANALYSIS_SETTINGS_DRAFT_SAVED'),
            eq(auditEvents.districtId, districtAId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt));

      expect(auditEvent).toBeDefined();
      expect(auditEvent!.actorRole).toBe('PRODUCT_OWNER');
      expect(auditEvent!.actorId).toBe(poAccountId);
      expect(auditEvent!.districtId).toBe(districtAId);
      const meta = auditEvent!.metadata as Record<string, unknown>;
      expect(meta.hokimTermsCount).toBe(6);
      expect(meta.vocabularyCount).toBe(2);

      // Verify Active Profiles & Versions are completely unchanged (Zero Runtime Mutation Invariant AD-8)
      const afterProfiles = await db.select().from(aiProfiles);
      expect(afterProfiles.length).toBe(initialProfiles.length);

      const afterVersions = await db.select().from(districtAnalysisSettingsVersions);
      expect(afterVersions.length).toBe(initialVersions.length);
    });

    it('successfully saves and retrieves a draft for a brand-new unseeded district without active version records (AC 3, 4, 8)', async () => {
      const now = Date.now();
      const newDistrictId = `dist_unseeded_${now}`;
      await db.insert(districts).values({
        id: newDistrictId,
        name: `Янги туман ${now}`,
        region: 'Тошкент шаҳри',
        status: 'SETUP_INCOMPLETE',
      });

      // No records in districtAnalysisSettingsVersions for this district
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${newDistrictId}/draft`,
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          hokimRecognitionTerms: ['Ҳоким', 'Янги туман ҳокими'],
          localVocabularyAdditions: [
            {
              term: 'Янги Маҳалла',
              category: 'Маҳалла номлари',
              description: 'Янги маҳалла ҳудуди',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as SaveDistrictAnalysisSettingsDraftResponse;
      expect(data.draft.districtId).toBe(newDistrictId);
      expect(data.draft.baseActiveVersionId).toBeNull();
      expect(data.draft.hokimRecognitionTerms).toEqual(['Ҳоким', 'Янги туман ҳокими']);

      // Subsequent GET returns baseline activeConfig and saved draft
      const getRes = await server.inject({
        method: 'GET',
        url: `/api/v1/ai/settings/districts/${newDistrictId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(getRes.statusCode).toBe(200);
      const getData = JSON.parse(getRes.payload) as GetDistrictAnalysisSettingsResponse;
      expect(getData.activeConfiguration.id).toBe(`dcfg_${newDistrictId}_v1`);
      expect(getData.draft).not.toBeNull();
      expect(getData.draft?.baseActiveVersionId).toBeNull();
    });
  });

  describe('Validation & Edge Cases (AC 6, 7)', () => {
    it('rejects empty hokimRecognitionTerms with 400', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/draft`,
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          hokimRecognitionTerms: [],
          localVocabularyAdditions: [],
        },
      });

      expect(res.statusCode).toBe(400);
      const err = JSON.parse(res.payload);
      expect(err.error?.code).toBe('VALIDATION_ERROR');
      expect(
        err.error?.validationErrors?.some((v: { path: (string | number)[] }) =>
          v.path.includes('hokimRecognitionTerms'),
        ),
      ).toBe(true);
    });

    it('rejects duplicate hokimRecognitionTerms (case-insensitive & NFC normalized) with 400', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/draft`,
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          hokimRecognitionTerms: ['Туман ҳокими', 'туман ҳокими'],
          localVocabularyAdditions: [],
        },
      });

      expect(res.statusCode).toBe(400);
      const err = JSON.parse(res.payload);
      expect(err.error?.code).toBe('VALIDATION_ERROR');
      expect(
        err.error?.validationErrors?.some((v: { message: string }) =>
          v.message.includes('такрорланмаслиги керак'),
        ),
      ).toBe(true);
    });

    it('rejects duplicate local vocabulary terms with 400', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/draft`,
        headers: {
          cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          hokimRecognitionTerms: ['Ҳоким'],
          localVocabularyAdditions: [
            { term: 'Боғбонлар', category: 'Маҳалла номлари' },
            { term: 'боғбонлар', category: 'Мўлжал ва жойлар' },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const err = JSON.parse(res.payload);
      expect(err.error?.code).toBe('VALIDATION_ERROR');
      expect(
        err.error?.validationErrors?.some((v: { message: string }) =>
          v.message.includes('такрорланмаслиги керак'),
        ),
      ).toBe(true);
    });
  });
});
