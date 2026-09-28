import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import {
  ExecuteLiveDeletionResponse,
  GetDistrictDeletionRecordResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createBossClient } from '../src/adapters/jobs/boss-client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import {
  accounts,
  sessions,
  districts,
  districtSubscriptions,
  districtDeletionRecords,
  districtTelegramBots,
  districtTelegramGroups,
  telegramIntakeRecords,
  aiProfiles,
  aiOperations,
  aiProviderAttempts,
  topics,
  acceptedEvidence,
  topicProjections,
  districtAnalysisSettingsVersions,
  districtAnalysisSettingsDrafts,
  operationalIssues,
  userDashboardVisits,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import {
  executeDistrictLiveDeletion,
  getDistrictDeletionRecord,
  validateDistrictScope,
  processOverdueCancelledDistricts,
  DistrictNotEligibleForDeletionError,
  DistrictAlreadyDeletedError,
} from '../src/modules/subscriptions/district-deletion-service.js';
import {
  processDistrictDeletionJobs,
} from '../src/modules/subscriptions/jobs/district-deletion-job-handler.js';
import { startDistrictRecovery } from '../src/modules/subscriptions/subscriptions-service.js';
import { runMigrations } from '../src/adapters/db/migrate.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 6.4: Execute Permanent Live-System District Deletion Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;
  let boss: any;

  let poCookie = '';
  let poAccountId = '';
  let defaultAiProfileId = '';

  beforeAll(async () => {
    await runMigrations();
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient();
    await boss.start();

    server = await buildHttpServer({ db, pool, boss });
    await server.ready();

    // 1. Seed Product Owner
    const poUsername = `po_del_test_${Date.now()}_${crypto.randomUUID().slice(0, 4)}`;
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

    // 2. Ensure default AI Profile exists for foreign keys
    defaultAiProfileId = `prof_del_test_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(aiProfiles).values({
      id: defaultAiProfileId,
      version: 1,
      operationType: 'TOPIC_DERIVED_PROJECTION',
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini',
      promptVersion: '1.0',
      schemaVersion: '1.0',
      temperature: 0.0,
      maxOutputTokens: 500,
      timeoutMs: 10000,
      retryPolicy: { maxAttempts: 3 },
      capabilities: { structuredOutputs: true },
      isActive: true,
    });
  });

  afterAll(async () => {
    if (server) await server.close();
    if (boss) await boss.stop();
    if (pool) await pool.end();
  });

  // Helper to seed a complete district with data in all 17 tables
  async function seedCompleteDistrict(baseName: string, status: 'CANCELLED' | 'ACTIVE' = 'CANCELLED', deadlineOffsetDays: number = -1) {
    const districtId = `dist_${crypto.randomUUID().slice(0, 8)}`;
    const districtName = `${baseName} ${crypto.randomUUID().slice(0, 6)}`;
    const now = new Date();
    const scheduledTransitionAt = new Date(now.getTime() + deadlineOffsetDays * 24 * 60 * 60 * 1000);

    // 1. districts
    await db.insert(districts).values({
      id: districtId,
      name: districtName,
      region: 'Тошкент шаҳри',
      status,
      disclosureConfirmedAt: now,
      disclosureConfirmedById: poAccountId,
      activatedAt: now,
      activatedById: poAccountId,
    });

    // 2. districtSubscriptions
    await db.insert(districtSubscriptions).values({
      id: `sub_${districtId}`,
      districtId,
      status,
      statusStartedAt: now,
      scheduledTransitionAt: status === 'CANCELLED' ? scheduledTransitionAt : null,
      scheduledTransitionType: status === 'CANCELLED' ? 'LIVE_DELETION' : null,
      externalPaymentReference: 'BANK-REF-DEL',
      internalNote: 'Reason: Subscription terminated for test',
      updatedById: poAccountId,
    });

    // 3. districtTelegramBots
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
      lastValidatedAt: now,
    });

    // 4. districtTelegramGroups
    const chatId = `-100${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    await db.insert(districtTelegramGroups).values({
      id: crypto.randomUUID(),
      districtId,
      mahallaName: 'Маҳалла 1',
      telegramChatId: chatId,
      telegramChatTitle: 'Маҳалла 1 гуруҳи',
      status: 'VALID',
    });

    // 5. accounts
    const hokimAccountId = crypto.randomUUID();
    const hokimUsername = `hokim_${crypto.randomUUID().slice(0, 8)}`;
    const hokimPasswordHash = await hashPassword('SecureHokimPassword2026!');
    await db.insert(accounts).values({
      id: hokimAccountId,
      username: hokimUsername,
      passwordHash: hokimPasswordHash,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId,
      mustChangePassword: false,
    });

    // 6. sessions
    await db.insert(sessions).values({
      id: crypto.randomUUID(),
      accountId: hokimAccountId,
      tokenHash: crypto.randomBytes(32).toString('hex'),
      credentialVersion: 1,
      expiresAt: new Date(now.getTime() + 86400000),
    });

    // 7. telegramIntakeRecords
    const intakeId = `int_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId,
      mahallaName: 'Маҳалла 1',
      telegramBotId: botId,
      telegramChatId: chatId,
      telegramMessageId: '101',
      calendarDay: '2026-08-28',
      originalTimestamp: now,
      rawPayload: { text: 'Сув йўқ' },
    });

    // 8. aiOperations
    const aiOpId = `ai_op_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(aiOperations).values({
      id: aiOpId,
      districtId,
      mahallaName: 'Маҳалла 1',
      calendarDay: '2026-08-28',
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: intakeId,
      pinnedProfileId: defaultAiProfileId,
      finalStatus: 'COMPLETED_RELEVANT',
      snapshotFingerprint: 'fingerprint_abc',
    });

    // 9. aiProviderAttempts
    await db.insert(aiProviderAttempts).values({
      id: crypto.randomUUID(),
      operationId: aiOpId,
      attemptNumber: 1,
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini',
      durationMs: 450,
      status: 'SUCCESS',
    });

    // 10. topics
    const topicId = `top_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(topics).values({
      id: topicId,
      districtId,
      mahallaName: 'Маҳалла 1',
      calendarDay: '2026-08-28',
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: now,
      retentionExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
    });

    // 11. acceptedEvidence
    const evidenceId = `evi_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(acceptedEvidence).values({
      id: evidenceId,
      topicId,
      districtId,
      mahallaName: 'Маҳалла 1',
      calendarDay: '2026-08-28',
      intakeRecordId: intakeId,
      telegramChatId: chatId,
      telegramMessageId: '101',
      originalTimestamp: now,
      verbatimText: 'Сув йўқ эрталабдан бери',
      contentType: 'TEXT',
      aiOperationId: aiOpId,
    });

    // 12. topicProjections
    await db.insert(topicProjections).values({
      id: `prj_${crypto.randomUUID().slice(0, 8)}`,
      topicId,
      districtId,
      mahallaName: 'Маҳалла 1',
      calendarDay: '2026-08-28',
      summary: 'Маҳаллада ичимлик суви таъминоти узилган',
      lanes: ['WATER'],
      primaryLane: 'WATER',
      anchorEvidenceId: evidenceId,
      anchorQuote: 'Сув йўқ эрталабдан бери',
      latestMeaningfulActivityTimestamp: now,
      attribution: 'resident',
      generation: 1,
      aiProfileId: defaultAiProfileId,
    });

    // 13. districtAnalysisSettingsVersions
    const versionId = `dcfg_${crypto.randomUUID().slice(0, 8)}_v1`;
    await db.insert(districtAnalysisSettingsVersions).values({
      id: versionId,
      districtId,
      version: 1,
      hokimRecognitionTerms: ['Ҳокимжон'],
      localVocabularyAdditions: [],
      isActive: true,
      activatedAt: now,
      activatedBy: poAccountId,
    });

    // 14. districtAnalysisSettingsDrafts
    await db.insert(districtAnalysisSettingsDrafts).values({
      id: `draft_${districtId}`,
      districtId,
      baseActiveVersionId: versionId,
      hokimRecognitionTerms: ['Ҳокимжон'],
      localVocabularyAdditions: [],
      updatedBy: poAccountId,
    });

    // 15. operationalIssues
    await db.insert(operationalIssues).values({
      id: `iss_${crypto.randomUUID().slice(0, 8)}`,
      logicalKey: `issue_${districtId}`,
      scope: 'DISTRICT',
      districtId,
      component: 'TELEGRAM_INTAKE',
      issueCategory: 'NETWORK_TIMEOUT',
      severity: 'Warning',
      status: 'ACTIVE',
      healthStatus: 'HEALTHY',
      sanitizedTitle: 'Вақтинчалик уланиш кечикиши',
      sanitizedDescription: 'Тафсилотлар',
      recommendedAction: 'Кутинг',
      startedAt: now,
      latestCheckAt: now,
    });

    // 16. userDashboardVisits
    await db.insert(userDashboardVisits).values({
      id: `vis_${crypto.randomUUID().slice(0, 8)}`,
      userId: hokimAccountId,
      districtId,
      visitedAt: now,
    });

    // 17. auditEvents (district-scoped)
    await db.insert(auditEvents).values({
      id: crypto.randomUUID(),
      districtId,
      actorId: poAccountId,
      actorRole: 'PRODUCT_OWNER',
      action: 'DISTRICT_CREATED',
      metadata: { districtName },
    });

    return {
      districtId,
      districtName,
      hokimAccountId,
      intakeId,
      aiOpId,
      topicId,
      evidenceId,
      versionId,
    };
  }

  describe('1. Comprehensive Multi-Table Live Data Purging & FK Restriction Handling (AC 1, 2, 3, 4, 5)', () => {
    it('permanently deletes all live data across all 17 tables in strict topological order and persists surviving tombstone', async () => {
      const seed = await seedCompleteDistrict('Сирғали', 'CANCELLED', -1);

      // Execute live deletion
      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${seed.districtId}/subscription/execute-live-deletion`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(response.statusCode).toBe(200);
      const data: ExecuteLiveDeletionResponse = response.json();
      expect(data.deletionRecord.districtId).toBe(seed.districtId);
      expect(data.deletionRecord.districtName).toBe(seed.districtName);
      expect(data.deletionRecord.liveDeletionStatus).toBe('COMPLETED');
      expect(data.deletionRecord.backupExpiryStatus).toBe('PENDING');

      // Verify backup expiry deadline is exactly actualLiveDeletionAt + 30 days
      const actualAt = new Date(data.deletionRecord.actualLiveDeletionAt).getTime();
      const expiryDeadline = new Date(data.deletionRecord.protectedBackupExpiryDeadline).getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(expiryDeadline - actualAt).toBe(thirtyDaysMs);

      // ── VERIFY ALL 17 LIVE TABLES ARE PURGED FOR THIS DISTRICT ──
      // 1. topic_projections
      const projs = await db.select().from(topicProjections).where(eq(topicProjections.districtId, seed.districtId));
      expect(projs.length).toBe(0);

      // 2. accepted_evidence
      const evs = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.districtId, seed.districtId));
      expect(evs.length).toBe(0);

      // 3. topics
      const tops = await db.select().from(topics).where(eq(topics.districtId, seed.districtId));
      expect(tops.length).toBe(0);

      // 4. ai_provider_attempts
      const attempts = await db.execute(sql`SELECT * FROM ai_provider_attempts WHERE operation_id = ${seed.aiOpId}`);
      expect(attempts.rows.length).toBe(0);

      // 5. ai_operations
      const ops = await db.select().from(aiOperations).where(eq(aiOperations.districtId, seed.districtId));
      expect(ops.length).toBe(0);

      // 6. telegram_intake_records
      const intakes = await db.select().from(telegramIntakeRecords).where(eq(telegramIntakeRecords.districtId, seed.districtId));
      expect(intakes.length).toBe(0);

      // 7. district_analysis_settings_drafts
      const drafts = await db.select().from(districtAnalysisSettingsDrafts).where(eq(districtAnalysisSettingsDrafts.districtId, seed.districtId));
      expect(drafts.length).toBe(0);

      // 8. district_analysis_settings_versions
      const versions = await db.select().from(districtAnalysisSettingsVersions).where(eq(districtAnalysisSettingsVersions.districtId, seed.districtId));
      expect(versions.length).toBe(0);

      // 9. operational_issues
      const issues = await db.select().from(operationalIssues).where(eq(operationalIssues.districtId, seed.districtId));
      expect(issues.length).toBe(0);

      // 10. user_dashboard_visits
      const visits = await db.select().from(userDashboardVisits).where(eq(userDashboardVisits.districtId, seed.districtId));
      expect(visits.length).toBe(0);

      // 11. sessions
      const sess = await db.execute(sql`SELECT * FROM sessions WHERE account_id = ${seed.hokimAccountId}`);
      expect(sess.rows.length).toBe(0);

      // 12. accounts
      const accs = await db.select().from(accounts).where(eq(accounts.districtId, seed.districtId));
      expect(accs.length).toBe(0);

      // 13. district_telegram_groups
      const groups = await db.select().from(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, seed.districtId));
      expect(groups.length).toBe(0);

      // 14. district_telegram_bots
      const bots = await db.select().from(districtTelegramBots).where(eq(districtTelegramBots.districtId, seed.districtId));
      expect(bots.length).toBe(0);

      // 15. audit_events (District-scoped)
      const districtAudit = await db.select().from(auditEvents).where(eq(auditEvents.districtId, seed.districtId));
      expect(districtAudit.length).toBe(0);

      // 16. district_subscriptions
      const subs = await db.select().from(districtSubscriptions).where(eq(districtSubscriptions.districtId, seed.districtId));
      expect(subs.length).toBe(0);

      // 17. districts
      const dists = await db.select().from(districts).where(eq(districts.id, seed.districtId));
      expect(dists.length).toBe(0);

      // ── VERIFY SURVIVING TOMBSTONE IN district_deletion_records ──
      const tombstones = await db.select().from(districtDeletionRecords).where(eq(districtDeletionRecords.districtId, seed.districtId));
      expect(tombstones.length).toBe(1);
      expect(tombstones[0]?.districtName).toBe(seed.districtName);
      expect(tombstones[0]?.liveDeletionStatus).toBe('COMPLETED');
    });

    it('guarantees cross-district multi-tenant isolation during deletion (AC 3)', async () => {
      const victim = await seedCompleteDistrict('Яккасарой', 'CANCELLED', -1);
      const survivor = await seedCompleteDistrict('Мирзо Улуғбек', 'ACTIVE', 0);

      // Delete victim
      const res = await executeDistrictLiveDeletion(db, victim.districtId);
      expect(res).toBeTruthy();

      // Verify survivor district and its associated data are untouched
      const [survivingDist] = await db.select().from(districts).where(eq(districts.id, survivor.districtId));
      expect(survivingDist?.status).toBe('ACTIVE');

      const survivingTops = await db.select().from(topics).where(eq(topics.districtId, survivor.districtId));
      expect(survivingTops.length).toBe(1);

      const survivingEvs = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.districtId, survivor.districtId));
      expect(survivingEvs.length).toBe(1);

      const survivingProjs = await db.select().from(topicProjections).where(eq(topicProjections.districtId, survivor.districtId));
      expect(survivingProjs.length).toBe(1);

      const survivingGroups = await db.select().from(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, survivor.districtId));
      expect(survivingGroups.length).toBe(1);

      const survivingBots = await db.select().from(districtTelegramBots).where(eq(districtTelegramBots.districtId, survivor.districtId));
      expect(survivingBots.length).toBe(1);

      const survivingSubs = await db.select().from(districtSubscriptions).where(eq(districtSubscriptions.districtId, survivor.districtId));
      expect(survivingSubs.length).toBe(1);
    });
  });

  describe('2. Idempotency, Stale Job Protection & Recovery Denial (AC 1, 4, 6)', () => {
    it('executes idempotently as a safe no-op on re-execution (AC 4)', async () => {
      const seed = await seedCompleteDistrict('Бектемир', 'CANCELLED', -1);

      // First run
      const firstRes = await executeDistrictLiveDeletion(db, seed.districtId);
      expect(firstRes).toBeTruthy();

      // Second run
      const secondRes = await executeDistrictLiveDeletion(db, seed.districtId);
      expect(secondRes).toBeTruthy();
      expect(secondRes?.id).toBe(firstRes?.id);
      expect(secondRes?.districtId).toBe(seed.districtId);

      // Ensure exactly one tombstone exists
      const tombstones = await db.select().from(districtDeletionRecords).where(eq(districtDeletionRecords.districtId, seed.districtId));
      expect(tombstones.length).toBe(1);
    });

    it('safely aborts without deleting if a cancelled district was recovered to ACTIVE or SETUP_INCOMPLETE (AC 1, 4)', async () => {
      const seed = await seedCompleteDistrict('Шайхонтоҳур', 'ACTIVE', 0);

      // Attempt deletion on ACTIVE district
      const result = await executeDistrictLiveDeletion(db, seed.districtId);
      expect(result).toBeNull();

      // Verify district remains intact
      const [dist] = await db.select().from(districts).where(eq(districts.id, seed.districtId));
      expect(dist).toBeDefined();
      expect(dist?.status).toBe('ACTIVE');

      // Verify no tombstone was created
      const tombstones = await db.select().from(districtDeletionRecords).where(eq(districtDeletionRecords.districtId, seed.districtId));
      expect(tombstones.length).toBe(0);
    });

    it('permanently denies recovery and activation after live deletion (AC 6)', async () => {
      const seed = await seedCompleteDistrict('Учтепа', 'CANCELLED', -1);
      await executeDistrictLiveDeletion(db, seed.districtId);

      // 1. Try recovery via service
      await expect(
        startDistrictRecovery(db, seed.districtId, { reason: 'Тиклашга уриниш' }),
      ).rejects.toThrow(DistrictAlreadyDeletedError);

      // 2. Try recovery via REST endpoint
      const recoveryRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${seed.districtId}/subscription/start-recovery`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
        payload: { reason: 'Тиклашга уриниш' },
      });
      expect(recoveryRes.statusCode).toBe(409);
      expect(recoveryRes.json().error.code).toBe('DISTRICT_ALREADY_DELETED');

      // 3. Try activate via REST endpoint
      const activateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/districts/${seed.districtId}/activate`,
        headers: {
          'content-type': 'application/json',
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });
      expect(activateRes.statusCode).toBe(409);
      expect(activateRes.json().error.code).toBe('DISTRICT_ALREADY_DELETED');
    });

    it('rejects deletion when 30-day deadline has not yet arrived unless bypassed (AC 1)', async () => {
      const seed = await seedCompleteDistrict('Миробод', 'CANCELLED', 10); // 10 days in future

      await expect(
        executeDistrictLiveDeletion(db, seed.districtId, { bypassDeadlineCheck: false }),
      ).rejects.toThrow(DistrictNotEligibleForDeletionError);

      // District remains intact
      const [dist] = await db.select().from(districts).where(eq(districts.id, seed.districtId));
      expect(dist).toBeTruthy();
    });
  });

  describe('3. Background Cron Sweeper, Global Audit & System Health Diagnostics (AC 9, 10, 11)', () => {
    it('processes overdue cancelled districts automatically via background cron sweeper (AC 9)', async () => {
      const seed1 = await seedCompleteDistrict('Яшнобод', 'CANCELLED', -2);
      const seed2 = await seedCompleteDistrict('Зангиота', 'CANCELLED', -5);

      const sweepResult = await processOverdueCancelledDistricts(db);
      expect(sweepResult.processedCount).toBeGreaterThanOrEqual(2);

      // Verify both districts are live-deleted
      const [d1] = await db.select().from(districts).where(eq(districts.id, seed1.districtId));
      expect(d1).toBeUndefined();

      const [d2] = await db.select().from(districts).where(eq(districts.id, seed2.districtId));
      expect(d2).toBeUndefined();
    });

    it('logs exactly one global audit event with SYSTEM actor and null districtId (AC 10)', async () => {
      const seed = await seedCompleteDistrict('Қибрай', 'CANCELLED', -1);

      await executeDistrictLiveDeletion(db, seed.districtId);

      const globalLogs = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'DISTRICT_LIVE_DELETED'),
            sql`${auditEvents.districtId} IS NULL`,
          ),
        );

      const matchingLog = globalLogs.find((l) => (l.metadata as any)?.deletedDistrictId === seed.districtId);
      expect(matchingLog).toBeTruthy();
      expect(matchingLog?.actorRole).toBe('SYSTEM');
      expect((matchingLog?.metadata as any)?.deletedDistrictName).toBe(seed.districtName);
      expect((matchingLog?.metadata as any)?.protectedBackupExpiryDeadline).toBeTruthy();
    });

    it('inspects surviving deletion record via GET /api/v1/districts/:districtId/deletion-record (AC 5)', async () => {
      const seed = await seedCompleteDistrict('Чирчиқ', 'CANCELLED', -1);
      await executeDistrictLiveDeletion(db, seed.districtId);

      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${seed.districtId}/deletion-record`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const data: GetDistrictDeletionRecordResponse = res.json();
      expect(data.deletionRecord.districtId).toBe(seed.districtId);
      expect(data.deletionRecord.liveDeletionStatus).toBe('COMPLETED');
      expect(data.deletionRecord.backupExpiryStatus).toBe('PENDING');
    });

    it('records Critical operational issue in operational_issues on unrecoverable deletion job failure (AC 11)', async () => {
      const badDistrictId = `bad_dist_${crypto.randomUUID().slice(0, 6)}`;
      const mockJob: any = {
        data: { districtId: badDistrictId },
      };

      // When processDistrictDeletionJobs fails on invalid district
      await expect(
        processDistrictDeletionJobs([mockJob], { db }),
      ).rejects.toThrow();

      // Check operational issue created
      const issues = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.logicalKey, `del_fail:${badDistrictId}`));

      expect(issues.length).toBe(1);
      expect(issues[0]?.severity).toBe('Critical');
      expect(issues[0]?.issueCategory).toBe('LIFECYCLE_DELETION');
      expect(issues[0]?.healthStatus).toBe('UNAVAILABLE');
    });

    it('validates district scope and rejects empty/blank districtId (AC 3)', async () => {
      expect(() => validateDistrictScope('')).toThrow('INVALID_DISTRICT_SCOPE');
      expect(() => validateDistrictScope('   ')).toThrow('INVALID_DISTRICT_SCOPE');
      await expect(executeDistrictLiveDeletion(db, '')).rejects.toThrow('INVALID_DISTRICT_SCOPE');
      await expect(getDistrictDeletionRecord(db, '')).rejects.toThrow('INVALID_DISTRICT_SCOPE');
    });

    it('purges active global operational issue when deletion subsequently succeeds', async () => {
      const seed = await seedCompleteDistrict('Чилонзор-Ишью', 'CANCELLED', -1);
      const logicalKey = `del_fail:${seed.districtId}`;

      // Insert pre-existing global failure issue
      await db.insert(operationalIssues).values({
        id: `iss_${crypto.randomUUID()}`,
        logicalKey,
        scope: 'GLOBAL',
        districtId: null,
        component: 'SUBSCRIPTION_LIFECYCLE',
        issueCategory: 'LIFECYCLE_DELETION',
        severity: 'Critical',
        status: 'ACTIVE',
        healthStatus: 'DEGRADED',
        sanitizedTitle: 'Туманни жонли тизимдан ўчиришда хатолик',
        sanitizedDescription: 'Test failure issue',
        recommendedAction: 'Retry deletion',
        startedAt: new Date(),
        latestCheckAt: new Date(),
      });

      // Execute live deletion
      await executeDistrictLiveDeletion(db, seed.districtId);

      // Verify global operational issue is purged
      const activeIssues = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.logicalKey, logicalKey));

      expect(activeIssues.length).toBe(0);
    });
  });
});
