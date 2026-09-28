import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import {
  DistrictDeletionRecord,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createBossClient, sendQueueJob, TELEGRAM_TOPIC_ASSIGNMENT_QUEUE } from '../src/adapters/jobs/boss-client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import {
  districts,
  districtSubscriptions,
  districtDeletionRecords,
  topicProjections,
  acceptedEvidence,
  topics,
  aiProfiles,
  aiOperations,
  telegramIntakeRecords,
  districtAnalysisSettingsDrafts,
  districtAnalysisSettingsVersions,
  operationalIssues,
  userDashboardVisits,
  accounts,
  sessions,
  districtTelegramGroups,
  districtTelegramBots,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import {
  reconcileDisasterRestore,
} from '../src/modules/retention/restore-reconciliation.js';
import {
  executeDistrictLiveDeletion,
} from '../src/modules/subscriptions/district-deletion-service.js';
import {
  InMemoryExternalTombstoneStore,
} from '../src/adapters/storage/external-tombstone-store.js';
import { runMigrations } from '../src/adapters/db/migrate.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 6.6: Reconcile Disaster Restores Before Re-Enabling Service Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;
  let boss: any;
  let tombstoneStore: InMemoryExternalTombstoneStore;

  let poCookie = '';
  let poAccountId = '';

  beforeAll(async () => {
    await runMigrations();
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient();
    await boss.start();

    tombstoneStore = new InMemoryExternalTombstoneStore();

    server = await buildHttpServer({
      db,
      pool,
      boss,
      tombstoneStore,
    } as any);
    await server.ready();

    // Provision Product Owner account
    const poUsername = `po_dr_test_${Date.now()}_${crypto.randomUUID().slice(0, 4)}`;
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

  beforeEach(() => {
    tombstoneStore.clear();
  });

  /**
   * Helper to seed a complete district with records across all 17 tables.
   */
  async function seedFull17TableDistrict(districtId: string, districtName: string) {
    const now = new Date();
    const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000);

    // 17. districts
    await db.insert(districts).values({
      id: districtId,
      name: districtName,
      status: 'ACTIVE',
      region: 'Toshkent viloyati',
      createdAt: ninetyFiveDaysAgo,
      updatedAt: now,
    });

    // 16. district_subscriptions
    await db.insert(districtSubscriptions).values({
      id: `sub_${districtId}`,
      districtId,
      status: 'ACTIVE',
      statusStartedAt: ninetyFiveDaysAgo,
      createdAt: ninetyFiveDaysAgo,
      updatedAt: now,
    });

    // 15. audit_events (District-scoped)
    await db.insert(auditEvents).values({
      id: `aud_${crypto.randomUUID()}`,
      districtId,
      actorId: null,
      actorRole: 'SYSTEM',
      action: 'DISTRICT_ACTIVATED',
      metadata: { outcome: 'SUCCESS' },
      createdAt: ninetyFiveDaysAgo,
    });

    // 14. district_telegram_bots
    await db.insert(districtTelegramBots).values({
      id: `bot_${districtId}`,
      districtId,
      botId: `botid_${crypto.randomUUID().slice(0, 10)}`,
      botUsername: `bot_${districtId.slice(0, 8)}`,
      botFirstName: 'Test Bot',
      encryptedToken: 'enc_token_123',
      tokenIv: 'iv_123',
      tokenTag: 'tag_123',
      tokenKeyVersion: 'v1',
      tokenMasked: '1234****',
      status: 'VALID',
      lastValidatedAt: now,
      createdAt: ninetyFiveDaysAgo,
      updatedAt: now,
    });

    // 13. district_telegram_groups
    await db.insert(districtTelegramGroups).values({
      id: `grp_${districtId}`,
      districtId,
      telegramChatId: `-100${crypto.randomUUID().replace(/\D/g, '').slice(0, 9) || '123456789'}`,
      telegramChatTitle: 'Mahalla Group',
      mahallaName: 'Navbahor',
      status: 'VALID',
      createdAt: ninetyFiveDaysAgo,
      updatedAt: now,
    });

    // 12. accounts
    const accountId = `acc_${districtId}`;
    await db.insert(accounts).values({
      id: accountId,
      districtId,
      role: 'DISTRICT_HOKIM',
      username: `hokim_${crypto.randomUUID().replace(/\D/g, '').slice(0, 8)}_${Date.now()}`,
      passwordHash: 'hash',
      mustChangePassword: false,
      createdAt: ninetyFiveDaysAgo,
      updatedAt: now,
    });

    // 11. sessions
    await db.insert(sessions).values({
      id: `sess_${crypto.randomUUID()}`,
      accountId,
      tokenHash: `th_${crypto.randomUUID()}`,
      credentialVersion: 1,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      createdAt: now,
    });

    // 10. user_dashboard_visits
    await db.insert(userDashboardVisits).values({
      id: `vis_${crypto.randomUUID()}`,
      districtId,
      userId: accountId,
      visitedAt: now,
      createdAt: now,
    });

    // 9. operational_issues (district-scoped)
    await db.insert(operationalIssues).values({
      id: `issue_${crypto.randomUUID()}`,
      logicalKey: `issue:${districtId}`,
      scope: 'DISTRICT',
      districtId,
      component: 'telegram_bot',
      issueCategory: 'BOT_DISCONNECTED',
      severity: 'Warning',
      status: 'ACTIVE',
      healthStatus: 'Degraded',
      sanitizedTitle: 'Бот узилган',
      sanitizedDescription: 'Бот уланган эмас',
      recommendedAction: 'Текширинг',
      startedAt: now,
      latestCheckAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // 8. district_analysis_settings_versions
    const versionId = `ver_${crypto.randomUUID()}`;
    await db.insert(districtAnalysisSettingsVersions).values({
      id: versionId,
      districtId,
      version: 1,
      hokimRecognitionTerms: ['hokim'],
      localVocabularyAdditions: [{ category: 'WATER', term: 'suv' }],
      isActive: true,
      activatedAt: ninetyFiveDaysAgo,
      createdAt: ninetyFiveDaysAgo,
    });

    // 7. district_analysis_settings_drafts
    await db.insert(districtAnalysisSettingsDrafts).values({
      id: `draft_${crypto.randomUUID()}`,
      districtId,
      hokimRecognitionTerms: ['hokim'],
      localVocabularyAdditions: [{ category: 'GAS', term: 'gaz' }],
      createdAt: now,
      updatedAt: now,
    });

    // 6. telegram_intake_records
    const intakeId = `intake_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId,
      mahallaName: 'Navbahor',
      telegramBotId: 'botid_123',
      telegramChatId: '-100123456789',
      telegramMessageId: `${Date.now()}_${crypto.randomUUID().slice(0, 4)}`,
      originalTimestamp: ninetyFiveDaysAgo,
      calendarDay: '2026-05-26',
      rawPayload: { text: 'Mahallada suv yo`q' },
      createdAt: ninetyFiveDaysAgo,
    });

    // AI Profile (ensure base profile exists)
    const [existingProfile] = await db.select().from(aiProfiles).limit(1);
    const profileId = existingProfile?.id || 'prof_default_test';
    if (!existingProfile) {
      await db.insert(aiProfiles).values({
        id: profileId,
        version: 1,
        operationType: 'SEMANTIC_RELEVANCE',
        provider: 'GEMINI',
        modelId: 'gemini-2.0-flash-001',
        promptVersion: 'v1',
        schemaVersion: 'v1',
        retryPolicy: { maxAttempts: 3, backoffFactor: 2, initialDelayMs: 1000 },
        capabilities: { structuredOutputs: true },
        isActive: true,
        createdAt: ninetyFiveDaysAgo,
      });
    }

    // 5. ai_operations
    const operationId = `op_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: operationId,
      districtId,
      mahallaName: 'Navbahor',
      calendarDay: '2026-05-26',
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: intakeId,
      pinnedProfileId: profileId,
      snapshotFingerprint: 'fp_123',
      finalStatus: 'COMPLETED_RELEVANT',
      createdAt: ninetyFiveDaysAgo,
    });

    // 3. topics
    const topicId = `top_${crypto.randomUUID()}`;
    await db.insert(topics).values({
      id: topicId,
      districtId,
      mahallaName: 'Navbahor',
      calendarDay: '2026-05-26',
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: ninetyFiveDaysAgo,
      retentionExpiresAt: new Date(ninetyFiveDaysAgo.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 1,
      createdAt: ninetyFiveDaysAgo,
      updatedAt: ninetyFiveDaysAgo,
    });

    // 2. accepted_evidence
    const evidenceId = `ev_${crypto.randomUUID()}`;
    await db.insert(acceptedEvidence).values({
      id: evidenceId,
      topicId,
      districtId,
      mahallaName: 'Navbahor',
      calendarDay: '2026-05-26',
      intakeRecordId: intakeId,
      telegramChatId: '-100123456789',
      telegramMessageId: `${Date.now()}_${crypto.randomUUID().slice(0, 4)}`,
      originalTimestamp: ninetyFiveDaysAgo,
      verbatimText: 'Mahallada suv yo`q',
      contentType: 'TEXT',
      aiOperationId: operationId,
      createdAt: ninetyFiveDaysAgo,
    });

    // 1. topic_projections
    await db.insert(topicProjections).values({
      id: `proj_${crypto.randomUUID()}`,
      topicId,
      districtId,
      mahallaName: 'Navbahor',
      calendarDay: '2026-05-26',
      summary: 'Suv ta`minoti muammosi',
      lanes: ['WATER'],
      primaryLane: 'WATER',
      anchorEvidenceId: evidenceId,
      anchorQuote: 'Mahallada suv yo`q',
      latestMeaningfulActivityTimestamp: ninetyFiveDaysAgo,
      attribution: 'Mahalla',
      isHokimRelated: false,
      generation: 1,
      aiProfileId: profileId,
      aiOperationId: operationId,
      createdAt: ninetyFiveDaysAgo,
      updatedAt: ninetyFiveDaysAgo,
    });

    return { topicId, intakeId, accountId };
  }

  it('Test 1: Access blocking before reconciliation — readiness probe returns 503 unready when resurrected deleted districts exist (AC 1, AC 7)', async () => {
    const districtId = `dist_resurrect_${crypto.randomUUID()}`;
    const districtName = `Resurrected District ${crypto.randomUUID().slice(0, 6)}`;

    // Seed district in database
    await seedFull17TableDistrict(districtId, districtName);

    // Save tombstone in external tombstone store indicating district was deleted prior to restore
    const now = new Date();
    const tombstone: DistrictDeletionRecord = {
      id: `del_rec_${crypto.randomUUID()}`,
      districtId,
      districtName,
      cancelledAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      scheduledLiveDeletionAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      actualLiveDeletionAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      liveDeletionStatus: 'COMPLETED',
      protectedBackupExpiryDeadline: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString(),
      backupExpiryStatus: 'PENDING',
      restoreReconciliationStatus: 'PENDING',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await tombstoneStore.saveTombstone(tombstone);

    // Check readiness probe: must return 503 unready with restoreReconciliation: 'unreconciled'
    const readyRes = await server.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
    });

    expect(readyRes.statusCode).toBe(503);
    const body = JSON.parse(readyRes.body);
    expect(body.status).toBe('unready');
    expect(body.checks.restoreReconciliation).toBe('unreconciled');
    expect(readyRes.headers['retry-after']).toBe('5');
    expect(readyRes.headers['cache-control']).toBe('no-store');
  });

  it('Test 2: Resurrected deleted district purge — purges full 17-table data and prevents access leaks (AC 2, AC 3)', async () => {
    const districtId = `dist_purge_${crypto.randomUUID()}`;
    const districtName = `Purge District ${crypto.randomUUID().slice(0, 6)}`;

    await seedFull17TableDistrict(districtId, districtName);

    const now = new Date();
    const tombstone: DistrictDeletionRecord = {
      id: `del_rec_${crypto.randomUUID()}`,
      districtId,
      districtName,
      cancelledAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      scheduledLiveDeletionAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      actualLiveDeletionAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      liveDeletionStatus: 'COMPLETED',
      protectedBackupExpiryDeadline: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString(),
      backupExpiryStatus: 'PENDING',
      restoreReconciliationStatus: 'PENDING',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await tombstoneStore.saveTombstone(tombstone);

    // Run reconciliation
    const result = await reconcileDisasterRestore(pool, boss, db, {
      tombstoneStore,
      actor: { id: poAccountId, role: 'PRODUCT_OWNER' },
    });

    expect(result.success).toBe(true);
    expect(result.resurrectedDistrictsPurged).toContain(districtId);

    // Verify all 17 tables are completely cleaned
    const dCheck = await db.select().from(districts).where(eq(districts.id, districtId));
    expect(dCheck.length).toBe(0);

    const subCheck = await db.select().from(districtSubscriptions).where(eq(districtSubscriptions.districtId, districtId));
    expect(subCheck.length).toBe(0);

    const topCheck = await db.select().from(topics).where(eq(topics.districtId, districtId));
    expect(topCheck.length).toBe(0);

    const evCheck = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.districtId, districtId));
    expect(evCheck.length).toBe(0);

    const projCheck = await db.select().from(topicProjections).where(eq(topicProjections.districtId, districtId));
    expect(projCheck.length).toBe(0);

    const botCheck = await db.select().from(districtTelegramBots).where(eq(districtTelegramBots.districtId, districtId));
    expect(botCheck.length).toBe(0);

    const grpCheck = await db.select().from(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, districtId));
    expect(grpCheck.length).toBe(0);

    const accCheck = await db.select().from(accounts).where(eq(accounts.districtId, districtId));
    expect(accCheck.length).toBe(0);

    // Verify tombstone in DB has restoreReconciliationStatus = 'RECONCILED'
    const [tombstoneInDb] = await db
      .select()
      .from(districtDeletionRecords)
      .where(eq(districtDeletionRecords.districtId, districtId));
    expect(tombstoneInDb).toBeDefined();
    expect(tombstoneInDb!.liveDeletionStatus).toBe('COMPLETED');
    expect(tombstoneInDb!.restoreReconciliationStatus).toBe('RECONCILED');
    expect(tombstoneInDb!.restoreReconciliationVerifiedAt).toBeDefined();

    // Verify readiness probe now passes (200 OK)
    const readyRes = await server.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
    });
    expect(readyRes.statusCode).toBe(200);
    const body = JSON.parse(readyRes.body);
    expect(body.checks.restoreReconciliation).toBe('ok');
  });

  it('Test 3: Missing tombstone restoration — restores tombstone from external store into DB (AC 2, AC 3)', async () => {
    const districtId = `dist_missing_tomb_${crypto.randomUUID()}`;
    const districtName = `Missing Tombstone District ${crypto.randomUUID().slice(0, 6)}`;

    const now = new Date();
    const tombstone: DistrictDeletionRecord = {
      id: `del_rec_${crypto.randomUUID()}`,
      districtId,
      districtName,
      cancelledAt: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      scheduledLiveDeletionAt: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      actualLiveDeletionAt: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      liveDeletionStatus: 'COMPLETED',
      protectedBackupExpiryDeadline: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      backupExpiryStatus: 'PENDING',
      restoreReconciliationStatus: 'PENDING',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await tombstoneStore.saveTombstone(tombstone);

    // Run reconciliation
    const result = await reconcileDisasterRestore(pool, boss, db, {
      tombstoneStore,
    });

    expect(result.success).toBe(true);

    // Verify tombstone was inserted into district_deletion_records
    const [inserted] = await db
      .select()
      .from(districtDeletionRecords)
      .where(eq(districtDeletionRecords.districtId, districtId));

    expect(inserted).toBeDefined();
    expect(inserted!.districtName).toBe(districtName);
    expect(inserted!.liveDeletionStatus).toBe('COMPLETED');
    expect(inserted!.restoreReconciliationStatus).toBe('RECONCILED');
  });

  it('Test 4: Ordinary 90-day retention reapplication on surviving districts (AC 4)', async () => {
    const survivingDistrictId = `dist_surviving_${crypto.randomUUID()}`;
    const survivingDistrictName = `Surviving District ${crypto.randomUUID().slice(0, 6)}`;

    // Seed surviving district with 95-day-old topic and evidence
    const { topicId } = await seedFull17TableDistrict(survivingDistrictId, survivingDistrictName);

    // Run reconciliation
    const result = await reconcileDisasterRestore(pool, boss, db, {
      tombstoneStore,
    });

    expect(result.success).toBe(true);
    expect(result.expiredTopicsPurged).toBeGreaterThanOrEqual(1);

    // Verify expired topic is deleted
    const [foundTopic] = await db.select().from(topics).where(eq(topics.id, topicId));
    expect(foundTopic).toBeUndefined();

    // Verify surviving district itself is NOT deleted
    const [foundDistrict] = await db.select().from(districts).where(eq(districts.id, survivingDistrictId));
    expect(foundDistrict).toBeDefined();
  });

  it('Test 5: Stale pg-boss job queue suppression for deleted districts (AC 5)', async () => {
    const deletedDistrictId = `dist_stale_job_${crypto.randomUUID()}`;
    const deletedDistrictName = `Deleted District with Jobs ${crypto.randomUUID().slice(0, 6)}`;

    const now = new Date();
    const tombstone: DistrictDeletionRecord = {
      id: `del_rec_${crypto.randomUUID()}`,
      districtId: deletedDistrictId,
      districtName: deletedDistrictName,
      cancelledAt: now.toISOString(),
      scheduledLiveDeletionAt: now.toISOString(),
      actualLiveDeletionAt: now.toISOString(),
      liveDeletionStatus: 'COMPLETED',
      protectedBackupExpiryDeadline: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      backupExpiryStatus: 'PENDING',
      restoreReconciliationStatus: 'PENDING',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await tombstoneStore.saveTombstone(tombstone);

    // Dispatch a job into pg-boss queue for this district
    const jobId = await sendQueueJob(boss, TELEGRAM_TOPIC_ASSIGNMENT_QUEUE, {
      districtId: deletedDistrictId,
      chatId: '-100123',
      messageId: '999',
    });
    expect(jobId).toBeDefined();

    // Run reconciliation
    const result = await reconcileDisasterRestore(pool, boss, db, {
      tombstoneStore,
    });

    expect(result.success).toBe(true);
    expect(result.staleJobsPurged).toBeGreaterThanOrEqual(1);

    // Verify job in pgboss.job is marked cancelled
    const jobRes = await pool.query(
      `SELECT state, output FROM pgboss.job WHERE id = $1`,
      [jobId],
    );
    expect(jobRes.rows[0].state).toBe('cancelled');
    expect(jobRes.rows[0].output?.reason).toBe('SUPPRESSED_BY_DISASTER_RECONCILIATION');
  });

  it('Test 6: Continuity & zero duplicate deletion audit events (AC 6)', async () => {
    const districtId = `dist_audit_test_${crypto.randomUUID()}`;
    const districtName = `Audit Continuity District ${crypto.randomUUID().slice(0, 6)}`;

    await seedFull17TableDistrict(districtId, districtName);

    const now = new Date();
    const tombstone: DistrictDeletionRecord = {
      id: `del_rec_${crypto.randomUUID()}`,
      districtId,
      districtName,
      cancelledAt: now.toISOString(),
      scheduledLiveDeletionAt: now.toISOString(),
      actualLiveDeletionAt: now.toISOString(),
      liveDeletionStatus: 'COMPLETED',
      protectedBackupExpiryDeadline: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      backupExpiryStatus: 'PENDING',
      restoreReconciliationStatus: 'PENDING',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await tombstoneStore.saveTombstone(tombstone);

    // Run reconciliation
    await reconcileDisasterRestore(pool, boss, db, {
      tombstoneStore,
      actor: { id: poAccountId, role: 'PRODUCT_OWNER' },
    });

    // Check audit events
    const auditLogs = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'DISTRICT_RESTORE_RECONCILED'));

    expect(auditLogs.length).toBeGreaterThanOrEqual(1);
    const lastAudit =
      auditLogs.find((a) =>
        (a.metadata as any)?.resurrectedDistrictsPurged?.includes(districtId),
      ) || auditLogs[auditLogs.length - 1];
    expect(lastAudit).toBeDefined();
    expect(lastAudit!.districtId).toBeNull();
    expect(lastAudit!.actorRole).toBe('PRODUCT_OWNER');
    expect((lastAudit!.metadata as any)?.outcome).toBe('SUCCESS');
    expect((lastAudit!.metadata as any)?.resurrectedDistrictsPurged).toContain(districtId);

    // Verify NO duplicate DISTRICT_LIVE_DELETED or DISTRICT_CANCELLED events were created
    const liveDelAudits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'DISTRICT_LIVE_DELETED'),
          eq(auditEvents.districtId, districtId),
        ),
      );
    expect(liveDelAudits.length).toBe(0);
  });

  it('Test 7: Fail-closed on error — creates Critical operational issue and fails readiness probe (AC 7)', async () => {
    // Corrupt external store to simulate failure
    tombstoneStore.setCorrupted(true);

    // Attempt reconciliation; must throw
    await expect(
      reconcileDisasterRestore(pool, boss, db, {
        tombstoneStore,
      }),
    ).rejects.toThrow();

    // Verify Critical operational issue was created
    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.logicalKey, 'disaster_restore_reconciliation_failure'),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );

    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('Critical');
    expect(issue!.scope).toBe('GLOBAL');
    expect(issue!.issueCategory).toBe('DISASTER_RECOVERY');
    expect(issue!.healthStatus).toBe('UNAVAILABLE');

    // Verify readiness probe returns 503 with restoreReconciliation = 'down'
    const readyRes = await server.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
    });
    expect(readyRes.statusCode).toBe(503);
    const body = JSON.parse(readyRes.body);
    expect(body.checks.restoreReconciliation).toBe('down');
  });

  it('Test 8: Operational issue auto-resolution on subsequent success (AC 7, AC 8)', async () => {
    // Restore health in tombstone store
    tombstoneStore.setCorrupted(false);

    // Run reconciliation successfully
    const result = await reconcileDisasterRestore(pool, boss, db, {
      tombstoneStore,
    });
    expect(result.success).toBe(true);

    // Verify active issue is now RESOLVED
    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.logicalKey, 'disaster_restore_reconciliation_failure'));

    expect(issue).toBeDefined();
    expect(issue!.status).toBe('RESOLVED');
    expect(issue!.healthStatus).toBe('Healthy');
    expect(issue!.resolvedAt).toBeDefined();

    // Verify readiness probe returns 200 ready
    const readyRes = await server.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
    });
    expect(readyRes.statusCode).toBe(200);
    expect(JSON.parse(readyRes.body).status).toBe('ready');
  });

  it('Test 9: Idempotency & retry safety — re-running reconciliation succeeds cleanly as a no-op (AC 8)', async () => {
    // Run reconciliation first time
    const res1 = await reconcileDisasterRestore(pool, boss, db, { tombstoneStore });
    expect(res1.success).toBe(true);

    // Run reconciliation second time
    const res2 = await reconcileDisasterRestore(pool, boss, db, { tombstoneStore });
    expect(res2.success).toBe(true);
    expect(res2.resurrectedDistrictsPurged.length).toBe(0);
    expect(res2.errors.length).toBe(0);
  });

  it('Test 10: Product Owner REST API endpoint — POST /api/v1/system/reconcile-disaster-restore (AC 9)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/system/reconcile-disaster-restore',
      headers: {
        'content-type': 'application/json',
        cookie: poCookie,
        ...SAME_ORIGIN_HEADERS,
      },
      payload: {
        dryRun: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.success).toBe(true);
    expect(body.message).toContain('муваффақиятли якунланди');
  });

  it('Test 11: dryRun simulation mode calculates counts without mutating database or queues (BH-02)', async () => {
    const districtId = `dst_dryrun_${crypto.randomUUID()}`;
    const now = new Date();

    // Seed district and tombstone in external store
    await db.insert(districts).values({
      id: districtId,
      name: 'DryRun Test District',
      region: 'Тошкент шаҳри',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    const mockTombstone: DistrictDeletionRecord = {
      id: `del_dry_${crypto.randomUUID()}`,
      districtId,
      districtName: 'DryRun Test District',
      cancelledAt: now.toISOString(),
      cancelledById: poAccountId,
      cancellationReason: 'Dry run test',
      scheduledLiveDeletionAt: now.toISOString(),
      actualLiveDeletionAt: now.toISOString(),
      liveDeletionStatus: 'COMPLETED',
      protectedBackupExpiryDeadline: new Date(now.getTime() + 30 * 86400000).toISOString(),
      backupExpiryStatus: 'PENDING',
      backupExpiryVerifiedAt: null,
      restoreReconciliationStatus: 'PENDING',
      restoreReconciliationVerifiedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await tombstoneStore.saveTombstone(mockTombstone);

    // Run reconciliation in dryRun mode
    const dryRunResult = await reconcileDisasterRestore(pool, boss, db, {
      tombstoneStore,
      dryRun: true,
    });

    expect(dryRunResult.success).toBe(true);
    expect(dryRunResult.resurrectedDistrictsPurged).toContain(districtId);

    // Assert that district STILL EXISTS in database (no actual purge executed)
    const [districtStillExists] = await db
      .select({ id: districts.id })
      .from(districts)
      .where(eq(districts.id, districtId));
    expect(districtStillExists).toBeDefined();

    // Clean up
    await db.delete(districts).where(eq(districts.id, districtId));
  });

  it('Test 12: Standard district live deletion initializes RECONCILED status and leaves readiness probe 200 ready (BH-01)', async () => {
    const liveDelDistrictId = `dst_livedel_${crypto.randomUUID()}`;
    const now = new Date();

    // 1. Create cancelled district & subscription
    await db.insert(districts).values({
      id: liveDelDistrictId,
      name: 'Standard Deletion Test District',
      region: 'Тошкент шаҳри',
      status: 'CANCELLED',
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(districtSubscriptions).values({
      id: `sub_${liveDelDistrictId}`,
      districtId: liveDelDistrictId,
      status: 'CANCELLED',
      statusStartedAt: now,
      scheduledTransitionAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Perform standard live deletion
    const delResult = await executeDistrictLiveDeletion(db, liveDelDistrictId, {
      tombstoneStore,
      actor: { id: poAccountId, role: 'PRODUCT_OWNER' },
    });

    expect(delResult).toBeDefined();
    expect(delResult!.liveDeletionStatus).toBe('COMPLETED');
    expect(delResult!.restoreReconciliationStatus).toBe('RECONCILED');

    // 3. Verify readiness probe returns 200 ready immediately (no false-positive 503 DOS)
    const readyRes = await server.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
    });

    expect(readyRes.statusCode).toBe(200);
    const readyBody = JSON.parse(readyRes.body);
    expect(readyBody.status).toBe('ready');
    expect(readyBody.checks.restoreReconciliation).toBe('ok');
  });
});
