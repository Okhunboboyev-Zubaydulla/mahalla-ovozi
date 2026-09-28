import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { auditEvents, districts, districtTelegramGroups, accounts } from '../src/adapters/db/schema/index.js';
import { PrerequisiteItem } from '@mahalla-ovozi/api-contracts';
import { eq, desc } from 'drizzle-orm';
import pg from 'pg';

const SAME_ORIGIN_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

describe('Districts Activation Readiness & Disclosure Integration Tests', () => {
  let server: FastifyInstance;
  let pool: pg.Pool;
  let db: DbClient;

  const testUsername = `po_readiness_${Date.now()}`;
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

  describe('Auth & Origin Security Matrix (401/403/404 handling)', () => {
    it('GET /api/v1/districts/:id/readiness rejects unauthenticated requests with 401', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/districts/dist_test/readiness',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('POST /api/v1/districts/:id/disclosure-confirmation rejects unauthenticated requests with 401', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/districts/dist_test/disclosure-confirmation',
        headers: SAME_ORIGIN_HEADERS,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('POST /api/v1/districts/:id/disclosure-confirmation rejects cross-origin requests with 403', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/districts/dist_test/disclosure-confirmation',
        headers: {
          'sec-fetch-site': 'cross-site',
          cookie: authCookie,
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('GET /api/v1/districts/:id/readiness returns 404 for non-existent district', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/districts/dist_nonexistent_12345/readiness',
        headers: { cookie: authCookie },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('DISTRICT_NOT_FOUND');
    });

    it('POST /api/v1/districts/:id/disclosure-confirmation returns 404 for non-existent district', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/districts/dist_nonexistent_12345/disclosure-confirmation',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('DISTRICT_NOT_FOUND');
    });
  });

  describe('Authoritative Readiness Evaluation & Gating Lifecycle', () => {
    let testDistrictId: string;
    const districtName = `Readiness Test District ${Date.now()}`;

    beforeAll(async () => {
      // Create a new district for readiness testing
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/v1/districts',
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
        payload: {
          name: districtName,
          region: 'Тошкент вилояти',
        },
      });
      expect(createRes.statusCode).toBe(201);
      testDistrictId = createRes.json().district.id;
    });

    it('derives initial readiness with 4 passed and 4 incomplete/truthful items (AC 1, 2, 7)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/readiness`,
        headers: { cookie: authCookie },
      });

      expect(res.statusCode).toBe(200);
      const { readiness } = res.json();

      expect(readiness.districtId).toBe(testDistrictId);
      expect(readiness.districtName).toBe(districtName);
      expect(readiness.status).toBe('SETUP_INCOMPLETE');
      expect(readiness.isActivationReady).toBe(false);
      expect(readiness.passedCount).toBe(4);
      expect(readiness.totalCount).toBe(8);
      expect(readiness.disclosureConfirmedAt).toBeNull();
      expect(readiness.disclosureConfirmedById).toBeNull();

      const itemMap = new Map<string, PrerequisiteItem>(
        readiness.items.map((i: PrerequisiteItem) => [i.key, i])
      );

      // 1. District Identity -> passed
      const identity = itemMap.get('district_identity')!;
      expect(identity.status).toBe('passed');
      expect(identity.label).toBe('Туман маълумотлари');

      // 2. Access Eligibility -> passed
      const access = itemMap.get('access_eligibility')!;
      expect(access.status).toBe('passed');
      expect(access.label).toBe('Тизимга кириш ҳуқуқи');

      // 3. Analysis Configuration -> passed (baseline_v1)
      const config = itemMap.get('analysis_configuration')!;
      expect(config.status).toBe('passed');
      expect(config.label).toBe('Асосий таҳлил созламалари');

      // 4. District Isolation -> passed
      const isolation = itemMap.get('district_isolation')!;
      expect(isolation.status).toBe('passed');
      expect(isolation.label).toBe('Ҳудудий хавфсизлик чегараси');

      // 5. Disclosure Confirmation -> incomplete with actionRequired: true
      const disclosure = itemMap.get('disclosure_confirmation')!;
      expect(disclosure.status).toBe('incomplete');
      expect(disclosure.label).toBe('Операцион кириш очиқлигини тасдиқлаш');
      expect(disclosure.actionRequired).toBe(true);
      expect(disclosure.blockerReason).toBeDefined();

      // 6. Telegram Bot -> truthful incomplete (pending Story 1.4)
      const bot = itemMap.get('telegram_bot')!;
      expect(bot.status).toBe('incomplete');
      expect(bot.blockerReason).toContain('1.4');

      // 7. Group Mappings -> truthful incomplete (pending Story 1.5)
      const mappings = itemMap.get('group_mappings')!;
      expect(mappings.status).toBe('incomplete');
      expect(mappings.blockerReason).toBe('Маҳалла Telegram гуруҳлари ҳали бириктирилмаган.');

      // 8. Hokim Account -> truthful incomplete (pending Story 1.6)
      const hokim = itemMap.get('hokim_account')!;
      expect(hokim.status).toBe('incomplete');
      expect(hokim.blockerReason).toContain('1.6');
    });

    it('confirms standing access disclosure, updates timestamps, and logs audit event (AC 5, AD-9)', async () => {
      const confirmRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/disclosure-confirmation`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
          'user-agent': 'TestAgent/1.0',
        },
      });

      expect(confirmRes.statusCode).toBe(200);
      const body = confirmRes.json();
      expect(body.districtId).toBe(testDistrictId);
      expect(body.disclosureConfirmedAt).toBeDefined();
      expect(body.disclosureConfirmedById).toBe(poAccountId);

      // Verify in DB directly
      const [districtRow] = await db
        .select()
        .from(districts)
        .where(eq(districts.id, testDistrictId));
      expect(districtRow).toBeDefined();
      expect(districtRow!.disclosureConfirmedAt).toBeDefined();
      expect(districtRow!.disclosureConfirmedById).toBe(poAccountId);

      // Verify privacy-safe audit record in audit_events
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'DISTRICT_DISCLOSURE_CONFIRMED'))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(auditEvent).toBeDefined();
      expect(auditEvent!.actorId).toBe(poAccountId);
      expect(auditEvent!.actorRole).toBe('PRODUCT_OWNER');
      expect(auditEvent!.metadata).toEqual({
        districtId: testDistrictId,
        districtName: districtName,
        confirmedAt: districtRow!.disclosureConfirmedAt?.toISOString(),
      });

      // Verify re-fetching readiness now reflects passed disclosure item
      const updatedReadinessRes = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/readiness`,
        headers: { cookie: authCookie },
      });

      expect(updatedReadinessRes.statusCode).toBe(200);
      const { readiness: updatedReadiness } = updatedReadinessRes.json();
      expect(updatedReadiness.passedCount).toBe(5);
      expect(updatedReadiness.isActivationReady).toBe(false); // Still blocked by 6, 7, 8
      expect(updatedReadiness.disclosureConfirmedAt).toBeDefined();
      expect(updatedReadiness.disclosureConfirmedById).toBe(poAccountId);

      const disclosureItem = updatedReadiness.items.find(
        (i: any) => i.key === 'disclosure_confirmation'
      );
      expect(disclosureItem.status).toBe('passed');
      expect(disclosureItem.completedAt).toBeDefined();
      expect(disclosureItem.completedBy).toBe(poAccountId);
    });

    it('evaluates access_eligibility as failed when district.accessEligible is false (AC 3)', async () => {
      // Temporarily mark accessEligible as false in DB
      await db
        .update(districts)
        .set({ accessEligible: false })
        .where(eq(districts.id, testDistrictId));

      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/readiness`,
        headers: { cookie: authCookie },
      });

      expect(res.statusCode).toBe(200);
      const { readiness } = res.json();
      const accessItem = readiness.items.find((i: any) => i.key === 'access_eligibility');
      expect(accessItem.status).toBe('failed');
      expect(accessItem.blockerReason).toBe('Туманнинг тизимга кириш ҳуқуқи чекланган.');

      // Restore accessEligible
      await db
        .update(districts)
        .set({ accessEligible: true })
        .where(eq(districts.id, testDistrictId));
    });

    it('evaluates analysis_configuration as incomplete when profile differs from baseline_v1 (AC 4)', async () => {
      // Temporarily alter config profile in DB
      await db
        .update(districts)
        .set({ analysisConfigProfileId: 'custom_v2' })
        .where(eq(districts.id, testDistrictId));

      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/readiness`,
        headers: { cookie: authCookie },
      });

      expect(res.statusCode).toBe(200);
      const { readiness } = res.json();
      const configItem = readiness.items.find((i: any) => i.key === 'analysis_configuration');
      expect(configItem.status).toBe('incomplete');
      expect(configItem.blockerReason).toBe('Базавий таҳлил профили созланмаган.');

      // Restore baseline_v1
      await db
        .update(districts)
        .set({ analysisConfigProfileId: 'baseline_v1' })
        .where(eq(districts.id, testDistrictId));
    });

    it('rejects disclosure confirmation on already ACTIVE districts with 409 Conflict (P3/AC 5)', async () => {
      // Temporarily mark district as ACTIVE
      await db
        .update(districts)
        .set({ status: 'ACTIVE' })
        .where(eq(districts.id, testDistrictId));

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/disclosure-confirmation`,
        headers: {
          ...SAME_ORIGIN_HEADERS,
          cookie: authCookie,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DISTRICT_ALREADY_ACTIVE');

      // Restore status to SETUP_INCOMPLETE
      await db
        .update(districts)
        .set({ status: 'SETUP_INCOMPLETE' })
        .where(eq(districts.id, testDistrictId));
    });

    it('evaluates group_mappings prerequisite dynamically based on database state (AC 12)', async () => {
      const groupId = `dtg_${Date.now()}`;
      const chatId = `-100${Date.now()}`;

      // 1. Initially 0 groups -> incomplete
      let res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/readiness`,
        headers: { cookie: authCookie },
      });
      let groupItem = res.json().readiness.items.find((i: any) => i.key === 'group_mappings');
      expect(groupItem.status).toBe('incomplete');
      expect(groupItem.blockerReason).toBe('Маҳалла Telegram гуруҳлари ҳали бириктирилмаган.');

      // 2. Insert PENDING group -> still incomplete
      await db.insert(districtTelegramGroups).values({
        id: groupId,
        districtId: testDistrictId,
        mahallaName: 'Dinamo Mahalla',
        telegramChatId: chatId,
        telegramChatTitle: 'Dinamo Chat',
        status: 'PENDING',
      });

      res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/readiness`,
        headers: { cookie: authCookie },
      });
      groupItem = res.json().readiness.items.find((i: any) => i.key === 'group_mappings');
      expect(groupItem.status).toBe('incomplete');
      expect(groupItem.blockerReason).toContain('тўлиқ синовдан ўтмаган');

      // 3. Mark group as VALID -> becomes passed
      await db
        .update(districtTelegramGroups)
        .set({ status: 'VALID', lastValidatedAt: new Date() })
        .where(eq(districtTelegramGroups.id, groupId));

      res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/readiness`,
        headers: { cookie: authCookie },
      });
      groupItem = res.json().readiness.items.find((i: any) => i.key === 'group_mappings');
      expect(groupItem.status).toBe('passed');
      expect(groupItem.description).toContain('1 та маҳалла Telegram гуруҳи муваффақиятли бириктирилди');
      expect(groupItem.completedAt).toBeDefined();

      // Clean up
      await db.delete(districtTelegramGroups).where(eq(districtTelegramGroups.id, groupId));
    });

    it('dynamically evaluates Prerequisite 8 (hokim_account) from accounts table (Story 1.6 / AC 13)', async () => {
      // 1. Initial state: no Hokim account -> incomplete
      let res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/readiness`,
        headers: { cookie: authCookie },
      });
      let hokimItem = res.json().readiness.items.find((i: any) => i.key === 'hokim_account');
      expect(hokimItem.status).toBe('incomplete');
      expect(hokimItem.actionRequired).toBe(true);
      expect(hokimItem.actionPath).toBe('/hokim-accounts');

      // 2. Create active Hokim account -> passed
      const username = `hokim_readiness_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const createRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
        payload: { username },
      });
      expect(createRes.statusCode).toBe(201);
      const { account } = createRes.json();

      res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/readiness`,
        headers: { cookie: authCookie },
      });
      hokimItem = res.json().readiness.items.find((i: any) => i.key === 'hokim_account');
      expect(hokimItem.status).toBe('passed');
      expect(hokimItem.actionRequired).toBe(false);
      expect(hokimItem.description).toContain(`@${username}`);
      expect(hokimItem.completedAt).toBeDefined();

      // 3. Disable Hokim account -> transitions back to incomplete
      const disRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${testDistrictId}/hokim-account/disable`,
        headers: { ...SAME_ORIGIN_HEADERS, cookie: authCookie },
      });
      expect(disRes.statusCode).toBe(200);

      res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${testDistrictId}/readiness`,
        headers: { cookie: authCookie },
      });
      hokimItem = res.json().readiness.items.find((i: any) => i.key === 'hokim_account');
      expect(hokimItem.status).toBe('incomplete');
      expect(hokimItem.actionRequired).toBe(true);
      expect(hokimItem.blockerReason).toContain('фаолсизлантирилган');

      // Clean up
      await db.delete(accounts).where(eq(accounts.id, account.id));
    });
  });
});
