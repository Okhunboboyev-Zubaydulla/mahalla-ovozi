import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import type PgBoss from 'pg-boss';
import {
  RetryOperationResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createBossClient, initBossQueues } from '../src/adapters/jobs/boss-client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import {
  accounts,
  districts,
  operationalIssues,
  auditEvents,
  telegramIntakeRecords,
} from '../src/adapters/db/schema/index.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { clearPendingRetryFlag } from '../src/modules/issues/retry-service.js';
import { eq, and, sql } from 'drizzle-orm';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 4.3: Operational Retry Database & HTTP Integration Tests (AC 1-10)', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;
  let server: FastifyInstance;

  let poCookie = '';
  let poAccountId = '';
  let hokimCookieDistrictA = '';
  let districtAId: string;
  let districtBId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient({ schema: 'pgboss_operational_retry' });
    await boss.start();
    await initBossQueues(boss);

    // Clean up test tables to guarantee test isolation
    await pool.query('DELETE FROM pgboss_operational_retry.job');
    await pool.query("DELETE FROM operational_issues WHERE id LIKE 'issue_%'");
    await pool.query("DELETE FROM audit_events WHERE action = 'OPERATIONAL_RETRY_TRIGGERED'");

    server = await buildHttpServer({ db, pool, boss });
    await server.ready();

    // 1. Seed Product Owner
    const poUsername = `po_retry_test_${Date.now()}`;
    const poPassword = 'SecurePOPassword2026!';
    const poAccount = await createOrResetProductOwner(db, {
      username: poUsername,
      password: poPassword,
    });
    poAccountId = poAccount.accountId;

    const poSignInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: {
        'content-type': 'application/json',
        ...SAME_ORIGIN_HEADERS,
      },
      payload: {
        username: poUsername,
        password: poPassword,
      },
    });

    expect(poSignInRes.statusCode).toBe(200);
    const poSetCookie = poSignInRes.headers['set-cookie'];
    poCookie = Array.isArray(poSetCookie) ? poSetCookie[0] || '' : (poSetCookie as string) || '';

    // 2. Seed Districts A and B
    const ts = Date.now();
    districtAId = `dist_retry_a_${ts}`;
    districtBId = `dist_retry_b_${ts}`;

    await db.insert(districts).values([
      { id: districtAId, name: `Чилонзор ${ts}`, status: 'ACTIVE' },
      { id: districtBId, name: `Юнусобод ${ts}`, status: 'ACTIVE' },
    ]);

    // 3. Seed Hokim A
    const hokimAPass = 'SecureHokimPassword2026!';
    const hokimAHash = await hashPassword(hokimAPass);
    const hokimAUser = `hokim_a_${ts}`;

    await db.insert(accounts).values({
      id: `acc_hokim_a_${ts}`,
      username: hokimAUser,
      passwordHash: hokimAHash,
      role: 'DISTRICT_HOKIM',
      districtId: districtAId,
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    const hokimASignIn = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
      payload: { username: hokimAUser, password: hokimAPass },
    });
    const hokimASetCookie = hokimASignIn.headers['set-cookie'];
    hokimCookieDistrictA = Array.isArray(hokimASetCookie) ? hokimASetCookie[0] || '' : (hokimASetCookie as string) || '';
  });

  afterAll(async () => {
    await server.close();
    await boss.stop({ graceful: true, timeout: 2000 }).catch(() => {});
    await pool.end();
  });

  beforeEach(async () => {
    // Clean up jobs and active issues between tests to ensure idempotency
    await pool.query('DELETE FROM pgboss_operational_retry.job');
  });

  describe('Authentication & Access Control Guards (AC 1, AC 6)', () => {
    it('rejects unauthenticated retry requests with 401 UNAUTHORIZED', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/issues/issue-dummy-123/retry',
        headers: { 'content-type': 'application/json', ...SAME_ORIGIN_HEADERS },
        payload: { reason: 'Test' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects Hokim trying to retry an issue from another district with 403/404', async () => {
      const issueId = `issue_dist_b_${Date.now()}`;
      await db.insert(operationalIssues).values({
        id: issueId,
        logicalKey: `DISTRICT:${districtBId}:telegram_intake:MESSAGE_INTAKE_DELAY:${Date.now()}`,
        scope: 'DISTRICT',
        districtId: districtBId,
        component: 'telegram_intake',
        issueCategory: 'MESSAGE_INTAKE_DELAY',
        severity: 'Warning',
        status: 'ACTIVE',
        healthStatus: 'Degraded',
        sanitizedTitle: 'Хабарлар қабул қилиш кечикмоқда',
        sanitizedDescription: 'Тавсиф',
        recommendedAction: 'Қайта уриниш',
        startedAt: new Date(),
        latestCheckAt: new Date(),
        metadata: {
          intakeId: 'intake-b-1',
          telegramChatId: '-100999',
          telegramMessageId: '123',
        },
      });

      // Hokim A attempts to retry Hokim B's issue
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/retry`,
        headers: {
          'content-type': 'application/json',
          cookie: hokimCookieDistrictA,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { reason: 'Hokim A trying B' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects Hokim trying to retry a GLOBAL issue with 403 FORBIDDEN', async () => {
      const issueId = `issue_global_${Date.now()}`;
      await db.insert(operationalIssues).values({
        id: issueId,
        logicalKey: `GLOBAL:global:processing_queue:QUEUE_BACKLOG_DELAY:${Date.now()}`,
        scope: 'GLOBAL',
        districtId: null,
        component: 'processing_queue',
        issueCategory: 'QUEUE_BACKLOG_DELAY',
        severity: 'Critical',
        status: 'ACTIVE',
        healthStatus: 'Degraded',
        sanitizedTitle: 'Навбат тирбандлиги',
        sanitizedDescription: 'Тавсиф',
        recommendedAction: 'Қайта уриниш',
        startedAt: new Date(),
        latestCheckAt: new Date(),
        metadata: {
          operationType: 'HEALTH_CHECK_SYNC',
        },
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/retry`,
        headers: {
          'content-type': 'application/json',
          cookie: hokimCookieDistrictA,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { reason: 'Hokim trying global' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('Eligibility Validation & Error Handling (AC 1, AC 6)', () => {
    it('returns 404 OPERATION_NOT_FOUND for non-existent issueId', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/issues/issue-non-existent-999/retry',
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { reason: 'Retry non-existent' },
      });

      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('OPERATION_NOT_FOUND');
    });

    it('returns 422 OPERATION_INELIGIBLE for non-retryable issue category (e.g. DATABASE_CONNECTION_ERROR)', async () => {
      const issueId = `issue_db_fail_${Date.now()}`;
      await db.insert(operationalIssues).values({
        id: issueId,
        logicalKey: `GLOBAL:global:database:DATABASE_CONNECTION_ERROR:${Date.now()}`,
        scope: 'GLOBAL',
        districtId: null,
        component: 'database',
        issueCategory: 'DATABASE_CONNECTION_ERROR',
        severity: 'Critical',
        status: 'ACTIVE',
        healthStatus: 'Unavailable',
        sanitizedTitle: 'Маълумотлар базаси уланмади',
        sanitizedDescription: 'Тавсиф',
        recommendedAction: 'Базани текширинг',
        startedAt: new Date(),
        latestCheckAt: new Date(),
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/retry`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(422);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('OPERATION_INELIGIBLE');
    });

    it('returns 409 OPERATION_ALREADY_COMPLETED for already resolved issue', async () => {
      const issueId = `issue_resolved_${Date.now()}`;
      await db.insert(operationalIssues).values({
        id: issueId,
        logicalKey: `DISTRICT:${districtAId}:telegram_intake:MESSAGE_INTAKE_DELAY_RESOLVED:${Date.now()}`,
        scope: 'DISTRICT',
        districtId: districtAId,
        component: 'telegram_intake',
        issueCategory: 'MESSAGE_INTAKE_DELAY',
        severity: 'Warning',
        status: 'RESOLVED',
        healthStatus: 'Healthy',
        sanitizedTitle: 'Ҳал қилинган муаммо',
        sanitizedDescription: 'Тавсиф',
        recommendedAction: 'Ҳеч нарса',
        startedAt: new Date(),
        latestCheckAt: new Date(),
        resolvedAt: new Date(),
        metadata: {
          intakeId: 'intake-resolved-1',
          telegramChatId: '-100111',
          telegramMessageId: '99',
        },
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/retry`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(409);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('OPERATION_ALREADY_COMPLETED');
    });
  });

  describe('Transactional Retry Intake & Audit Trail (AC 1, AC 2, AC 3, AC 4, AC 9)', () => {
    it('successfully triggers retry, enqueues pg-boss job, logs audit event, and sets pending flag', async () => {
      const intakeId = `intake_retry_${Date.now()}`;
      const issueId = `issue_retry_success_${Date.now()}`;

      // Insert mock intake record
      await db.insert(telegramIntakeRecords).values({
        id: intakeId,
        districtId: districtAId,
        mahallaName: 'Бўстон',
        telegramBotId: 'bot-123',
        telegramChatId: '-100123456',
        telegramMessageId: '789',
        originalTimestamp: new Date(),
        calendarDay: '2026-08-26',
        rawPayload: { message_id: 789, text: 'Test' },
      });

      // Insert retry-eligible issue
      await db.insert(operationalIssues).values({
        id: issueId,
        logicalKey: `DISTRICT:${districtAId}:telegram_intake:MESSAGE_INTAKE_DELAY:${intakeId}`,
        scope: 'DISTRICT',
        districtId: districtAId,
        component: 'telegram_intake',
        issueCategory: 'MESSAGE_INTAKE_DELAY',
        severity: 'Warning',
        status: 'ACTIVE',
        healthStatus: 'Degraded',
        sanitizedTitle: 'Telegram хабарларни қабул қилиш кечикмоқда',
        sanitizedDescription: 'Хабарлар навбатда туриб қолган.',
        recommendedAction: 'Қайта уриниш тугмасини босинг',
        startedAt: new Date(),
        latestCheckAt: new Date(),
        metadata: {
          intakeId,
          telegramChatId: '-100123456',
          telegramMessageId: '789',
          operationType: 'TELEGRAM_CONTENT_QUALIFICATION',
        },
      });

      const retryRes = await server.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/retry`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          reason: 'Оператор томонидан қайта ишга туширилди',
        },
      });

      expect(retryRes.statusCode).toBe(202);
      const retryBody: RetryOperationResponse = JSON.parse(retryRes.payload);

      expect(retryBody.accepted).toBe(true);
      expect(retryBody.operationType).toBe('TELEGRAM_CONTENT_QUALIFICATION');
      expect(retryBody.targetId).toBe(intakeId);
      expect(retryBody.retryTrackingId).toBeDefined();
      expect(retryBody.queuedAt).toBeDefined();

      // Verify issue record updated
      const updatedIssue = await db.query.operationalIssues.findFirst({
        where: eq(operationalIssues.id, issueId),
      });

      expect(updatedIssue).toBeDefined();
      const meta = updatedIssue?.metadata as Record<string, unknown>;
      expect(meta?.pendingRetry).toBe(true);
      expect(meta?.retryCount).toBe(1);
      expect(meta?.lastRetryAt).toBeDefined();

      // Verify audit event written
      const auditLog = await db.query.auditEvents.findFirst({
        where: and(
          eq(auditEvents.action, 'OPERATIONAL_RETRY_TRIGGERED'),
          sql`metadata->>'issueId' = ${issueId}`,
        ),
      });

      expect(auditLog).toBeDefined();
      expect(auditLog?.actorRole).toBe('PRODUCT_OWNER');
      expect(auditLog?.actorId).toBe(poAccountId);
      const auditMeta = auditLog?.metadata as Record<string, unknown>;
      expect(auditMeta?.issueId).toBe(issueId);
      expect(auditMeta?.reason).toBe('Оператор томонидан қайта ишга туширилди');
      expect(auditMeta?.retryTrackingId).toBe(retryBody.retryTrackingId);

      // Verify issue status remains ACTIVE (AC 5: retry trigger does not resolve issue prematurely)
      expect(updatedIssue?.status).toBe('ACTIVE');
    });

    it('returns 409 DUPLICATE_RETRY_IN_PROGRESS on immediate subsequent retry for same singleton key (AC 4, AC 8)', async () => {
      const intakeId = `intake_dup_${Date.now()}`;
      const issueId = `issue_dup_${Date.now()}`;

      await db.insert(operationalIssues).values({
        id: issueId,
        logicalKey: `DISTRICT:${districtAId}:telegram_intake:MESSAGE_INTAKE_DELAY:${intakeId}`,
        scope: 'DISTRICT',
        districtId: districtAId,
        component: 'telegram_intake',
        issueCategory: 'MESSAGE_INTAKE_DELAY',
        severity: 'Warning',
        status: 'ACTIVE',
        healthStatus: 'Degraded',
        sanitizedTitle: 'Хабарлар кечикмоқда',
        sanitizedDescription: 'Тавсиф',
        recommendedAction: 'Қайта уриниш',
        startedAt: new Date(),
        latestCheckAt: new Date(),
        metadata: {
          intakeId,
          telegramChatId: '-100888999',
          telegramMessageId: '321',
          operationType: 'TELEGRAM_CONTENT_QUALIFICATION',
        },
      });

      // First retry -> 202
      const firstRes = await server.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/retry`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(firstRes.statusCode).toBe(202);

      // Second retry -> 409 Conflict due to pg-boss active singleton deduplication
      const secondRes = await server.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/retry`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(secondRes.statusCode).toBe(409);
      const err = JSON.parse(secondRes.payload);
      expect(err.error.code).toBe('DUPLICATE_RETRY_IN_PROGRESS');
    });

    it('resets pendingRetry flag when clearPendingRetryFlag is called (AC 5)', async () => {
      const issueId = `issue_reset_flag_${Date.now()}`;

      await db.insert(operationalIssues).values({
        id: issueId,
        logicalKey: `DISTRICT:${districtAId}:topic_projection:TOPIC_PROCESSING_DELAY:${Date.now()}`,
        scope: 'DISTRICT',
        districtId: districtAId,
        component: 'topic_projection',
        issueCategory: 'TOPIC_PROCESSING_DELAY',
        severity: 'Warning',
        status: 'ACTIVE',
        healthStatus: 'Degraded',
        sanitizedTitle: 'Мавзулар кечикмоқда',
        sanitizedDescription: 'Тавсиф',
        recommendedAction: 'Қайта уриниш',
        startedAt: new Date(),
        latestCheckAt: new Date(),
        metadata: {
          pendingRetry: true,
          retryCount: 2,
          topicId: 'topic-test-reset',
        },
      });

      await clearPendingRetryFlag(db, issueId);

      const updated = await db.query.operationalIssues.findFirst({
        where: eq(operationalIssues.id, issueId),
      });

      const meta = updated?.metadata as Record<string, unknown>;
      expect(meta?.pendingRetry).toBe(false);
      expect(meta?.retryCount).toBe(2);
      expect(meta?.topicId).toBe('topic-test-reset');
    });
  });

  describe('Direct Background Job Retry Endpoint (AC 2, AC 4, AC 8)', () => {
    it('triggers TELEGRAM_TOPIC_RETENTION direct retry and deduplicates subsequent calls', async () => {
      const res1 = await server.inject({
        method: 'POST',
        url: '/api/v1/retry/jobs',
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          operationType: 'TELEGRAM_TOPIC_RETENTION',
          targetId: districtAId,
          reason: 'Manual retention trigger',
        },
      });

      expect(res1.statusCode).toBe(202);
      const body1: RetryOperationResponse = JSON.parse(res1.payload);
      expect(body1.accepted).toBe(true);
      expect(body1.operationType).toBe('TELEGRAM_TOPIC_RETENTION');
      expect(body1.targetId).toBe(districtAId);

      // Subsequent call while singleton active -> 409
      const res2 = await server.inject({
        method: 'POST',
        url: '/api/v1/retry/jobs',
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          operationType: 'TELEGRAM_TOPIC_RETENTION',
          targetId: districtAId,
        },
      });

      expect(res2.statusCode).toBe(409);
      const body2 = JSON.parse(res2.payload);
      expect(body2.error.code).toBe('DUPLICATE_RETRY_IN_PROGRESS');
    });

    it('handles targetId: global for retention jobs cleanly without FK violations', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/retry/jobs',
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          operationType: 'TELEGRAM_TOPIC_RETENTION',
          targetId: 'global',
        },
      });

      expect(res.statusCode).toBe(202);
      const body: RetryOperationResponse = JSON.parse(res.payload);
      expect(body.accepted).toBe(true);
      expect(body.targetId).toBe('global');
    });

    it('returns 404 for direct job retry with non-existent district ID', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/retry/jobs',
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: {
          operationType: 'TELEGRAM_TOPIC_RETENTION',
          targetId: 'non_existent_district_123',
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('rejects retry with 422 DISTRICT_ACCESS_REVOKED when district is suspended', async () => {
      const suspendedDistId = `dist_suspended_${Date.now()}`;
      await db.insert(districts).values({
        id: suspendedDistId,
        name: `Тўхтатилган туман ${suspendedDistId}`,
        status: 'SUSPENDED',
        accessEligible: false,
      });

      const issueId = `issue_suspended_${Date.now()}`;
      await db.insert(operationalIssues).values({
        id: issueId,
        logicalKey: `DISTRICT:${suspendedDistId}:telegram_intake:MESSAGE_INTAKE_DELAY:${Date.now()}`,
        scope: 'DISTRICT',
        districtId: suspendedDistId,
        component: 'telegram_intake',
        issueCategory: 'MESSAGE_INTAKE_DELAY',
        severity: 'Warning',
        status: 'ACTIVE',
        healthStatus: 'Degraded',
        sanitizedTitle: 'Хабарлар кечикмоқда',
        sanitizedDescription: 'Тавсиф',
        recommendedAction: 'Қайта уриниш',
        startedAt: new Date(),
        latestCheckAt: new Date(),
        metadata: {
          intakeId: 'intake-susp-1',
          telegramChatId: '-100333',
          telegramMessageId: '44',
          operationType: 'TELEGRAM_CONTENT_QUALIFICATION',
        },
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/retry`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(422);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('DISTRICT_ACCESS_REVOKED');
    });
  });
});
