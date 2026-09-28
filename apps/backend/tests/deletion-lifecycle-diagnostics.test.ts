import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import type PgBoss from 'pg-boss';
import {
  AuditHistoryPage,
  PermanentDeletionProof,
  RetryOperationResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createBossClient, initBossQueues } from '../src/adapters/jobs/boss-client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import {
  districtDeletionRecords,
  auditEvents,
  operationalIssues,
} from '../src/adapters/db/schema/index.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import {
  isIssueRetryEligible,
  deriveRetryJobSpec,
} from '../src/modules/issues/retry-evaluator.js';
import { processDistrictDeletionJobs } from '../src/modules/subscriptions/jobs/district-deletion-job-handler.js';
import { eq } from 'drizzle-orm';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 6.7: District Deletion Lifecycle Diagnostics & Permanent Proof Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;
  let server: FastifyInstance;

  let poCookie = '';
  let poAccountId = '';
  let testDistrictId1: string;
  let testDistrictId2: string;
  let testDeletionRecordId1: string;
  let testDeletionRecordId2: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient({ schema: 'pgboss_deletion_diagnostics_test' });
    await boss.start();
    await initBossQueues(boss);

    server = await buildHttpServer({ db, pool, boss });
    await server.ready();

    // 1. Seed Product Owner
    const poUsername = `po_diag_test_${Date.now()}`;
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
    poCookie = Array.isArray(poSetCookie) ? poSetCookie[0] || '' : (poSetCookie as string) || '';

    // 2. Seed Test Deletion Records
    const ts = Date.now();
    testDistrictId1 = `dist_diag_del_1_${ts}`;
    testDistrictId2 = `dist_diag_del_2_${ts}`;
    testDeletionRecordId1 = `del_rec_${ts}_1`;
    testDeletionRecordId2 = `del_rec_${ts}_2`;

    const now = new Date();
    const futureDate = new Date(Date.now() + 30 * 24 * 3600 * 1000);

    await db.insert(districtDeletionRecords).values([
      {
        id: testDeletionRecordId1,
        districtId: testDistrictId1,
        districtName: 'Мирзо Улуғбек тумани (Ўчирилган)',
        cancelledAt: now,
        cancelledById: poAccountId,
        cancellationReason: 'Синов мақсадида бекор қилинди ва ўчирилди',
        scheduledLiveDeletionAt: now,
        actualLiveDeletionAt: now,
        liveDeletionStatus: 'COMPLETED',
        protectedBackupExpiryDeadline: futureDate,
        backupExpiryStatus: 'PENDING',
        backupExpiryVerifiedAt: null,
        restoreReconciliationStatus: 'RECONCILED',
        restoreReconciliationVerifiedAt: now,
        createdAt: now,
      },
      {
        id: testDeletionRecordId2,
        districtId: testDistrictId2,
        districtName: 'Чилонзор тумани (Тўлиқ ўчирилган)',
        cancelledAt: now,
        cancelledById: poAccountId,
        cancellationReason: 'Шартнома муддати тугаганлиги сабабли',
        scheduledLiveDeletionAt: now,
        actualLiveDeletionAt: now,
        liveDeletionStatus: 'COMPLETED',
        protectedBackupExpiryDeadline: now,
        backupExpiryStatus: 'VERIFIED',
        backupExpiryVerifiedAt: now,
        restoreReconciliationStatus: 'RECONCILED',
        restoreReconciliationVerifiedAt: now,
        createdAt: now,
      },
    ]);

    // Seed standard audit event for comparison
    await db.insert(auditEvents).values({
      id: `aud_diag_evt_${ts}`,
      districtId: null,
      actorId: poAccountId,
      actorRole: 'PRODUCT_OWNER',
      action: 'SYSTEM_SETTINGS_UPDATED',
      ipAddress: '127.0.0.1',
      userAgent: 'Diagnostics Test Agent',
      metadata: { reason: 'Ташхис тест ҳодисаси', outcome: 'SUCCESS' },
      createdAt: now,
    });
  });

  afterAll(async () => {
    await server.close();
    await boss.stop();
    await pool.end();
  });

  describe('1. Unified Audit History Keyset Pagination & Filtering (AC 1, AC 2)', () => {
    it('returns both standard audit events and permanent deletion proofs when recordType=ALL', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?recordType=ALL',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as AuditHistoryPage;
      expect(data.items.length).toBeGreaterThan(0);

      const hasAuditEvents = data.items.some((i) => i.recordType === 'AUDIT_EVENT');
      const hasDeletionProofs = data.items.some((i) => i.recordType === 'PERMANENT_DELETION_PROOF');
      expect(hasAuditEvents).toBe(true);
      expect(hasDeletionProofs).toBe(true);
    });

    it('returns only permanent deletion proofs when recordType=PERMANENT_DELETION_PROOF', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?recordType=PERMANENT_DELETION_PROOF',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as AuditHistoryPage;
      expect(data.items.length).toBeGreaterThan(0);
      expect(data.items.every((i) => i.recordType === 'PERMANENT_DELETION_PROOF')).toBe(true);
    });

    it('returns only standard audit events when recordType=AUDIT_EVENT', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?recordType=AUDIT_EVENT',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as AuditHistoryPage;
      expect(data.items.length).toBeGreaterThan(0);
      expect(data.items.every((i) => i.recordType === 'AUDIT_EVENT')).toBe(true);
    });

    it('supports free-text search across deletion record districtName and cancellationReason', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/audit/events?search=Мирзо%20Улуғбек',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload) as AuditHistoryPage;
      expect(data.items.some((i) => i.id === testDeletionRecordId1)).toBe(true);
    });
  });

  describe('2. Single Deletion Proof Lookup & Privacy Guarantees (AC 1, AC 6)', () => {
    it('retrieves permanent deletion proof by record ID with computed lifecycleComplete', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events/${testDeletionRecordId2}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const proof = JSON.parse(res.payload) as PermanentDeletionProof;
      expect(proof.recordType).toBe('PERMANENT_DELETION_PROOF');
      expect(proof.id).toBe(testDeletionRecordId2);
      expect(proof.districtId).toBe(testDistrictId2);
      expect(proof.liveDeletionStatus).toBe('COMPLETED');
      expect(proof.backupExpiryStatus).toBe('VERIFIED');
      expect(proof.lifecycleComplete).toBe(true);
    });

    it('falls back to finding deletion proof by district UUID if queried by district ID', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events/${testDistrictId1}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const proof = JSON.parse(res.payload) as PermanentDeletionProof;
      expect(proof.recordType).toBe('PERMANENT_DELETION_PROOF');
      expect(proof.districtId).toBe(testDistrictId1);
      expect(proof.lifecycleComplete).toBe(false); // backupExpiryStatus is PENDING
    });

    it('strictly guarantees no resident text, telegram messages, bot tokens, or private secrets in proof', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/audit/events/${testDeletionRecordId1}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const rawPayload = res.payload;

      // Verify no sensitive keys leaked
      expect(rawPayload).not.toContain('botToken');
      expect(rawPayload).not.toContain('password');
      expect(rawPayload).not.toContain('sessionToken');
      expect(rawPayload).not.toContain('verbatimText');
      expect(rawPayload).not.toContain('telegramMessageId');
    });
  });

  describe('3. Operational Issue Retry Evaluator & Specification (AC 3, AC 4)', () => {
    it('evaluates LIFECYCLE_DELETION and BACKUP_EXPIRY_DELAY as retry-eligible', () => {
      expect(isIssueRetryEligible('LIFECYCLE_DELETION', {})).toBe(true);
      expect(isIssueRetryEligible('BACKUP_EXPIRY_DELAY', {})).toBe(true);
      expect(isIssueRetryEligible('LIFECYCLE_DELETION', { permanentFailure: true })).toBe(false);
    });

    it('derives correct pg-boss job specs for LIFECYCLE_DELETION and BACKUP_EXPIRY_DELAY', () => {
      const liveSpec = deriveRetryJobSpec({
        id: 'iss_live_1',
        scope: 'GLOBAL',
        component: 'scheduled_deletion',
        issueCategory: 'LIFECYCLE_DELETION',
        districtId: 'dist_sample_1',
        metadata: { districtId: 'dist_sample_1' },
      });

      expect(liveSpec).not.toBeNull();
      expect(liveSpec?.queueName).toBe('district-live-deletion');
      expect(liveSpec?.singletonKey).toBe('live-del:dist_sample_1');
      expect(liveSpec?.operationType).toBe('DISTRICT_LIVE_DELETION');

      const backupSpec = deriveRetryJobSpec({
        id: 'iss_backup_1',
        scope: 'GLOBAL',
        component: 'backup_verification',
        issueCategory: 'BACKUP_EXPIRY_DELAY',
        districtId: null,
        metadata: { deletedDistrictId: 'dist_deleted_2' },
      });

      expect(backupSpec).not.toBeNull();
      expect(backupSpec?.queueName).toBe('district-backup-expiry');
      expect(backupSpec?.singletonKey).toBe('backup-exp:dist_deleted_2');
      expect(backupSpec?.operationType).toBe('DISTRICT_BACKUP_EXPIRY');
    });
  });

  describe('4. Operational Retry Route & Exemption from Active District Gate (AC 3, AC 8)', () => {
    it('successfully triggers retry for LIFECYCLE_DELETION without throwing DISTRICT_ACCESS_REVOKED', async () => {
      const ts = Date.now();
      const issueId = `iss_del_retry_${ts}`;

      // Insert an operational issue for a deleted district (no district row in districts table)
      await db.insert(operationalIssues).values({
        id: issueId,
        logicalKey: `del_fail:${testDistrictId1}`,
        scope: 'GLOBAL',
        districtId: null,
        component: 'scheduled_deletion',
        issueCategory: 'LIFECYCLE_DELETION',
        severity: 'Critical',
        status: 'ACTIVE',
        healthStatus: 'UNAVAILABLE',
        sanitizedTitle: 'Туманни жонли тизимдан ўчиришда хатолик юз берди',
        sanitizedDescription: 'Тест ўчириш хатолиги',
        recommendedAction: 'Қайта урининг',
        metadata: { districtId: testDistrictId1, deletedDistrictId: testDistrictId1 },
        startedAt: new Date(),
        latestCheckAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/retry`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(202);
      const json = JSON.parse(res.payload) as RetryOperationResponse;
      expect(json.accepted).toBe(true);
      expect(json.operationType).toBe('DISTRICT_LIVE_DELETION');

      // Verify pendingRetry flag was set in DB
      const [updatedIssue] = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.id, issueId))
        .limit(1);

      expect(updatedIssue).toBeDefined();
      expect((updatedIssue?.metadata as Record<string, unknown>)?.pendingRetry).toBe(true);

      // Verify second immediate retry throws DUPLICATE_RETRY_IN_PROGRESS
      const duplicateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/issues/${issueId}/retry`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(duplicateRes.statusCode).toBe(409);
    });

    it('clears pendingRetry flag upon job handler execution via finally block', async () => {
      const ts = Date.now();
      const issueId = `iss_del_cleanup_${ts}`;

      await db.insert(operationalIssues).values({
        id: issueId,
        logicalKey: `del_fail:dist_clean_${ts}`,
        scope: 'GLOBAL',
        districtId: null,
        component: 'scheduled_deletion',
        issueCategory: 'LIFECYCLE_DELETION',
        severity: 'Critical',
        status: 'ACTIVE',
        healthStatus: 'UNAVAILABLE',
        sanitizedTitle: 'Хатолик',
        sanitizedDescription: 'Тест хатолиги',
        recommendedAction: 'Қайта уриниш',
        metadata: { pendingRetry: true },
        startedAt: new Date(),
        latestCheckAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Execute job handler directly (it re-throws on error while executing finally block)
      await expect(
        processDistrictDeletionJobs(
          [
            {
              id: `job_${ts}`,
              name: 'district-live-deletion',
              data: { districtId: `dist_clean_${ts}`, issueId },
            } as any,
          ],
          { db, boss },
        ),
      ).rejects.toThrow();

      // Verify pendingRetry was cleared to false
      const [clearedIssue] = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.id, issueId))
        .limit(1);

      expect(clearedIssue).toBeDefined();
      expect((clearedIssue?.metadata as Record<string, unknown>)?.pendingRetry).toBe(false);
    });
  });
});
