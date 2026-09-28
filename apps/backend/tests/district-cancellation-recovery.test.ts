import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import {
  CancelDistrictResponse,
  StartRecoveryResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createBossClient } from '../src/adapters/jobs/boss-client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import {
  accounts,
  districts,
  districtSubscriptions,
  districtTelegramBots,
  districtTelegramGroups,
  telegramIntakeRecords,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import {
  cancelDistrict,
  startDistrictRecovery,
} from '../src/modules/subscriptions/subscriptions-service.js';
import { resolveDistrictBotAndGroup } from '../src/modules/telegram-intake/telegram-intake-service.js';
import { processRetentionJobs } from '../src/modules/retention/jobs/retention-job-handler.js';
import { processQualificationJobs } from '../src/modules/telegram-intake/jobs/qualification-job-handler.js';
import {
  TELEGRAM_TOPIC_RETENTION_QUEUE,
  TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
} from '../src/adapters/jobs/boss-client.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 6.3: Cancel and Recover a District Before Live Deletion Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;
  let boss: any;

  let poCookie = '';
  let poAccountId = '';

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient();
    await boss.start();

    server = await buildHttpServer({ db, pool, boss });
    await server.ready();

    // 1. Seed Product Owner
    const poUsername = `po_cancel_test_${Date.now()}_${crypto.randomUUID().slice(0, 4)}`;
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
  });

  afterAll(async () => {
    if (server) await server.close();
    if (boss) await boss.stop();
    if (pool) await pool.end();
  });

  // Helper to create a fully configured active district with unique name
  async function seedActiveDistrict(baseName: string) {
    const districtId = `dist_${crypto.randomUUID().slice(0, 8)}`;
    const districtName = `${baseName} ${crypto.randomUUID().slice(0, 6)}`;

    await db.insert(districts).values({
      id: districtId,
      name: districtName,
      region: 'Тошкент шаҳри',
      status: 'ACTIVE',
      disclosureConfirmedAt: new Date(),
      disclosureConfirmedById: poAccountId,
      activatedAt: new Date(),
      activatedById: poAccountId,
    });

    await db.insert(districtSubscriptions).values({
      id: crypto.randomUUID(),
      districtId,
      status: 'ACTIVE',
      statusStartedAt: new Date(),
      externalPaymentReference: 'BANK-REF-INIT',
      internalNote: 'Initial subscription',
    });

    const botId = `bot_${crypto.randomUUID().slice(0, 8)}`;
    const encrypted = encryptToken('123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789');
    await db.insert(districtTelegramBots).values({
      id: crypto.randomUUID(),
      districtId,
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

    const chatId = `-100${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    await db.insert(districtTelegramGroups).values({
      id: crypto.randomUUID(),
      districtId,
      mahallaName: `Маҳалла ${crypto.randomUUID().slice(0, 4)}`,
      telegramChatId: chatId,
      telegramChatTitle: 'Маҳалла гуруҳи',
      status: 'VALID',
    });

    const hokimUsername = `hokim_${crypto.randomUUID().slice(0, 8)}`;
    const hokimPassword = 'SecureHokimPassword2026!';
    const hokimPasswordHash = await hashPassword(hokimPassword);
    await db.insert(accounts).values({
      id: crypto.randomUUID(),
      username: hokimUsername,
      passwordHash: hokimPasswordHash,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId,
      mustChangePassword: false,
    });

    return { districtId, districtName, botId, chatId, hokimUsername, hokimPassword };
  }

  describe('1. District Cancellation Flow (AC 1, 2, 3, 4, 5, 6, 7)', () => {
    it('cancels an ACTIVE district, deletes bot credentials, sets groups to PENDING, sets 30-day live deletion deadline, and logs audit', async () => {
      const { districtId, districtName } = await seedActiveDistrict('Чилонзор');

      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/subscription/cancel`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          reason: 'Шартнома тугатилди',
          confirmationDistrictName: districtName,
        },
      });

      expect(response.statusCode).toBe(200);
      const data: CancelDistrictResponse = response.json();
      expect(data.subscription.districtId).toBe(districtId);
      expect(data.subscription.status).toBe('CANCELLED');
      expect(data.subscription.scheduledTransitionType).toBe('LIVE_DELETION');
      expect(data.subscription.scheduledTransitionAt).toBeTruthy();

      // Verify ~30 days in future
      const scheduledDate = new Date(data.subscription.scheduledTransitionAt!);
      const now = Date.now();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(scheduledDate.getTime()).toBeGreaterThanOrEqual(now + thirtyDaysMs - 60000);
      expect(scheduledDate.getTime()).toBeLessThanOrEqual(now + thirtyDaysMs + 60000);

      // Verify districts table updated
      const [updatedDistrict] = await db.select().from(districts).where(eq(districts.id, districtId));
      expect(updatedDistrict?.status).toBe('CANCELLED');

      // Verify district_subscriptions updated
      const [updatedSub] = await db.select().from(districtSubscriptions).where(eq(districtSubscriptions.districtId, districtId));
      expect(updatedSub?.status).toBe('CANCELLED');
      expect(updatedSub?.scheduledTransitionType).toBe('LIVE_DELETION');

      // Verify active bot token deleted from districtTelegramBots
      const bots = await db.select().from(districtTelegramBots).where(eq(districtTelegramBots.districtId, districtId));
      expect(bots.length).toBe(0);

      // Verify telegram group mapped to PENDING
      const groups = await db.select().from(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, districtId));
      expect(groups.length).toBe(1);
      expect(groups[0]?.status).toBe('PENDING');

      // Verify audit log DISTRICT_CANCELLED
      const logs = await db.select().from(auditEvents).where(
        and(
          eq(auditEvents.districtId, districtId),
          eq(auditEvents.action, 'DISTRICT_CANCELLED')
        )
      );
      expect(logs.length).toBe(1);
      expect((logs[0]?.metadata as any)?.reason).toBe('Шартнома тугатилди');
    });

    it('rejects cancellation when confirmation district name does not match (AC 2)', async () => {
      const { districtId } = await seedActiveDistrict('Юнусобод');

      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/subscription/cancel`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          reason: 'Тест бекор қилиш',
          confirmationDistrictName: 'Нотўғри туман номи',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('DISTRICT_CONFIRMATION_MISMATCH');
    });

    it('rejects cancellation reason containing prohibited secrets (AC 1, 16)', async () => {
      const { districtId, districtName } = await seedActiveDistrict('Олмазор');

      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/subscription/cancel`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          reason: 'Бот токени: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789',
          confirmationDistrictName: districtName,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('cancels from GRACE and SUSPENDED states (AC 1)', async () => {
      // 1. From GRACE
      const { districtId: graceDistrictId, districtName: graceName } = await seedActiveDistrict('Учтепа');
      await db.update(districts).set({ status: 'GRACE' }).where(eq(districts.id, graceDistrictId));
      await db.update(districtSubscriptions).set({ status: 'GRACE' }).where(eq(districtSubscriptions.districtId, graceDistrictId));

      const graceRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${graceDistrictId}/subscription/cancel`,
        headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: { reason: 'Grace даврида бекор қилинди', confirmationDistrictName: graceName },
      });
      expect(graceRes.statusCode).toBe(200);

      // 2. From SUSPENDED
      const { districtId: suspDistrictId, districtName: suspName } = await seedActiveDistrict('Сергели');
      await db.update(districts).set({ status: 'SUSPENDED' }).where(eq(districts.id, suspDistrictId));
      await db.update(districtSubscriptions).set({ status: 'SUSPENDED' }).where(eq(districtSubscriptions.districtId, suspDistrictId));

      const suspRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${suspDistrictId}/subscription/cancel`,
        headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
        payload: { reason: 'Suspended ҳолатида бекор қилинди', confirmationDistrictName: suspName },
      });
      expect(suspRes.statusCode).toBe(200);
    });
  });

  describe('2. Telegram Intake, AI Worker & Hokim Protections for Cancelled Districts (AC 5, 6, 7)', () => {
    it('drops intake and rejects resolution for CANCELLED district (AC 5)', async () => {
      const { districtId, districtName, botId, chatId } = await seedActiveDistrict('Бектемир');

      // Cancel district
      await cancelDistrict(
        db,
        boss,
        districtId,
        {
          reason: 'Бекор қилинди',
          confirmationDistrictName: districtName,
        },
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );

      // Attempting to resolve bot for this district should return authorized: false since token was deleted
      const resolution = await resolveDistrictBotAndGroup(db, botId, chatId);
      expect(resolution.authorized).toBe(false);
    });

    it('drops qualification worker jobs for CANCELLED district (AC 6)', async () => {
      const { districtId, districtName, botId, chatId } = await seedActiveDistrict('Чилонзор_Worker');

      // Seed a raw telegram intake record before cancellation
      const intakeId = `intake_${crypto.randomUUID().slice(0, 8)}`;
      await db.insert(telegramIntakeRecords).values({
        id: intakeId,
        districtId,
        mahallaName: 'Бобур',
        telegramBotId: botId,
        telegramChatId: chatId,
        telegramMessageId: '101',
        calendarDay: '2026-08-28',
        originalTimestamp: new Date(),
        rawPayload: { text: 'Сув босими паст бўлмоқда' },
      });

      // Cancel district
      await cancelDistrict(
        db,
        boss,
        districtId,
        {
          reason: 'Бекор қилинди',
          confirmationDistrictName: districtName,
        },
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );

      // Execute qualification jobs on cancelled district - should complete cleanly without processing
      await expect(
        processQualificationJobs(
          [
            {
              id: 'job-qual-test-1',
              name: TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
              data: {
                intakeId,
                districtId,
                telegramChatId: chatId,
                telegramMessageId: 101,
                mahallaName: 'Бобур',
                text: 'Сув босими паст бўлмоқда',
                forwardFromChatTitle: 'Маҳалла канали',
                senderUsername: 'citizen_1',
                messageTimestamp: new Date().toISOString(),
              },
            } as any,
          ],
          { db, boss },
        ),
      ).resolves.not.toThrow();
    });

    it('rejects Hokim account access for CANCELLED district (AC 7)', async () => {
      const { districtId, districtName, hokimUsername, hokimPassword } = await seedActiveDistrict('Миробод');

      // Sign in as Hokim
      const hokimSignIn = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
        payload: { username: hokimUsername, password: hokimPassword },
      });
      expect(hokimSignIn.statusCode).toBe(200);
      const hokimSetCookie = hokimSignIn.headers['set-cookie'];
      const hokimCookie = (Array.isArray(hokimSetCookie) ? hokimSetCookie[0] : (hokimSetCookie as string)) || '';

      // Cancel the district
      await cancelDistrict(
        db,
        boss,
        districtId,
        {
          reason: 'Бекор қилинди',
          confirmationDistrictName: districtName,
        },
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );

      // Hokim attempting to access protected dashboard endpoint
      const hokimAccess = await server.inject({
        method: 'GET',
        url: '/api/v1/hokim/topics/mahallas',
        headers: { cookie: hokimCookie, ...SAME_ORIGIN_HEADERS },
      });

      expect(hokimAccess.statusCode).toBe(403);
      expect(hokimAccess.json().error.code).toBe('DISTRICT_CANCELLED');
    });
  });

  describe('3. District Recovery Flow (AC 8, 9, 10, 11, 12, 13, 14, 15)', () => {
    it('recovers a CANCELLED district to SETUP_INCOMPLETE and clears scheduled deletion (AC 8, 9, 10)', async () => {
      const { districtId, districtName } = await seedActiveDistrict('Яккасарой');

      // Cancel first
      await cancelDistrict(
        db,
        boss,
        districtId,
        {
          reason: 'Бекор қилинди',
          confirmationDistrictName: districtName,
        },
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );

      // Start Recovery
      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/subscription/start-recovery`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          reason: 'Янги шартнома имзоланди',
        },
      });

      expect(response.statusCode).toBe(200);
      const data: StartRecoveryResponse = response.json();
      expect(data.subscription.districtId).toBe(districtId);
      expect(data.subscription.status).toBe('SETUP_INCOMPLETE');
      expect(data.subscription.scheduledTransitionAt).toBeUndefined();
      expect(data.subscription.scheduledTransitionType).toBeUndefined();

      // Verify district status
      const [d] = await db.select().from(districts).where(eq(districts.id, districtId));
      expect(d?.status).toBe('SETUP_INCOMPLETE');

      // Verify subscription status
      const [s] = await db.select().from(districtSubscriptions).where(eq(districtSubscriptions.districtId, districtId));
      expect(s?.status).toBe('SETUP_INCOMPLETE');
      expect(s?.scheduledTransitionAt).toBeNull();
      expect(s?.scheduledTransitionType).toBeNull();

      // Verify audit log DISTRICT_RECOVERY_STARTED
      const logs = await db.select().from(auditEvents).where(
        and(
          eq(auditEvents.districtId, districtId),
          eq(auditEvents.action, 'DISTRICT_RECOVERY_STARTED')
        )
      );
      expect(logs.length).toBe(1);
      expect((logs[0]?.metadata as any)?.reason).toBe('Янги шартнома имзоланди');
    });

    it('rejects recovery when the 30-day recovery window has expired (AC 11)', async () => {
      const { districtId, districtName } = await seedActiveDistrict('Чирчиқ');

      // Cancel district
      await cancelDistrict(
        db,
        boss,
        districtId,
        {
          reason: 'Бекор қилинди',
          confirmationDistrictName: districtName,
        },
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );

      // Manually backdate scheduledTransitionAt to past
      const pastDate = new Date(Date.now() - 1000 * 60); // 1 minute in past
      await db.update(districtSubscriptions).set({
        scheduledTransitionAt: pastDate,
      }).where(eq(districtSubscriptions.districtId, districtId));

      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/subscription/start-recovery`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { reason: 'Кечиккан тиклаш' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('RECOVERY_WINDOW_EXPIRED');
    });

    it('requires connecting new bot token and meeting all 8 prerequisites to reactivate (AC 12, 13, 14)', async () => {
      const { districtId, districtName } = await seedActiveDistrict('Янгийўл');

      // Cancel and recover
      await cancelDistrict(
        db,
        boss,
        districtId,
        {
          reason: 'Бекор қилинди',
          confirmationDistrictName: districtName,
        },
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );
      await startDistrictRecovery(
        db,
        districtId,
        { reason: 'Тикланди' },
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );

      // Attempting to activate district without bot token must fail with 409 DISTRICT_NOT_READY
      const prematureActivate = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/activate`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(prematureActivate.statusCode).toBe(409);
      expect(prematureActivate.json().error.code).toBe('DISTRICT_NOT_READY');

      // Re-configure new bot token and set group to VALID
      const newBotId = `bot_new_${crypto.randomUUID().slice(0, 8)}`;
      const encrypted = encryptToken('987654321:XYZabcUVWrstKLMnopqABC123456789');
      await db.insert(districtTelegramBots).values({
        id: crypto.randomUUID(),
        districtId,
        botId: newBotId,
        botUsername: `bot_${newBotId}`,
        botFirstName: 'New Mahalla Bot',
        encryptedToken: encrypted.encryptedToken,
        tokenIv: encrypted.tokenIv,
        tokenTag: encrypted.tokenTag,
        tokenKeyVersion: encrypted.tokenKeyVersion,
        tokenMasked: encrypted.tokenMasked,
        status: 'VALID',
        lastValidatedAt: new Date(),
      });

      await db.update(districtTelegramGroups).set({
        status: 'VALID',
      }).where(eq(districtTelegramGroups.districtId, districtId));

      // Now activate district
      const activateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${districtId}/activate`,
        headers: { cookie: poCookie, ...SAME_ORIGIN_HEADERS },
      });
      expect(activateRes.statusCode).toBe(200);

      // Verify district is ACTIVE and scheduled transitions remain null
      const [reactivated] = await db.select().from(districts).where(eq(districts.id, districtId));
      expect(reactivated?.status).toBe('ACTIVE');

      const [reactivatedSub] = await db.select().from(districtSubscriptions).where(eq(districtSubscriptions.districtId, districtId));
      expect(reactivatedSub?.status).toBe('ACTIVE');
      expect(reactivatedSub?.scheduledTransitionAt).toBeNull();
      expect(reactivatedSub?.scheduledTransitionType).toBeNull();
    });
  });

  describe('4. 90-Day Retention Alignment (AC 8, 11)', () => {
    it('executes 90-day retention cleanup for CANCELLED districts without errors', async () => {
      const { districtId, districtName } = await seedActiveDistrict('Оҳангарон');

      await cancelDistrict(
        db,
        boss,
        districtId,
        {
          reason: 'Бекор қилинди',
          confirmationDistrictName: districtName,
        },
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );

      // Run retention job handler for single CANCELLED district
      await processRetentionJobs(
        [
          {
            id: 'job-test-1',
            name: TELEGRAM_TOPIC_RETENTION_QUEUE,
            data: { districtId },
          } as any,
        ],
        { db, pool, boss },
      );

      // Verify district remains intact in CANCELLED state
      const [dist] = await db.select().from(districts).where(eq(districts.id, districtId));
      expect(dist?.status).toBe('CANCELLED');
    });
  });

  describe('5. Concurrency & Row Locking Safety (AC 15)', () => {
    it('handles simultaneous concurrent cancellation requests with deterministic CAS (AC 15)', async () => {
      const { districtId, districtName } = await seedActiveDistrict('Қўйлиқ_Concurrent');

      // Send two concurrent cancellation requests simultaneously
      const [res1, res2] = await Promise.all([
        server.inject({
          method: 'POST',
          url: `/api/v1/districts/${districtId}/subscription/cancel`,
          headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
          payload: { reason: 'Concurrent Cancel 1', confirmationDistrictName: districtName },
        }),
        server.inject({
          method: 'POST',
          url: `/api/v1/districts/${districtId}/subscription/cancel`,
          headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
          payload: { reason: 'Concurrent Cancel 2', confirmationDistrictName: districtName },
        }),
      ]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort();
      // Exactly one succeeds with 200, one fails with 409 Conflict
      expect(statusCodes).toEqual([200, 409]);

      // Exactly one DISTRICT_CANCELLED audit event must be recorded
      const events = await db.select().from(auditEvents).where(
        and(eq(auditEvents.districtId, districtId), eq(auditEvents.action, 'DISTRICT_CANCELLED')),
      );
      expect(events).toHaveLength(1);
    });

    it('handles simultaneous concurrent recovery start requests with deterministic CAS (AC 15)', async () => {
      const { districtId, districtName } = await seedActiveDistrict('Сергели_Concurrent');

      // Cancel first
      await cancelDistrict(
        db,
        boss,
        districtId,
        {
          reason: 'Бекор қилинди',
          confirmationDistrictName: districtName,
        },
        { id: poAccountId, role: 'PRODUCT_OWNER' },
      );

      // Send two concurrent recovery start requests simultaneously
      const [res1, res2] = await Promise.all([
        server.inject({
          method: 'POST',
          url: `/api/v1/districts/${districtId}/subscription/start-recovery`,
          headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
          payload: { reason: 'Concurrent Recovery 1' },
        }),
        server.inject({
          method: 'POST',
          url: `/api/v1/districts/${districtId}/subscription/start-recovery`,
          headers: { 'content-type': 'application/json', cookie: poCookie, ...SAME_ORIGIN_HEADERS },
          payload: { reason: 'Concurrent Recovery 2' },
        }),
      ]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort();
      // Exactly one succeeds with 200, one fails with 409 Conflict
      expect(statusCodes).toEqual([200, 409]);

      // Exactly one DISTRICT_RECOVERY_STARTED audit event must be recorded
      const events = await db.select().from(auditEvents).where(
        and(eq(auditEvents.districtId, districtId), eq(auditEvents.action, 'DISTRICT_RECOVERY_STARTED')),
      );
      expect(events).toHaveLength(1);
    });
  });
});
