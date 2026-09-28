import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import {
  VerifyBackupExpiryResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createBossClient } from '../src/adapters/jobs/boss-client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import {
  districtDeletionRecords,
  operationalIssues,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import {
  verifyDistrictBackupExpiry,
  processOverdueBackupExpiries,
  getDistrictDeletionRecord,
  DistrictNotEligibleForDeletionError,
} from '../src/modules/subscriptions/district-deletion-service.js';
import { MockBackupRetentionVerifier } from '../src/adapters/backup/mock-backup-verifier.js';
import { SystemBackupRetentionVerifier } from '../src/adapters/backup/system-backup-verifier.js';
import { runMigrations } from '../src/adapters/db/migrate.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 6.5: Verify Protected-Backup Expiry Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;
  let boss: any;
  let mockVerifier: MockBackupRetentionVerifier;

  let poCookie = '';
  let poAccountId = '';

  beforeAll(async () => {
    await runMigrations();
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient();
    await boss.start();

    mockVerifier = new MockBackupRetentionVerifier();

    server = await buildHttpServer({
      db,
      pool,
      boss,
      backupVerifier: mockVerifier,
    } as any);
    await server.ready();

    // Provision Product Owner account
    const poUsername = `po_bexp_test_${Date.now()}_${crypto.randomUUID().slice(0, 4)}`;
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

  // Helper to insert a completed live-deletion tombstone directly
  async function seedLiveDeletedTombstone(params?: {
    districtId?: string;
    districtName?: string;
    actualLiveDeletionAt?: Date;
    protectedBackupExpiryDeadline?: Date;
    liveDeletionStatus?: 'COMPLETED' | 'FAILED';
    backupExpiryStatus?: 'PENDING' | 'VERIFIED' | 'FAILED';
  }) {
    const districtId = params?.districtId || `dist_bexp_${crypto.randomUUID()}`;
    const districtName = params?.districtName || `Туман ${districtId.slice(0, 8)}`;
    const actualLiveDeletionAt = params?.actualLiveDeletionAt || new Date(Date.now() - 35 * 24 * 60 * 60 * 1000); // 35 days ago by default
    const protectedBackupExpiryDeadline =
      params?.protectedBackupExpiryDeadline ||
      new Date(actualLiveDeletionAt.getTime() + 30 * 24 * 60 * 60 * 1000); // 5 days ago (overdue)
    const liveDeletionStatus = params?.liveDeletionStatus || 'COMPLETED';
    const backupExpiryStatus = params?.backupExpiryStatus || 'PENDING';

    const id = `del_rec_${crypto.randomUUID()}`;

    await db.insert(districtDeletionRecords).values({
      id,
      districtId,
      districtName,
      scheduledLiveDeletionAt: actualLiveDeletionAt,
      actualLiveDeletionAt,
      liveDeletionStatus,
      protectedBackupExpiryDeadline,
      backupExpiryStatus,
      createdAt: actualLiveDeletionAt,
      updatedAt: actualLiveDeletionAt,
    });

    return {
      id,
      districtId,
      districtName,
      actualLiveDeletionAt,
      protectedBackupExpiryDeadline,
    };
  }

  // ─── TEST 1: SUCCESSFUL BACKUP EXPIRY VERIFICATION ──────────────────────────
  it('Test 1: marks backupExpiryStatus = VERIFIED and sets backupExpiryVerifiedAt when repository confirms pre-deletion snapshots aged out', async () => {
    const { districtId, actualLiveDeletionAt } = await seedLiveDeletedTombstone();

    // Mock verifier: repository has only newer backups (created after live deletion)
    const newestBackupDate = new Date(actualLiveDeletionAt.getTime() + 2 * 24 * 60 * 60 * 1000);
    mockVerifier.setDistrictConfig(districtId, {
      isExpired: true,
      oldestActiveBackupTimestamp: newestBackupDate,
      verificationMethod: 'MOCK_PGBACKREST_INSPECTION',
    });

    const result = await verifyDistrictBackupExpiry(db, mockVerifier, districtId, {
      actor: { id: poAccountId, role: 'PRODUCT_OWNER' },
    });

    expect(result.isExpired).toBe(true);
    expect(result.deletionRecord.backupExpiryStatus).toBe('VERIFIED');
    expect(result.deletionRecord.backupExpiryVerifiedAt).toBeDefined();

    // Verify database row
    const [row] = await db
      .select()
      .from(districtDeletionRecords)
      .where(eq(districtDeletionRecords.districtId, districtId));

    expect(row!.backupExpiryStatus).toBe('VERIFIED');
    expect(row!.backupExpiryVerifiedAt).toBeDefined();
  });

  // ─── TEST 2: NON-INFERENCE TEST (CRITICAL AD-11 INVARIANT) ─────────────────
  it('Test 2: Non-Inference Invariant: reaching 30-day deadline alone NEVER marks status VERIFIED if repository contains pre-deletion backups', async () => {
    const { districtId, actualLiveDeletionAt } = await seedLiveDeletedTombstone();

    // Current time is past the 30-day deadline, but mock repository reports pre-deletion backup still exists
    const preDeletionBackupDate = new Date(actualLiveDeletionAt.getTime() - 10 * 24 * 60 * 60 * 1000);
    mockVerifier.setDistrictConfig(districtId, {
      isExpired: false,
      oldestActiveBackupTimestamp: preDeletionBackupDate,
      verificationMethod: 'MOCK_PGBACKREST_INSPECTION',
    });

    const result = await verifyDistrictBackupExpiry(db, mockVerifier, districtId, {
      actor: { id: null, role: 'SYSTEM' },
    });

    // Verification must authoritatively FAIL despite elapsed time
    expect(result.isExpired).toBe(false);
    expect(result.deletionRecord.backupExpiryStatus).toBe('FAILED');

    // DB row must not be VERIFIED
    const [row] = await db
      .select()
      .from(districtDeletionRecords)
      .where(eq(districtDeletionRecords.districtId, districtId));

    expect(row!.backupExpiryStatus).toBe('FAILED');
    expect(row!.backupExpiryVerifiedAt).toBeNull();
  });

  // ─── TEST 3: CRITICAL OPERATIONAL ISSUE ON OVERDUE/FAILED BACKUP EXPIRY ─────
  it('Test 3: creates Critical operational issue with scope = GLOBAL and districtId = null on overdue backup expiry failure', async () => {
    const { districtId, districtName, actualLiveDeletionAt } = await seedLiveDeletedTombstone();

    const preDeletionBackupDate = new Date(actualLiveDeletionAt.getTime() - 5 * 24 * 60 * 60 * 1000);
    mockVerifier.setDistrictConfig(districtId, {
      isExpired: false,
      oldestActiveBackupTimestamp: preDeletionBackupDate,
      verificationMethod: 'MOCK_PGBACKREST_INSPECTION',
    });

    await verifyDistrictBackupExpiry(db, mockVerifier, districtId);

    // Verify operational_issues record
    const logicalKey = `del_backup_fail:${districtId}`;
    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(and(eq(operationalIssues.logicalKey, logicalKey), eq(operationalIssues.status, 'ACTIVE')));

    expect(issue).toBeDefined();
    expect(issue!.scope).toBe('GLOBAL');
    expect(issue!.districtId).toBeNull(); // Foreign-key safety invariant (AD-11, FR32)
    expect(issue!.severity).toBe('Critical');
    expect(issue!.issueCategory).toBe('BACKUP_EXPIRY_DELAY');
    expect(issue!.component).toBe('scheduled_deletion');
    expect(issue!.healthStatus).toBe('DEGRADED');

    // Check privacy-safe metadata
    const metadata = issue!.metadata as Record<string, unknown>;
    expect(metadata.deletedDistrictId).toBe(districtId);
    expect(metadata.deletedDistrictName).toBe(districtName);
    expect(metadata.actualLiveDeletionAt).toBeDefined();
  });

  // ─── TEST 4: AUTOMATIC RESOLUTION OF OPERATIONAL ISSUE ON SUCCESS ───────────
  it('Test 4: automatically resolves active operational issue when backup expiry is subsequently satisfied', async () => {
    const { districtId, actualLiveDeletionAt } = await seedLiveDeletedTombstone();

    // 1. First run: Fails
    mockVerifier.setDistrictConfig(districtId, {
      isExpired: false,
      oldestActiveBackupTimestamp: new Date(actualLiveDeletionAt.getTime() - 1000),
    });
    await verifyDistrictBackupExpiry(db, mockVerifier, districtId);

    const logicalKey = `del_backup_fail:${districtId}`;
    const [activeIssue] = await db
      .select()
      .from(operationalIssues)
      .where(and(eq(operationalIssues.logicalKey, logicalKey), eq(operationalIssues.status, 'ACTIVE')));
    expect(activeIssue).toBeDefined();

    // 2. Second run: Subsequent success
    mockVerifier.setDistrictConfig(districtId, {
      isExpired: true,
      oldestActiveBackupTimestamp: new Date(actualLiveDeletionAt.getTime() + 1000),
    });
    const successResult = await verifyDistrictBackupExpiry(db, mockVerifier, districtId);
    expect(successResult.isExpired).toBe(true);

    // 3. Operational issue must be RESOLVED
    const [resolvedIssue] = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.logicalKey, logicalKey));

    expect(resolvedIssue).toBeDefined();
    expect(resolvedIssue!.status).toBe('RESOLVED');
    expect(resolvedIssue!.resolvedAt).toBeDefined();
  });

  // ─── TEST 5: IDEMPOTENCY & RETRY SAFETY ─────────────────────────────────────
  it('Test 5: returns existing record idempotently without duplicate side effects if already VERIFIED', async () => {
    const { districtId, actualLiveDeletionAt } = await seedLiveDeletedTombstone();

    mockVerifier.setDistrictConfig(districtId, {
      isExpired: true,
      oldestActiveBackupTimestamp: new Date(actualLiveDeletionAt.getTime() + 1000),
    });

    const firstRun = await verifyDistrictBackupExpiry(db, mockVerifier, districtId);
    expect(firstRun.deletionRecord.backupExpiryStatus).toBe('VERIFIED');
    const firstVerifiedAt = firstRun.deletionRecord.backupExpiryVerifiedAt;

    // Reset mock call log to count new calls
    mockVerifier.clearCallLog();

    // Second run: must be idempotent no-op
    const secondRun = await verifyDistrictBackupExpiry(db, mockVerifier, districtId);
    expect(secondRun.deletionRecord.backupExpiryStatus).toBe('VERIFIED');
    expect(secondRun.deletionRecord.backupExpiryVerifiedAt).toBe(firstVerifiedAt);

    // Verifier should not have been called again
    expect(mockVerifier.getCallLog().length).toBe(0);
  });

  // ─── TEST 6: STALE / INCOMPLETE LIVE DELETION GUARD ─────────────────────────
  it('Test 6: throws DistrictNotEligibleForDeletionError if live deletion was not COMPLETED', async () => {
    const { districtId } = await seedLiveDeletedTombstone({
      liveDeletionStatus: 'FAILED',
    });

    await expect(
      verifyDistrictBackupExpiry(db, mockVerifier, districtId),
    ).rejects.toThrow(DistrictNotEligibleForDeletionError);
  });

  // ─── TEST 7: RECURRING CRON SWEEPER ─────────────────────────────────────────
  it('Test 7: processOverdueBackupExpiries scans and verifies pending/failed deletion records', async () => {
    const tombstone1 = await seedLiveDeletedTombstone({ backupExpiryStatus: 'PENDING' });
    const tombstone2 = await seedLiveDeletedTombstone({ backupExpiryStatus: 'FAILED' });

    mockVerifier.setDistrictConfig(tombstone1.districtId, { isExpired: true });
    mockVerifier.setDistrictConfig(tombstone2.districtId, { isExpired: true });

    const sweepResult = await processOverdueBackupExpiries(db, mockVerifier);
    expect(sweepResult.processedCount).toBeGreaterThanOrEqual(2);
    expect(sweepResult.errors.length).toBe(0);

    const record1 = await getDistrictDeletionRecord(db, tombstone1.districtId);
    const record2 = await getDistrictDeletionRecord(db, tombstone2.districtId);

    expect(record1?.backupExpiryStatus).toBe('VERIFIED');
    expect(record2?.backupExpiryStatus).toBe('VERIFIED');
  });

  // ─── TEST 8: GLOBAL AUDIT LOGGING ───────────────────────────────────────────
  it('Test 8: records global audit log with action DISTRICT_BACKUP_EXPIRY_VERIFIED and DISTRICT_BACKUP_EXPIRY_FAILED', async () => {
    // 1. Test success audit
    const successSeed = await seedLiveDeletedTombstone();
    mockVerifier.setDistrictConfig(successSeed.districtId, { isExpired: true });
    await verifyDistrictBackupExpiry(db, mockVerifier, successSeed.districtId);

    const successAudits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'DISTRICT_BACKUP_EXPIRY_VERIFIED'),
          eq(auditEvents.actorRole, 'SYSTEM'),
        ),
      );

    const successAudit = successAudits.find(
      (a) => (a.metadata as Record<string, unknown>)?.deletedDistrictId === successSeed.districtId,
    );

    expect(successAudit).toBeDefined();
    expect(successAudit?.districtId).toBeNull();
    const successMeta = successAudit?.metadata as Record<string, unknown>;
    expect(successMeta.deletedDistrictId).toBe(successSeed.districtId);
    expect(successMeta.outcome).toBe('SUCCESS');

    // 2. Test failure audit
    const failSeed = await seedLiveDeletedTombstone();
    mockVerifier.setDistrictConfig(failSeed.districtId, {
      isExpired: false,
      oldestActiveBackupTimestamp: new Date(failSeed.actualLiveDeletionAt.getTime() - 1000),
    });
    await verifyDistrictBackupExpiry(db, mockVerifier, failSeed.districtId);

    const failAudits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'DISTRICT_BACKUP_EXPIRY_FAILED'),
          eq(auditEvents.actorRole, 'SYSTEM'),
        ),
      );

    const failAudit = failAudits.find(
      (a) => (a.metadata as Record<string, unknown>)?.deletedDistrictId === failSeed.districtId,
    );

    expect(failAudit).toBeDefined();
    expect(failAudit?.districtId).toBeNull();
    const failMeta = failAudit?.metadata as Record<string, unknown>;
    expect(failMeta.deletedDistrictId).toBe(failSeed.districtId);
    expect(failMeta.outcome).toBe('FAILURE');
  });

  // ─── TEST 9: FASTIFY REST API ENDPOINT ──────────────────────────────────────
  it('Test 9: POST /api/v1/districts/:districtId/deletion-record/verify-backup-expiry validates PO access and returns VerifyBackupExpiryResponse', async () => {
    const { districtId } = await seedLiveDeletedTombstone();
    mockVerifier.setDistrictConfig(districtId, { isExpired: true });

    // 1. Unauthorized request without cookie -> 401
    const unauthRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${districtId}/deletion-record/verify-backup-expiry`,
      headers: { ...SAME_ORIGIN_HEADERS },
    });
    expect(unauthRes.statusCode).toBe(401);

    // 2. Authorized request with PO session cookie -> 200
    const authRes = await server.inject({
      method: 'POST',
      url: `/api/v1/districts/${districtId}/deletion-record/verify-backup-expiry`,
      headers: {
        cookie: poCookie,
        ...SAME_ORIGIN_HEADERS,
      },
    });

    expect(authRes.statusCode).toBe(200);
    const body: VerifyBackupExpiryResponse = authRes.json();
    expect(body.isExpired).toBe(true);
    expect(body.deletionRecord.backupExpiryStatus).toBe('VERIFIED');
    expect(body.message).toContain('муваффақиятли тасдиқланди');
  });

  // ─── TEST 10: SYSTEM BACKUP RETENTION VERIFIER ADAPTER UNIT CHECK ───────────
  it('Test 10: SystemBackupRetentionVerifier parses pgBackRest JSON metadata correctly', async () => {
    const actualLiveDeletionAt = new Date('2026-08-01T12:00:00.000Z');
    const protectedBackupExpiryDeadline = new Date('2026-08-31T12:00:00.000Z');

    // Case A: Backups exist that were created AFTER live deletion
    const verifierA = new SystemBackupRetentionVerifier({
      backupInfoResolver: async () => [
        {
          name: 'mahalla_ovozi',
          status: { code: 0, message: 'ok' },
          backup: [
            {
              label: '20260805-120000F',
              type: 'full',
              timestamp: { start: Math.floor(new Date('2026-08-05T12:00:00.000Z').getTime() / 1000), stop: 0 },
            },
          ],
        },
      ],
    });

    const resA = await verifierA.verifyDistrictBackupExpiry({
      districtId: 'test_a',
      actualLiveDeletionAt,
      protectedBackupExpiryDeadline,
    });
    expect(resA.isExpired).toBe(true);
    expect(resA.oldestActiveBackupTimestamp).toEqual(new Date('2026-08-05T12:00:00.000Z'));

    // Case B: Backups exist that were created BEFORE live deletion
    const verifierB = new SystemBackupRetentionVerifier({
      backupInfoResolver: async () => [
        {
          name: 'mahalla_ovozi',
          status: { code: 0, message: 'ok' },
          backup: [
            {
              label: '20260720-120000F',
              type: 'full',
              timestamp: { start: Math.floor(new Date('2026-07-20T12:00:00.000Z').getTime() / 1000), stop: 0 },
            },
          ],
        },
      ],
    });

    const resB = await verifierB.verifyDistrictBackupExpiry({
      districtId: 'test_b',
      actualLiveDeletionAt,
      protectedBackupExpiryDeadline,
    });
    expect(resB.isExpired).toBe(false);
    expect(resB.oldestActiveBackupTimestamp).toEqual(new Date('2026-07-20T12:00:00.000Z'));
  });
});
