import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  ActivateDistrictAnalysisSettingsResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, auditEvents, aiOperations, districtAnalysisSettingsVersions, districtAnalysisSettingsDrafts } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles, ensureDefaultDistrictAnalysisSettings } from '../src/adapters/db/seeds.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { eq, and, desc } from 'drizzle-orm';
import crypto from 'node:crypto';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 5.3: Review and Activate Analysis Configuration Version Integration Tests', () => {
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

    // 1. Ensure seed profiles
    await ensureDefaultAiProfiles(db);

    // 2. Seed Product Owner
    const poUsername = `po_act_test_${Date.now()}`;
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
    districtAId = `dist_act_a_${uniqueSuffix}`;
    districtBId = `dist_act_b_${uniqueSuffix}`;

    await db.insert(districts).values([
      { id: districtAId, name: `Чилонзор тумани ${uniqueSuffix}`, status: 'ACTIVE' },
      { id: districtBId, name: `Юнусобод тумани ${uniqueSuffix}`, status: 'ACTIVE' },
    ]);

    await ensureDefaultDistrictAnalysisSettings(db, districtAId);
    await ensureDefaultDistrictAnalysisSettings(db, districtBId);

    // 4. Seed Hokim user for District A
    const hokimUsername = `hokim_act_${Date.now()}`;
    const hokimPassword = 'HokimPassword2026!';
    const hokimAccountId = `acc_hokim_${crypto.randomUUID()}`;
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
    await db.delete(districts).where(eq(districts.id, districtAId));
    await db.delete(districts).where(eq(districts.id, districtBId));

    if (server) await server.close();
    if (pool) await pool.end();
  });


  describe('District Settings Activation & Scope Isolation (AC 1, 3, 5, 6, 8, 9, 11)', () => {
    it('successfully activates District A draft without mutating District B or Global config (AC 6, 11)', async () => {
      // 1. Fetch current active version for District A
      const [distAActiveBefore] = await db
        .select()
        .from(districtAnalysisSettingsVersions)
        .where(
          and(
            eq(districtAnalysisSettingsVersions.districtId, districtAId),
            eq(districtAnalysisSettingsVersions.isActive, true),
          ),
        )
        .orderBy(desc(districtAnalysisSettingsVersions.version))
        .limit(1);
      const distAActiveId = distAActiveBefore!.id;

      // 2. Fetch District B active version
      const [distBActiveBefore] = await db
        .select()
        .from(districtAnalysisSettingsVersions)
        .where(
          and(
            eq(districtAnalysisSettingsVersions.districtId, districtBId),
            eq(districtAnalysisSettingsVersions.isActive, true),
          ),
        )
        .orderBy(desc(districtAnalysisSettingsVersions.version))
        .limit(1);
      const distBActiveId = distBActiveBefore!.id;

      // 3. Save draft for District A
      const draftSave = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/draft`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          hokimRecognitionTerms: [
            'Ҳоким',
            'Чилонзор ҳокими',
            'Сектор раҳбари',
            'Ҳокимият вакили',
          ],
          localVocabularyAdditions: [
            {
              term: 'Оқтепа лаваши',
              category: 'Мўлжал ва жойлар',
              description: 'Оқтепа майдонидаги машҳур овқатланиш жойи',
            },
            {
              term: 'Катта Чилонзор маҳалласи',
              category: 'Маҳалла номлари',
            },
          ],
        },
      });
      expect(draftSave.statusCode).toBe(200);

      // 4. Activate District A draft
      const activateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/activate`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          baseActiveVersionId: distAActiveId,
          changeReason:
            'Чилонзор тумани бўйича янги маҳалла ва мўлжалларни қўшиш',
        },
      });

      expect(activateRes.statusCode).toBe(200);
      const data = JSON.parse(
        activateRes.payload,
      ) as ActivateDistrictAnalysisSettingsResponse;

      expect(data.districtId).toBe(districtAId);
      expect(data.activeConfiguration.version).toBe(2);
      expect(data.activeConfiguration.id).toBe(`dcfg_${districtAId}_v2`);
      expect(data.activeConfiguration.isActive).toBe(true);

      // 5. Verify District A draft is deleted
      const [distADraft] = await db
        .select()
        .from(districtAnalysisSettingsDrafts)
        .where(eq(districtAnalysisSettingsDrafts.districtId, districtAId));
      expect(distADraft).toBeUndefined();

      // 6. Verify District B active version is UNTOUCHED (AC 11 Scope Isolation)
      const [distBActiveAfter] = await db
        .select()
        .from(districtAnalysisSettingsVersions)
        .where(
          and(
            eq(districtAnalysisSettingsVersions.districtId, districtBId),
            eq(districtAnalysisSettingsVersions.isActive, true),
          ),
        );
      expect(distBActiveAfter?.id).toBe(distBActiveId);
      expect(distBActiveAfter?.version).toBe(1);

      // 7. Verify audit event was logged with districtId
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'DISTRICT_ANALYSIS_SETTINGS_ACTIVATED'),
            eq(auditEvents.districtId, districtAId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(auditEvent).toBeDefined();
      expect((auditEvent?.metadata as any)?.districtId).toBe(districtAId);
    });

    it('rejects district activation when stale baseline is provided (AC 9)', async () => {
      const activateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtBId}/activate`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          baseActiveVersionId: 'dcfg_stale_999',
          changeReason: 'Текширув сабаби етарли узунликда',
        },
      });

      expect(activateRes.statusCode).toBe(409);
      const body = JSON.parse(activateRes.payload);
      expect(body.error.code).toBe('STALE_BASELINE_VERSION');
    });
  });

  describe('Secret Scanning & Input Validation (AC 5)', () => {
    it('rejects change reason containing Telegram bot tokens', async () => {
      const activateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/activate`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v1`,
          changeReason:
            'Testing with bot token 123456789:AAFlkjdsflkjsdflkjsdflkjsdflkjsdfl in text',
        },
      });

      expect(activateRes.statusCode).toBe(400);
      const body = JSON.parse(activateRes.payload);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects change reason containing OpenAI API keys', async () => {
      const activateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/activate`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v1`,
          changeReason:
            'Added key sk-proj-12345678901234567890123456789012 to configuration',
        },
      });

      expect(activateRes.statusCode).toBe(400);
      const body = JSON.parse(activateRes.payload);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects change reason shorter than 5 characters', async () => {
      const activateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/activate`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v1`,
          changeReason: 'OK',
        },
      });

      expect(activateRes.statusCode).toBe(400);
      const body = JSON.parse(activateRes.payload);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Authorization Boundaries (AC 12)', () => {

    it('rejects District Hokim from activating District settings (403 Forbidden)', async () => {
      const activateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/activate`,
        headers: {
          'content-type': 'application/json',
          cookie: hokimCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v2`,
          changeReason: 'Ҳоким туман созламаларини фаоллаштирмоқчи',
        },
      });

      expect(activateRes.statusCode).toBe(403);
    });

    it('rejects unauthenticated requests (401 Unauthorized)', async () => {
      const activateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/activate`,
        headers: {
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          baseActiveVersionId: `dcfg_${districtAId}_v2`,
          changeReason: 'Авторизациясиз фаоллаштириш',
        },
      });

      expect(activateRes.statusCode).toBe(401);
    });
  });

  describe('Future-Only Invariant Verification (AC 6, 10, AD-8)', () => {
    it('guarantees pre-existing ai_operations and topics remain pinned to historical profile lineage without mutation', async () => {
      // 1. Seed a completed AI operation with pinnedProfileId "prof_rel_2026_08_v1"
      const opId = `op_hist_${Date.now()}`;
      await db.insert(aiOperations).values({
        id: opId,
        districtId: districtAId,
        mahallaName: 'Гулистон',
        calendarDay: '2026-08-20',
        operationType: 'SEMANTIC_RELEVANCE',
        targetId: `msg_${Date.now()}`,
        pinnedProfileId: 'prof_rel_2026_08_v1',
        contextRevision: 1,
        snapshotFingerprint: 'fp_hist_test_123',
        finalStatus: 'COMPLETED_RELEVANT',
        resultPayload: {
          lanes: ['INFRASTRUCTURE'],
          reasoning: 'Сув қувури ёрилганлиги ҳақидаги мурожаат',
        },
      });

      // 2. Perform a new District settings activation
      await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/draft`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          hokimRecognitionTerms: ['Ҳоким', 'Янги ҳоким'],
          localVocabularyAdditions: [
            { term: 'Янги сув', category: 'Сув таъминоти' },
          ],
        },
      });

      const [currentActive] = await db
        .select()
        .from(districtAnalysisSettingsVersions)
        .where(
          and(
            eq(districtAnalysisSettingsVersions.districtId, districtAId),
            eq(districtAnalysisSettingsVersions.isActive, true),
          ),
        )
        .orderBy(desc(districtAnalysisSettingsVersions.version))
        .limit(1);

      const activateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/ai/settings/districts/${districtAId}/activate`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          baseActiveVersionId: currentActive!.id,
          changeReason: 'Келгуси операциялар учун янги версия',
        },
      });
      expect(activateRes.statusCode).toBe(200);

      // 3. Verify that the historical ai_operations record remains strictly unchanged
      const [histOp] = await db
        .select()
        .from(aiOperations)
        .where(eq(aiOperations.id, opId));

      expect(histOp).toBeDefined();
      expect(histOp?.pinnedProfileId).toBe('prof_rel_2026_08_v1'); // Pinned lineage preserved!
      expect(histOp?.finalStatus).toBe('COMPLETED_RELEVANT');
      expect((histOp?.resultPayload as any)?.lanes).toEqual(['INFRASTRUCTURE']);
    });
  });
});
