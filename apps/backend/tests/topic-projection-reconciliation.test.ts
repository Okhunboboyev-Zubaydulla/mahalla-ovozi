import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, and } from 'drizzle-orm';
import {
  createDbPool,
  createDbClient,
  type DbClient,
} from '../src/adapters/db/client.js';
import {
  districts,
  topics,
  topicProjections,
  aiOperations,
  operationalIssues,
  acceptedEvidence,
  telegramIntakeRecords,
} from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import {
  createBossClient,
  initBossQueues,
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  JobSingletonKeys,
  type TelegramTopicProjectionJobData,
} from '../src/adapters/jobs/boss-client.js';
import {
  findUnprojectedTopics,
  reconcileUnprojectedTopics,
} from '../src/modules/topics/topic-reconciliation-service.js';
import { processTopicProjectionJobs } from '../src/modules/topics/jobs/topic-projection-job-handler.js';
import { TopicProjectionEvaluator } from '../src/modules/topics/topic-projection-evaluator.js';
import { AiGatewayError } from '../src/modules/ai/types.js';
import { createMockAiGateway } from './helpers/mock-ai-gateway.js';

describe('Topic Projection Reconciliation & Recovery', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;
  let testDistrictId: string;
  const testCalendarDay = '2026-09-08';

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient({ schema: 'pgboss_topic_reconcile_test' });
    await boss.start();
    await initBossQueues(boss);
    await ensureDefaultAiProfiles(db);

    testDistrictId = `dist_rec_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(districts).values({
      id: testDistrictId,
      name: 'Reconciliation Test District',
      region: 'Tashkent',
      status: 'ACTIVE',
      accessEligible: true,
    });
  });

  const cleanupTestData = async () => {
    await pool.query('DELETE FROM pgboss_topic_reconcile_test.job');
    await db.delete(topicProjections).where(eq(topicProjections.districtId, testDistrictId));
    await db.delete(acceptedEvidence).where(eq(acceptedEvidence.districtId, testDistrictId));
    await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.districtId, testDistrictId));
    await db.delete(operationalIssues).where(eq(operationalIssues.districtId, testDistrictId));
    await db.delete(aiOperations).where(eq(aiOperations.districtId, testDistrictId));
    await db.delete(topics).where(eq(topics.districtId, testDistrictId));
  };

  afterAll(async () => {
    await cleanupTestData();
    await db.delete(districts).where(eq(districts.id, testDistrictId));
    await boss.stop({ graceful: true, timeout: 5000 });
    await pool.end();
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  it('detects unprojected active topics where topic_projections row is missing', async () => {
    const topicId = `top_missing_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    // 2 minutes ago to exceed default grace period of 30s
    const pastTime = new Date(now.getTime() - 120 * 1000);

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Navbahor',
      calendarDay: testCalendarDay,
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: pastTime,
      retentionExpiresAt: new Date(now.getTime() + 86400000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
      createdAt: pastTime,
      updatedAt: pastTime,
    });

    const candidates = await findUnprojectedTopics(db, {
      districtId: testDistrictId,
      gracePeriodSeconds: 10,
    });

    const found = candidates.find((c) => c.topicId === topicId);
    expect(found).toBeDefined();
    expect(found?.requiredDerivedGeneration).toBe(1);
    expect(found?.appliedDerivedGeneration).toBe(0);
    expect(found?.hasProjection).toBe(false);
  });

  it('detects active topics with stale generation (appliedDerivedGeneration < requiredDerivedGeneration)', async () => {
    const topicId = `top_stale_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    const pastTime = new Date(now.getTime() - 120 * 1000);

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Gulbodom',
      calendarDay: testCalendarDay,
      primaryLane: 'WASTE',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: pastTime,
      retentionExpiresAt: new Date(now.getTime() + 86400000),
      requiredDerivedGeneration: 2,
      appliedDerivedGeneration: 1,
      createdAt: pastTime,
      updatedAt: pastTime,
    });

    // Create existing projection for generation 1
    const intakeId = `intake_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId: testDistrictId,
      mahallaName: 'Gulbodom',
      calendarDay: testCalendarDay,
      telegramBotId: 'bot_123',
      telegramChatId: '-10012345678',
      telegramMessageId: '101',
      originalTimestamp: pastTime,
      rawPayload: { text: 'Chiqindi toplanib qolgan' },
    });

    const evidenceId = `evi_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(acceptedEvidence).values({
      id: evidenceId,
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Gulbodom',
      calendarDay: testCalendarDay,
      intakeRecordId: intakeId,
      telegramChatId: '-10012345678',
      telegramMessageId: '101',
      originalTimestamp: pastTime,
      contentType: 'TEXT',
      verbatimText: 'Chiqindi toplanib qolgan',
    });

    await db.insert(topicProjections).values({
      id: `prj_${crypto.randomUUID().slice(0, 8)}`,
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Gulbodom',
      calendarDay: testCalendarDay,
      summary: 'Eski xulosa',
      lanes: ['WASTE'],
      primaryLane: 'WASTE',
      anchorEvidenceId: evidenceId,
      anchorQuote: 'Chiqindi',
      latestMeaningfulActivityTimestamp: pastTime,
      attribution: 'Mahalla',
      generation: 1,
      aiProfileId: 'prof_proj_2026_08_v1',
    });

    const candidates = await findUnprojectedTopics(db, {
      districtId: testDistrictId,
      gracePeriodSeconds: 10,
    });

    const found = candidates.find((c) => c.topicId === topicId);
    expect(found).toBeDefined();
    expect(found?.requiredDerivedGeneration).toBe(2);
    expect(found?.appliedDerivedGeneration).toBe(1);
    expect(found?.hasProjection).toBe(true);
  });

  it('reconciles unprojected topic by enqueuing into pg-boss and enforces singleton idempotency', async () => {
    const topicId = `top_recon_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    const pastTime = new Date(now.getTime() - 120 * 1000);

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Mustaqillik',
      calendarDay: testCalendarDay,
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: pastTime,
      retentionExpiresAt: new Date(now.getTime() + 86400000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
      createdAt: pastTime,
      updatedAt: pastTime,
    });

    // 1. First reconciliation sweep enqueues the job
    const summary1 = await reconcileUnprojectedTopics(db, boss, {
      districtId: testDistrictId,
      gracePeriodSeconds: 10,
    });
    expect(summary1.enqueuedCount).toBeGreaterThanOrEqual(1);

    // 2. Second sweep while job is pending in queue -> deduplicated by singletonKey (skipped)
    const summary2 = await reconcileUnprojectedTopics(db, boss, {
      districtId: testDistrictId,
      gracePeriodSeconds: 10,
    });
    expect(summary2.skippedCount).toBeGreaterThanOrEqual(1);

    // 3. Verify job exists in pg-boss
    const [job] = await boss.fetch<TelegramTopicProjectionJobData>(
      TELEGRAM_TOPIC_PROJECTION_QUEUE,
    );
    expect(job).toBeDefined();
    expect(job?.data.topicId).toBe(topicId);
    expect(job?.data.generation).toBe(1);
  });

  it('revives a projection job that permanently failed (pg-boss state = failed)', async () => {
    const topicId = `top_failed_revive_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    const pastTime = new Date(now.getTime() - 120 * 1000);

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Bogbon',
      calendarDay: testCalendarDay,
      primaryLane: 'GAS',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: pastTime,
      retentionExpiresAt: new Date(now.getTime() + 86400000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
      createdAt: pastTime,
      updatedAt: pastTime,
    });

    // Simulate an earlier job that failed and exhausted all retries
    const singletonKey = JobSingletonKeys.forTopicProjection(topicId, 1);
    const initialJobId = await boss.send(
      TELEGRAM_TOPIC_PROJECTION_QUEUE,
      {
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Bogbon',
        calendarDay: testCalendarDay,
        generation: 1,
      },
      { singletonKey },
    );
    expect(initialJobId).toBeDefined();

    // Mark that job as failed in pgboss
    await pool.query(
      `UPDATE pgboss_topic_reconcile_test.job SET state = 'failed', completed_on = NOW() WHERE id = $1`,
      [initialJobId],
    );

    // Reconciliation sweep should revive it and enqueue a new job
    const summary = await reconcileUnprojectedTopics(db, boss, {
      districtId: testDistrictId,
      gracePeriodSeconds: 10,
    });
    expect(summary.enqueuedCount).toBeGreaterThanOrEqual(1);

    // Fetch the new job
    const [revivedJob] = await boss.fetch<TelegramTopicProjectionJobData>(
      TELEGRAM_TOPIC_PROJECTION_QUEUE,
    );
    expect(revivedJob).toBeDefined();
    expect(revivedJob?.data.topicId).toBe(topicId);
    expect(revivedJob?.id).not.toBe(initialJobId);
  });

  it('creates an active operational issue (TOPIC_PROCESSING_DELAY) when a topic is stuck > 5 minutes with AI error', async () => {
    const topicId = `top_stuck_opissue_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    // Created 10 minutes ago
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Chilonzor',
      calendarDay: testCalendarDay,
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: tenMinAgo,
      retentionExpiresAt: new Date(now.getTime() + 86400000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
      createdAt: tenMinAgo,
      updatedAt: tenMinAgo,
    });

    // Record failed AI operation
    const failedOpId = `aiop_fail_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(aiOperations).values({
      id: failedOpId,
      districtId: testDistrictId,
      mahallaName: 'Chilonzor',
      calendarDay: testCalendarDay,
      operationType: 'TOPIC_DERIVED_PROJECTION',
      targetId: `${topicId}:1`,
      pinnedProfileId: 'prof_proj_2026_08_v1',
      contextRevision: 0,
      snapshotFingerprint: 'error',
      finalStatus: 'FAILED',
      resultPayload: { error: 'Network error: fetch failed' },
      createdAt: tenMinAgo,
      updatedAt: tenMinAgo,
    });

    const summary = await reconcileUnprojectedTopics(db, boss, {
      districtId: testDistrictId,
      gracePeriodSeconds: 10,
      stuckThresholdMinutes: 5,
    });
    expect(summary.issuesRaisedCount).toBeGreaterThanOrEqual(1);

    const [activeIssue] = await db
      .select()
      .from(operationalIssues)
      .where(
        and(
          eq(
            operationalIssues.logicalKey,
            `DISTRICT:${testDistrictId}:topic_projection:TOPIC_PROCESSING_DELAY:${topicId}`,
          ),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );

    expect(activeIssue).toBeDefined();
    expect(activeIssue?.issueCategory).toBe('TOPIC_PROCESSING_DELAY');
    expect(activeIssue?.metadata).toMatchObject({
      topicId,
      districtId: testDistrictId,
      generation: 1,
    });
  });

  it('L3-P05-16: a failed projection records the COALESCED generation so the sweep can match it', async () => {
    const topicId = `top_keygen_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    const pastTime = new Date(now.getTime() - 10 * 60 * 1000);

    // Topic has advanced to required generation 3 while applied is still 1.
    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Keygen',
      calendarDay: testCalendarDay,
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: pastTime,
      retentionExpiresAt: new Date(now.getTime() + 86400000),
      requiredDerivedGeneration: 3,
      appliedDerivedGeneration: 1,
      createdAt: pastTime,
      updatedAt: pastTime,
    });

    const intakeId = `intake_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId: testDistrictId,
      mahallaName: 'Keygen',
      calendarDay: testCalendarDay,
      telegramBotId: 'bot_123',
      telegramChatId: '-10012345678',
      telegramMessageId: '701',
      originalTimestamp: pastTime,
      rawPayload: { text: 'Suv bosimi past' },
    });

    const evidenceId = `evi_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(acceptedEvidence).values({
      id: evidenceId,
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Keygen',
      calendarDay: testCalendarDay,
      intakeRecordId: intakeId,
      telegramChatId: '-10012345678',
      telegramMessageId: '701',
      originalTimestamp: pastTime,
      contentType: 'TEXT',
      verbatimText: 'Suv bosimi past',
    });

    // The job was enqueued for generation 2, now behind the topic's required 3.
    const mockController = createMockAiGateway();
    mockController.mockAdapter.setNextError(
      new AiGatewayError('PROVIDER_TIMEOUT', 'AI gateway timed out', {
        status: 504,
        retryable: true,
      }),
    );
    const evaluator = new TopicProjectionEvaluator(mockController.gateway);

    const fakeJob: any = {
      data: {
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Keygen',
        calendarDay: testCalendarDay,
        generation: 2,
      },
    };

    await expect(
      processTopicProjectionJobs([fakeJob], {
        db,
        pool,
        boss,
        topicProjectionEvaluator: evaluator,
      }),
    ).rejects.toThrow();

    // The failure row MUST be keyed on the coalesced generation (3) — the value the
    // reconciliation sweep searches for. Keying it on the job's generation (2) makes
    // the row unmatchable and silently suppresses the TOPIC_PROCESSING_DELAY alarm.
    const rows = await db
      .select()
      .from(aiOperations)
      .where(
        and(
          eq(aiOperations.districtId, testDistrictId),
          eq(aiOperations.operationType, 'TOPIC_DERIVED_PROJECTION'),
          eq(aiOperations.finalStatus, 'FAILED'),
        ),
      );

    const failureRow = rows.find((r) => r.targetId.startsWith(topicId));
    expect(failureRow).toBeDefined();
    expect(failureRow?.targetId).toBe(`${topicId}:3`);

    // And the sweep must actually raise the alarm for it.
    const summary = await reconcileUnprojectedTopics(db, boss, {
      districtId: testDistrictId,
      gracePeriodSeconds: 10,
      stuckThresholdMinutes: 5,
    });
    expect(summary.issuesRaisedCount).toBeGreaterThanOrEqual(1);
  });

  it('auto-resolves TOPIC_PROCESSING_DELAY operational issue when projection commits successfully', async () => {
    const topicId = `top_autoresolve_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    const pastTime = new Date(now.getTime() - 120 * 1000);

    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: testCalendarDay,
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: pastTime,
      retentionExpiresAt: new Date(now.getTime() + 86400000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
      createdAt: pastTime,
      updatedAt: pastTime,
    });

    const intakeId = `intake_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: testCalendarDay,
      telegramBotId: 'bot_123',
      telegramChatId: '-10012345678',
      telegramMessageId: '505',
      originalTimestamp: pastTime,
      rawPayload: { text: 'Suv bosimi juda past' },
    });

    const evidenceId = `evi_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(acceptedEvidence).values({
      id: evidenceId,
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: testCalendarDay,
      intakeRecordId: intakeId,
      telegramChatId: '-10012345678',
      telegramMessageId: '505',
      originalTimestamp: pastTime,
      contentType: 'TEXT',
      verbatimText: 'Suv bosimi juda past',
    });

    // Insert an active operational issue
    const logicalKey = `DISTRICT:${testDistrictId}:topic_projection:TOPIC_PROCESSING_DELAY:${topicId}`;
    const issueId = `issue_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(operationalIssues).values({
      id: issueId,
      logicalKey,
      scope: 'DISTRICT',
      districtId: testDistrictId,
      component: 'topic_projection',
      issueCategory: 'TOPIC_PROCESSING_DELAY',
      severity: 'Warning',
      status: 'ACTIVE',
      healthStatus: 'Degraded',
      sanitizedTitle: 'Кечикиш',
      sanitizedDescription: 'Тавсиф',
      recommendedAction: 'Қайта уриниш',
      startedAt: pastTime,
      latestCheckAt: now,
      metadata: { topicId, issueId },
    });

    // Mock AI Evaluator
    const mockController = createMockAiGateway({
      summary: 'Сув босими пастлиги бўйича аҳоли мурожаати.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Suv bosimi juda past',
      latest_meaningful_activity_timestamp: now.toISOString(),
      attribution: 'Аҳоли хабарига кўра',
      is_hokim_related: false,
    });
    const topicProjectionEvaluator = new TopicProjectionEvaluator(mockController.gateway);

    // Process job
    const fakeJob: any = {
      data: {
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: testCalendarDay,
        generation: 1,
        issueId,
      },
    };

    await processTopicProjectionJobs([fakeJob], {
      db,
      pool,
      boss,
      topicProjectionEvaluator,
    });

    // Verify projection was written
    const [projection] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId));
    expect(projection).toBeDefined();
    expect(projection?.summary).toBe('Сув босими пастлиги бўйича аҳоли мурожаати.');

    // Verify operational issue was resolved
    const [resolvedIssue] = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.id, issueId));
    expect(resolvedIssue?.status).toBe('RESOLVED');
    expect(resolvedIssue?.resolvedAt).not.toBeNull();
  });
});
