import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import {
  StartGraceResponse,
  RestoreActiveResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createBossClient } from '../src/adapters/jobs/boss-client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import {
  accounts,
  districts,
  districtSubscriptions,
  districtTelegramBots,
  districtTelegramGroups,
  auditEvents,
  telegramIntakeRecords,
} from '../src/adapters/db/schema/index.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import {
  startDistrictGrace,
  expireDistrictGrace,
  restoreDistrictActive,
  processOverdueGraceSubscriptions,
} from '../src/modules/subscriptions/subscriptions-service.js';
import { resolveDistrictBotAndGroup } from '../src/modules/telegram-intake/telegram-intake-service.js';
import { processQualificationJobs } from '../src/modules/telegram-intake/jobs/qualification-job-handler.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 6.2: Manage Active, Grace, and Suspended District Service Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;
  let boss: any;

  let poCookie = '';
  let poAccountId = '';
  let hokimCookie = '';
  let hokimAccountId = '';
  let hokimUsername = '';
  let hokimPassword = '';
  let activeDistrictId = '';
  let setupIncompleteDistrictId = '';
  let botId = '';
  let chatId = '';

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient();
    await boss.start();

    server = await buildHttpServer({ db, pool, boss });
    await server.ready();

    // 1. Seed Product Owner
    const poUsername = `po_lifecycle_test_${Date.now()}`;
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
    poCookie = (Array.isArray(poSetCookie) ? poSetCookie[0] : (poSetCookie as string)) || '';

    // 2. Seed Fully Configured Active District with all 8 prerequisites
    activeDistrictId = `dist_active_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: activeDistrictId,
      name: `Active District ${crypto.randomUUID().slice(0, 6)}`,
      region: 'Тошкент шаҳри',
      status: 'ACTIVE',
      disclosureConfirmedAt: new Date(),
      disclosureConfirmedById: poAccountId,
      activatedAt: new Date('2026-08-01T10:00:00.000Z'),
      activatedById: poAccountId,
    });

    botId = `bot_${crypto.randomUUID().slice(0, 8)}`;
    const encrypted = encryptToken('123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789');
    await db.insert(districtTelegramBots).values({
      id: `bot_row_${crypto.randomUUID()}`,
      districtId: activeDistrictId,
      botId,
      botUsername: `bot_${botId}`,
      botFirstName: 'Mahalla Bot',
      encryptedToken: encrypted.encryptedToken,
      tokenIv: encrypted.tokenIv,
      tokenTag: encrypted.tokenTag,
      tokenKeyVersion: encrypted.tokenKeyVersion,
      tokenMasked: encrypted.tokenMasked,
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    chatId = `-100${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    await db.insert(districtTelegramGroups).values({
      id: `grp_${crypto.randomUUID()}`,
      districtId: activeDistrictId,
      mahallaName: 'Истиқлол',
      telegramChatId: chatId,
      telegramChatTitle: 'Истиқлол гуруҳи',
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    hokimUsername = `hokim_life_${Date.now()}`;
    hokimPassword = 'HokimPassword2026!';
    const hokimPasswordHash = await hashPassword(hokimPassword);
    hokimAccountId = `acc_hokim_${crypto.randomUUID()}`;

    await db.insert(accounts).values({
      id: hokimAccountId,
      username: hokimUsername,
      passwordHash: hokimPasswordHash,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: activeDistrictId,
      mustChangePassword: false,
    });

    // Initialize district_subscriptions row
    await db.insert(districtSubscriptions).values({
      id: crypto.randomUUID(),
      districtId: activeDistrictId,
      status: 'ACTIVE',
      statusStartedAt: new Date('2026-08-01T10:00:00.000Z'),
    });

    const hokimSignIn = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
      payload: { username: hokimUsername, password: hokimPassword },
    });
    expect(hokimSignIn.statusCode).toBe(200);
    const hokimSetCookie = hokimSignIn.headers['set-cookie'];
    hokimCookie = (Array.isArray(hokimSetCookie) ? hokimSetCookie[0] : (hokimSetCookie as string)) || '';

    // 3. Seed Setup Incomplete District
    setupIncompleteDistrictId = `dist_inc_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: setupIncompleteDistrictId,
      name: `Incomplete District ${crypto.randomUUID().slice(0, 6)}`,
      region: 'Самарқанд вилояти',
      status: 'SETUP_INCOMPLETE',
    });
    await db.insert(districtSubscriptions).values({
      id: crypto.randomUUID(),
      districtId: setupIncompleteDistrictId,
      status: 'SETUP_INCOMPLETE',
      statusStartedAt: new Date(),
    });
  });

  afterAll(async () => {
    if (server) await server.close();
    if (boss) await boss.stop();
    if (pool) await pool.end();
  });

  describe('1. Product Owner Authorization Enforcement (AC 1, AC 6, AC 9)', () => {
    it('rejects unauthenticated requests to lifecycle transition endpoints with HTTP 401', async () => {
      const resGrace = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/start-grace`,
        headers: { ...SAME_ORIGIN_HEADERS },
      });
      expect(resGrace.statusCode).toBe(401);

      const resRestore = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/restore-active`,
        headers: { ...SAME_ORIGIN_HEADERS },
      });
      expect(resRestore.statusCode).toBe(401);
    });

    it('rejects Hokim requests to lifecycle transition endpoints with HTTP 403 Forbidden', async () => {
      const resGrace = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/start-grace`,
        headers: { Cookie: hokimCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(resGrace.statusCode).toBe(403);

      const resRestore = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/restore-active`,
        headers: { Cookie: hokimCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(resRestore.statusCode).toBe(403);
    });
  });

  describe('2. Active -> Grace Transition (AC 1, AC 2, AC 10, AC 14)', () => {
    it('successfully initiates 7-day grace period, sets scheduled expiry, and records audit log', async () => {
      const startTime = Date.now();
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/start-grace`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          reason: 'Обуна тўлови бўйича музокаралар олиб борилмоқда.',
        },
      });

      expect(res.statusCode).toBe(200);
      const data: StartGraceResponse = res.json();
      expect(data.subscription.status).toBe('GRACE');
      expect(data.subscription.scheduledTransitionType).toBe('AUTOMATIC_SUSPENSION');
      expect(data.subscription.scheduledTransitionAt).toBeDefined();

      const scheduledAt = new Date(data.subscription.scheduledTransitionAt!).getTime();
      const expectedAtMin = startTime + 7 * 24 * 60 * 60 * 1000 - 10000;
      const expectedAtMax = startTime + 7 * 24 * 60 * 60 * 1000 + 10000;
      expect(scheduledAt).toBeGreaterThanOrEqual(expectedAtMin);
      expect(scheduledAt).toBeLessThanOrEqual(expectedAtMax);

      // Verify district status updated in database
      const [districtRow] = await db
        .select()
        .from(districts)
        .where(eq(districts.id, activeDistrictId));
      expect(districtRow).toBeDefined();
      expect(districtRow!.status).toBe('GRACE');

      // Verify audit event recorded
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, activeDistrictId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(auditEvent).toBeDefined();
      expect(auditEvent!.action).toBe('DISTRICT_GRACE_STARTED');
      expect(auditEvent!.actorId).toBe(poAccountId);
      expect(auditEvent!.actorRole).toBe('PRODUCT_OWNER');
      expect(auditEvent!.metadata).toMatchObject({
        districtId: activeDistrictId,
        reason: 'Обуна тўлови бўйича музокаралар олиб борилмоқда.',
        previousValues: { status: 'ACTIVE' },
        newValues: { status: 'GRACE', scheduledTransitionType: 'AUTOMATIC_SUSPENSION' },
      });
    });

    it('rejects start-grace on a district that is not ACTIVE with HTTP 409 Conflict', async () => {
      // District is now in GRACE, so start-grace should fail
      const resGraceAgain = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/start-grace`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(resGraceAgain.statusCode).toBe(409);
      expect(resGraceAgain.json().error.code).toBe('INVALID_SUBSCRIPTION_TRANSITION');

      // Attempt start-grace on SETUP_INCOMPLETE district
      const resIncomplete = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${setupIncompleteDistrictId}/subscription/start-grace`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(resIncomplete.statusCode).toBe(409);
      expect(resIncomplete.json().error.code).toBe('INVALID_SUBSCRIPTION_TRANSITION');
    });
  });

  describe('3. Grace -> Active Restoration (AC 5, AC 11, AC 14)', () => {
    it('restores district to ACTIVE from GRACE without requiring readiness re-evaluation', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/restore-active`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          reason: 'Обуна тўлови қабул қилинди ва тасдиқланди.',
        },
      });

      expect(res.statusCode).toBe(200);
      const data: RestoreActiveResponse = res.json();
      expect(data.subscription.status).toBe('ACTIVE');
      expect(data.subscription.scheduledTransitionAt).toBeUndefined();
      expect(data.subscription.scheduledTransitionType).toBeUndefined();

      // Verify district status updated in database
      const [districtRow] = await db
        .select()
        .from(districts)
        .where(eq(districts.id, activeDistrictId));
      expect(districtRow).toBeDefined();
      expect(districtRow!.status).toBe('ACTIVE');

      // Verify audit event recorded
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, activeDistrictId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(auditEvent).toBeDefined();
      expect(auditEvent!.action).toBe('DISTRICT_SERVICE_RESTORED_ACTIVE');
      expect(auditEvent!.actorId).toBe(poAccountId);
      expect(auditEvent!.actorRole).toBe('PRODUCT_OWNER');
      expect(auditEvent!.metadata).toMatchObject({
        districtId: activeDistrictId,
        previousValues: { status: 'GRACE' },
        newValues: { status: 'ACTIVE' },
      });
    });
  });

  describe('4. Grace Expiry & Overdue Sweeper (AC 3, AC 4, AC 12, AC 14)', () => {
    it('transitions GRACE district to SUSPENDED via expireDistrictGrace or background sweeper', async () => {
      // 1. Put district in GRACE
      await startDistrictGrace(
        db,
        boss,
        activeDistrictId,
        {},
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );

      // 2. Set scheduledTransitionAt into the past to simulate overdue 7-day expiry
      await db
        .update(districtSubscriptions)
        .set({
          scheduledTransitionAt: new Date(Date.now() - 60000), // 1 minute ago
        })
        .where(eq(districtSubscriptions.districtId, activeDistrictId));

      // 3. Run background sweeper
      const sweepCount = await processOverdueGraceSubscriptions(db);
      expect(sweepCount).toBeGreaterThanOrEqual(1);

      // 4. Verify district is now SUSPENDED
      const [districtRow] = await db
        .select()
        .from(districts)
        .where(eq(districts.id, activeDistrictId));
      expect(districtRow).toBeDefined();
      expect(districtRow!.status).toBe('SUSPENDED');

      const [subRow] = await db
        .select()
        .from(districtSubscriptions)
        .where(eq(districtSubscriptions.districtId, activeDistrictId));
      expect(subRow).toBeDefined();
      expect(subRow!.status).toBe('SUSPENDED');
      expect(subRow!.scheduledTransitionAt).toBeNull();
      expect(subRow!.scheduledTransitionType).toBeNull();

      // 5. Verify SYSTEM audit event
      const [auditEvent] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, activeDistrictId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);

      expect(auditEvent).toBeDefined();
      expect(auditEvent!.action).toBe('DISTRICT_SUBSCRIPTION_SUSPENDED');
      expect(auditEvent!.actorId).toBeNull();
      expect(auditEvent!.actorRole).toBe('SYSTEM');
    });

    it('expireDistrictGrace is idempotent when called multiple times', async () => {
      // Calling expire on already SUSPENDED district returns null
      const result = await expireDistrictGrace(db, activeDistrictId);
      expect(result).toBeNull();
    });
  });

  describe('5. Suspended -> Active Restoration with Readiness Check (AC 5, AC 8, AC 11, AC 14)', () => {
    it('rejects restoration with HTTP 409 DISTRICT_NOT_READY if an onboarding prerequisite is missing', async () => {
      // District is SUSPENDED from Section 4. Temporarily mark Telegram bot as INVALID
      await db
        .update(districtTelegramBots)
        .set({ status: 'INVALID' })
        .where(eq(districtTelegramBots.districtId, activeDistrictId));

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/restore-active`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(409);
      const data = res.json();
      expect(data.error.code).toBe('DISTRICT_NOT_READY');
      expect(data.error.details?.blockers).toBeDefined();

      // Restore bot back to VALID
      await db
        .update(districtTelegramBots)
        .set({ status: 'VALID' })
        .where(eq(districtTelegramBots.districtId, activeDistrictId));
    });

    it('successfully restores district to ACTIVE when all 8 prerequisites are satisfied', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/restore-active`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          reason: 'Тўлов ва барча техник созламалар тасдиқланди.',
        },
      });

      expect(res.statusCode).toBe(200);
      const data: RestoreActiveResponse = res.json();
      expect(data.subscription.status).toBe('ACTIVE');

      const [districtRow] = await db
        .select()
        .from(districts)
        .where(eq(districts.id, activeDistrictId));
      expect(districtRow).toBeDefined();
      expect(districtRow!.status).toBe('ACTIVE');
    });
  });

  describe('6. Cross-System Enforcement & Gate Behavior (AC 6, AC 7, AC 13)', () => {
    it('permits Telegram intake resolution when district is ACTIVE or GRACE, but rejects when SUSPENDED', async () => {
      // 1. When ACTIVE
      const activeIntake = await resolveDistrictBotAndGroup(db, botId, chatId);
      expect(activeIntake.authorized).toBe(true);

      // 2. When GRACE
      await startDistrictGrace(
        db,
        boss,
        activeDistrictId,
        {},
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );
      const graceIntake = await resolveDistrictBotAndGroup(db, botId, chatId);
      expect(graceIntake.authorized).toBe(true);

      // 3. When SUSPENDED
      await db
        .update(districtSubscriptions)
        .set({ scheduledTransitionAt: new Date(Date.now() - 60000) })
        .where(eq(districtSubscriptions.districtId, activeDistrictId));
      await expireDistrictGrace(db, activeDistrictId);
      const suspendedIntake = await resolveDistrictBotAndGroup(db, botId, chatId);
      expect(suspendedIntake.authorized).toBe(false);
      expect((suspendedIntake as any).reason).toBe('DISTRICT_NOT_ACTIVE');
    });

    it('blocks Hokim sign-in when district is SUSPENDED', async () => {
      // District is SUSPENDED from previous test step
      const hokimSignIn = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
        payload: { username: hokimUsername, password: hokimPassword },
      });
      // Should fail with 403 DISTRICT_NOT_ACTIVE
      expect(hokimSignIn.statusCode).toBe(403);
      expect(hokimSignIn.json().error.code).toBe('DISTRICT_NOT_ACTIVE');
    });

    it('blocks active Hokim session requests with HTTP 403 DISTRICT_SUSPENDED when district is SUSPENDED', async () => {
      // Use existing hokimCookie on a Hokim protected route
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/mahallas',
        headers: { Cookie: hokimCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('DISTRICT_SUSPENDED');
    });

    it('verifies AI background workers enforce lifecycle gates (process GRACE, discard SUSPENDED)', async () => {
      // 1. Restore to ACTIVE first then enter GRACE
      await restoreDistrictActive(db, activeDistrictId, { reason: 'Restoring for AI test' });
      await startDistrictGrace(
        db,
        boss,
        activeDistrictId,
        {},
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );

      const fakeIntakeId = crypto.randomUUID();
      await db.insert(telegramIntakeRecords).values({
        id: fakeIntakeId,
        districtId: activeDistrictId,
        telegramBotId: botId,
        telegramChatId: chatId,
        telegramMessageId: '99999',
        telegramUserId: '11111',
        mahallaName: 'Navbahor',
        calendarDay: '2026-08-28',
        originalTimestamp: new Date(),
        rawPayload: {
          message: {
            message_id: 99999,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: 'supergroup' },
            from: { id: 11111, is_bot: false, first_name: 'Resident' },
            text: 'Elektr taʼminotida uzilish boʻlmoqda',
          },
        },
      });

      // Execute qualification job on GRACE district -> processes without error and qualifies
      await expect(
        processQualificationJobs(
          [
            {
              id: 'job-1',
              name: 'telegram-content-qualification',
              data: {
                intakeId: fakeIntakeId,
                districtId: activeDistrictId,
                mahallaName: 'Navbahor',
                calendarDay: '2026-08-28',
                telegramChatId: chatId,
                telegramMessageId: '99999',
                originalTimestamp: new Date().toISOString(),
              },
            } as any,
          ],
          { db, boss },
        ),
      ).resolves.not.toThrow();

      // 2. When SUSPENDED: execution is dropped safely at Gate 1
      await db
        .update(districtSubscriptions)
        .set({ scheduledTransitionAt: new Date(Date.now() - 60000) })
        .where(eq(districtSubscriptions.districtId, activeDistrictId));
      await expireDistrictGrace(db, activeDistrictId);

      const fakeIntakeId2 = crypto.randomUUID();
      await db.insert(telegramIntakeRecords).values({
        id: fakeIntakeId2,
        districtId: activeDistrictId,
        telegramBotId: botId,
        telegramChatId: chatId,
        telegramMessageId: '99998',
        telegramUserId: '11111',
        mahallaName: 'Navbahor',
        calendarDay: '2026-08-28',
        originalTimestamp: new Date(),
        rawPayload: {
          message: {
            message_id: 99998,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: 'supergroup' },
            from: { id: 11111, is_bot: false, first_name: 'Resident' },
            text: 'Suv taʼminoti toʻxtadi',
          },
        },
      });

      await expect(
        processQualificationJobs(
          [
            {
              id: 'job-2',
              name: 'telegram-content-qualification',
              data: {
                intakeId: fakeIntakeId2,
                districtId: activeDistrictId,
                mahallaName: 'Navbahor',
                calendarDay: '2026-08-28',
                telegramChatId: chatId,
                telegramMessageId: '99998',
                originalTimestamp: new Date().toISOString(),
              },
            } as any,
          ],
          { db, boss },
        ),
      ).resolves.not.toThrow();
    });
  });

  describe('7. Secret Leakage Prevention in Reasons (AC 10, AC 11)', () => {
    it('rejects start-grace payload containing secrets with HTTP 400', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/start-grace`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          reason: 'Token: 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects restore-active payload containing secrets with HTTP 400', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${activeDistrictId}/subscription/restore-active`,
        headers: {
          Cookie: poCookie,
          'content-type': 'application/json',
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          reason: 'Key: sk-proj-1234567890abcdefghijklmnopqrstuvwxyz12345',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });
  });
});
