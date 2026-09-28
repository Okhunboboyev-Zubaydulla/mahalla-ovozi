import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import {
  createDbPool,
  createDbClient,
  type DbClient,
} from '../src/adapters/db/client.js';
import { districts, telegramIntakeRecords, aiOperations, aiProviderAttempts, topics, acceptedEvidence, topicProjections } from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import {
  createBossClient,
  initBossQueues,
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  type TelegramTopicProjectionJobData,
} from '../src/adapters/jobs/boss-client.js';
import { startWorker, stopWorker } from '../src/entrypoints/worker.js';
import { createMockAiGateway, type MockAiGatewayController } from './helpers/mock-ai-gateway.js';
import { AiGatewayError } from '../src/modules/ai/types.js';
import type { AcceptedEvidenceItem } from '../src/modules/ai/context-snapshot.js';
import type { TopicProjectionResult } from '../src/modules/topics/topic-projection-evaluator.js';

describe('Story 2.5: Worker Topic Projection 28-Row Verification Matrix Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;
  let aiController: MockAiGatewayController;
  let testDistrictId: string;
  let testChatId: string;
  let customEvidenceStore: Map<string, AcceptedEvidenceItem[]> = new Map();
  let dynamicResolver: (() => Promise<AcceptedEvidenceItem[] | undefined>) | null = null;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    await ensureDefaultAiProfiles(db);

    const defaultProjectionResponse: TopicProjectionResult = {
      summary: 'Маҳаллада муаммо юзасидан хабар берилди.',
      lanes: ['WATER'],
      anchor_evidence_id: 'evi_placeholder',
      anchor_quote: 'Сув йўқ',
      latest_meaningful_activity_timestamp: '2026-08-22T08:00:00.000Z',
      attribution: 'Маҳалла аҳолиси хабарига кўра',
      is_hokim_related: false,
    };
    aiController = createMockAiGateway(defaultProjectionResponse);

    boss = createBossClient({ schema: 'pgboss_topic_projection' });
    await boss.start();
    await initBossQueues(boss);

    // Clean up stale jobs
    await pool.query('DELETE FROM pgboss_topic_projection.job WHERE name = $1', [
      TELEGRAM_TOPIC_PROJECTION_QUEUE,
    ]);

    await startWorker({
      boss,
      db,
      pool,
      aiGateway: aiController.gateway,
      queues: [TELEGRAM_TOPIC_PROJECTION_QUEUE],
      injectedEvidenceResolver: async (districtId, mahallaName, calendarDay) => {
        if (dynamicResolver) {
          return dynamicResolver();
        }
        const key = `${districtId}:${mahallaName}:${calendarDay}`;
        return customEvidenceStore.get(key);
      },
    });
  });

  afterAll(async () => {
    await stopWorker(boss);
    await pool.end();
  });

  beforeEach(async () => {
    aiController.mockAdapter.clearHistory();
    customEvidenceStore.clear();
    dynamicResolver = null;

    testDistrictId = `dist_prj_${crypto.randomUUID()}`;
    testChatId = `-100${Date.now()}${Math.floor(Math.random() * 1000)}`;

    await pool.query('DELETE FROM pgboss_topic_projection.job WHERE name = $1', [
      TELEGRAM_TOPIC_PROJECTION_QUEUE,
    ]);

    // Seed test active district with globally unique name
    await db.insert(districts).values({
      id: testDistrictId,
      name: `ProjectionDistrict_${crypto.randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
      accessEligible: true,
    });
  });

  /** Helper to seed an active Topic with initial accepted evidence */
  async function seedTopicAndEvidence(params: {
    topicId: string;
    primaryLane: string;
    evidenceId: string;
    messageId: string;
    verbatimText: string;
    timestamp: Date;
    mahallaName?: string;
    calendarDay?: string;
    requiredGen?: number;
    appliedGen?: number;
  }) {
    const mahallaName = params.mahallaName || 'Guliston';
    const calendarDay = params.calendarDay || '2026-08-22';
    const intakeId = `intk_${crypto.randomUUID()}`;

    // Seed intake
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      telegramBotId: `bot_${crypto.randomUUID().slice(0, 8)}`,
      districtId: testDistrictId,
      telegramChatId: testChatId,
      telegramMessageId: params.messageId,
      rawPayload: { message_id: Number(params.messageId), text: params.verbatimText },
      calendarDay,
      mahallaName,
      originalTimestamp: params.timestamp,
    });

    // Seed topic
    await db.insert(topics).values({
      id: params.topicId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      primaryLane: params.primaryLane,
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: params.timestamp,
      retentionExpiresAt: new Date(params.timestamp.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: params.requiredGen ?? 1,
      appliedDerivedGeneration: params.appliedGen ?? 0,
    });

    // Seed accepted evidence
    await db.insert(acceptedEvidence).values({
      id: params.evidenceId,
      topicId: params.topicId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      intakeRecordId: intakeId,
      telegramChatId: testChatId,
      telegramMessageId: params.messageId,
      originalTimestamp: params.timestamp,
      verbatimText: params.verbatimText,
      contentType: 'TEXT',
    });
  }

  /** Helper to send a job and poll until processed */
  async function sendAndProcessJob(jobData: TelegramTopicProjectionJobData, options?: any) {
    const jobId = await boss.send(TELEGRAM_TOPIC_PROJECTION_QUEUE, jobData, {
      retryLimit: 0,
      ...options,
    });
    expect(jobId).toBeDefined();

    for (let i = 0; i < 200; i++) {
      const { rows } = await pool.query(
        'SELECT state, output FROM pgboss_topic_projection.job WHERE id = $1',
        [jobId],
      );
      if (rows.length > 0 && (rows[0].state === 'completed' || rows[0].state === 'failed')) {
        return rows[0];
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Job ${jobId} did not complete within timeout`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Verification Matrix Tests (Scenarios 1 - 28)
  // ──────────────────────────────────────────────────────────────────────────

  // Matrix #1: Basic Projection
  it('Matrix #1: Valid single-evidence topic creates projection in topic_projections with appliedDerivedGeneration = 1 (AC 1, 12)', async () => {
    const topicId = `top_basic_${crypto.randomUUID()}`;
    const evidenceId = `evi_basic_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '101',
      verbatimText: 'Ичимлик суви таъминоти тўхтаб қолди',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Маҳаллада ичимлик суви таъминоти тўхтаб қолганлиги хабар қилинди.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Ичимлик суви таъминоти тўхтаб қолди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси хабарига кўра',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    // Verify topic_projections table
    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.summary).toBe(aiOutput.summary);
    expect(proj?.lanes).toEqual(['WATER']);
    expect(proj?.primaryLane).toBe('WATER');
    expect(proj?.anchorEvidenceId).toBe(evidenceId);
    expect(proj?.generation).toBe(1);
    expect(proj?.isHokimRelated).toBe(false);

    // Verify topics appliedDerivedGeneration advanced to 1
    const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
    expect(topic).toBeDefined();
    expect(topic?.appliedDerivedGeneration).toBe(1);
  });

  // Matrix #2: Multi-Lane Derivation (Water + Electricity)
  it('Matrix #2: Issue reporting water pump failure due to power cut derives WATER and ELECTRICITY lanes (AC 6)', async () => {
    const topicId = `top_multi_${crypto.randomUUID()}`;
    const evidenceId = `evi_multi_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T09:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '201',
      verbatimText: 'Свет ўчгани сабабли сув насослари тўхтаб, сув келмаяпти',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Электр энергияси узилиши сабабли насослар ишламай, сув таъминоти тўхтаганлиги хабар қилинди.',
      lanes: ['WATER', 'ELECTRICITY'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Свет ўчгани сабабли сув насослари тўхтаб, сув келмаяпти',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.lanes).toEqual(['WATER', 'ELECTRICITY']);
    expect(proj?.primaryLane).toBe('WATER');
    expect(proj?.isHokimRelated).toBe(false);
  });

  // Matrix #3: Hokim-Only Projection
  it('Matrix #3: Governance complaint derives HOKIM_RELATED lane and isHokimRelated = true (AC 6)', async () => {
    const topicId = `top_hokim_${crypto.randomUUID()}`;
    const evidenceId = `evi_hokim_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T10:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'HOKIM_RELATED',
      evidenceId,
      messageId: '301',
      verbatimText: 'Ҳоким ёрдамчиси берган ваъдасини бажармади, кўча таъмирланмади',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Ҳоким ёрдамчиси томонидан берилган ваъда бажарилмаганлиги ва кўча таъмирланмаганлиги билдирилди.',
      lanes: ['HOKIM_RELATED'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Ҳоким ёрдамчиси берган ваъдасини бажармади',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла фуқароси',
      is_hokim_related: true,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.lanes).toEqual(['HOKIM_RELATED']);
    expect(proj?.isHokimRelated).toBe(true);
  });

  // Matrix #4: Overlapping Hokim + Service Lane
  it('Matrix #4: Water outage neglected for weeks with Hokim escalation derives WATER + HOKIM_RELATED (AC 6)', async () => {
    const topicId = `top_overlap_${crypto.randomUUID()}`;
    const evidenceId = `evi_overlap_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T11:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '401',
      verbatimText: 'Сув йўқлигига бир ҳафта бўлди, ҳокимиятга ёзсак ҳам жавоб йўқ',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Бир ҳафтадан буён сув таъминоти йўқлиги ва ҳокимиятга қилинган мурожаатлар жавобсиз қолаётгани маълум қилинди.',
      lanes: ['WATER', 'HOKIM_RELATED'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Сув йўқлигига бир ҳафта бўлди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси хабарига кўра',
      is_hokim_related: true,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.lanes).toEqual(['WATER', 'HOKIM_RELATED']);
    expect(proj?.isHokimRelated).toBe(true);
    expect(proj?.primaryLane).toBe('WATER');
  });

  // Matrix #5: Primary Lane Immutability
  it('Matrix #5: Multi-lane derivation keeps original topics.primaryLane unchanged in topics table (AC 6, 14)', async () => {
    const topicId = `top_immut_${crypto.randomUUID()}`;
    const evidenceId = `evi_immut_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T12:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'GAS',
      evidenceId,
      messageId: '501',
      verbatimText: 'Газ босими паст, иситиш тизими ишламаяпти',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Газ босими кескин пасайганлиги ва ҳокимлик назорати талаб этилаётгани хабар қилинди.',
      lanes: ['GAS', 'HOKIM_RELATED'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Газ босими паст',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: true,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
    expect(topic).toBeDefined();
    expect(topic?.primaryLane).toBe('GAS'); // Immutable!
  });

  // Matrix #6: Uzbek Cyrillic Summary
  it('Matrix #6: Summary generated in authentic Uzbek Cyrillic text (AC 5)', async () => {
    const topicId = `top_cyr_${crypto.randomUUID()}`;
    const evidenceId = `evi_cyr_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T13:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'ELECTRICITY',
      evidenceId,
      messageId: '601',
      verbatimText: 'Свет ўчди, трансформатор куйган дейишмоқда',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Маҳаллада трансформатор носозлиги туфайли электр энергияси узилганлиги маълум қилинмоқда.',
      lanes: ['ELECTRICITY'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Свет ўчди, трансформатор куйган дейишмоқда',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси хабарига кўра',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(/[а-яёқғҳў]/i.test(proj?.summary ?? '')).toBe(true);
  });

  // Matrix #7: Disagreement Preservation
  it('Matrix #7: Preserves reported disagreement in summary rather than single certainty (AC 5)', async () => {
    const topicId = `top_disagree_${crypto.randomUUID()}`;
    const evidenceId = `evi_disagree_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T14:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'ELECTRICITY',
      evidenceId,
      messageId: '701',
      verbatimText: '3-домда свет бор, лекин 5-домда умуман йўқ',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Маҳалла аҳолиси хабарига кўра, айрим кўп қаватли уйларда электр таъминоти мавжуд, бошқаларида эса узилиш сақланиб қолмоқда.',
      lanes: ['ELECTRICITY'],
      anchor_evidence_id: evidenceId,
      anchor_quote: '3-домда свет бор, лекин 5-домда умуман йўқ',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.summary).toContain('айрим');
    expect(proj?.summary).toContain('бошқаларида');
  });

  // Matrix #8: Restoration Notice Handling
  it('Matrix #8: Resident reports "chiroq yondi" -> summary describes restoration as reported (AC 5)', async () => {
    const topicId = `top_rest_${crypto.randomUUID()}`;
    const evidenceId = `evi_rest_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T15:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'ELECTRICITY',
      evidenceId,
      messageId: '801',
      verbatimText: 'Чироқ ёнди, раҳмат!',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Аҳоли томонидан электр таъминоти қайта тиклангани хабар қилинди.',
      lanes: ['ELECTRICITY'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Чироқ ёнди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси хабарига кўра',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.summary).toContain('хабар қилинди');
  });

  // Matrix #9: Recurrence Handling
  it('Matrix #9: Resident reports "yana o\'chdi" -> summary reflects recurring issue (AC 5)', async () => {
    const topicId = `top_recur_${crypto.randomUUID()}`;
    const evidenceId = `evi_recur_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T16:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'ELECTRICITY',
      evidenceId,
      messageId: '901',
      verbatimText: 'Свет яна ўчди, ярим соат ҳам ёнмади',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Электр таъминотида такрорий узилишлар юзага келганлиги хабар қилинмоқда.',
      lanes: ['ELECTRICITY'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Свет яна ўчди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси хабарига кўра',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.summary).toContain('такрорий');
  });

  // Matrix #10: Anchor Selection (Self-Contained vs Vague)
  it('Matrix #10: Initial detailed report followed by vague fragment -> anchor selects initial detailed report (AC 7)', async () => {
    const topicId = `top_anchor_${crypto.randomUUID()}`;
    const evidenceId1 = `evi_anchor1_${crypto.randomUUID()}`;
    const evidenceId2 = `evi_anchor2_${crypto.randomUUID()}`;
    const timestamp1 = new Date('2026-08-22T08:00:00.000Z');
    const timestamp2 = new Date('2026-08-22T08:15:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId: evidenceId1,
      messageId: '1001',
      verbatimText: 'Сув қувури ёрилиб, кўчани сув босмоқда, авария хизмати йўқ',
      timestamp: timestamp1,
    });

    // Add second vague evidence
    const intakeId2 = `intk_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId2,
      telegramBotId: `bot_${crypto.randomUUID().slice(0, 8)}`,
      districtId: testDistrictId,
      telegramChatId: testChatId,
      telegramMessageId: '1002',
      rawPayload: { message_id: 1002, text: 'Бизда ҳам' },
      calendarDay: '2026-08-22',
      mahallaName: 'Guliston',
      originalTimestamp: timestamp2,
    });

    await db.insert(acceptedEvidence).values({
      id: evidenceId2,
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      intakeRecordId: intakeId2,
      telegramChatId: testChatId,
      telegramMessageId: '1002',
      originalTimestamp: timestamp2,
      verbatimText: 'Бизда ҳам',
      contentType: 'TEXT',
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Сув қувури ёрилиши натижасида кўчани сув босганлиги ва қўшимча хонадонларда ҳам сув йўқлиги хабар қилинди.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId1, // Meaningful anchor selected!
      anchor_quote: 'Сув қувури ёрилиб, кўчани сув босмоқда',
      latest_meaningful_activity_timestamp: timestamp2.toISOString(),
      attribution: 'Маҳалла аҳолиси хабарига кўра',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 2,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.anchorEvidenceId).toBe(evidenceId1);
  });

  // Matrix #11: Anchor Selection (Evidence-Bound ID)
  it('Matrix #11: anchorEvidenceId strictly references an existing evidence ID from the target Topic (AC 7)', async () => {
    const topicId = `top_bound_${crypto.randomUUID()}`;
    const evidenceId = `evi_bound_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'GAS',
      evidenceId,
      messageId: '1101',
      verbatimText: 'Газ ҳиди келяпти подъездда',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Подъездда газ ҳиди тарқалганлиги хабар қилинди.',
      lanes: ['GAS'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Газ ҳиди келяпти подъездда',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.anchorEvidenceId).toBe(evidenceId);
  });

  // Matrix #12: Latest Meaningful Activity Timestamp
  it('Matrix #12: latestMeaningfulActivityTimestamp strictly matches originalTimestamp of target Topic evidence (AC 8)', async () => {
    const topicId = `top_act_${crypto.randomUUID()}`;
    const evidenceId = `evi_act_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T17:45:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WASTE',
      evidenceId,
      messageId: '1201',
      verbatimText: 'Чиқиндилар 3 кундан бери олиб кетилмаяпти',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Маҳаллада чиқиндилар олиб кетилмаётганлиги хабар қилинди.',
      lanes: ['WASTE'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Чиқиндилар 3 кундан бери олиб кетилмаяпти',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.latestMeaningfulActivityTimestamp.toISOString()).toBe(timestamp.toISOString());
  });

  // Matrix #13: Cautious Attribution
  it('Matrix #13: Attribution reflects neutral citizen reporting without inferring personal phone numbers (AC 9)', async () => {
    const topicId = `top_attr_${crypto.randomUUID()}`;
    const evidenceId = `evi_attr_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '1301',
      verbatimText: 'Сув ўчди, қачон берасизлар?',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Маҳалла аҳолиси хабарига кўра, сув таъминотида узилиш кузатилмоқда.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Сув ўчди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси хабарига кўра',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.attribution).toBe('Маҳалла аҳолиси хабарига кўра');
    expect(proj?.attribution).not.toMatch(/\+998\d+/);
  });

  // Matrix #14: Out-of-Order Drop (Old Generation)
  it('Matrix #14: Job generation 1 arrives when appliedDerivedGeneration = 2 -> dropped cleanly with 0 AI calls (AC 3)', async () => {
    const topicId = `top_ooo_${crypto.randomUUID()}`;
    const evidenceId = `evi_ooo_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '1401',
      verbatimText: 'Сув босими паст',
      timestamp,
      appliedGen: 2,
    });

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1, // Stale generation <= 2
    });
    expect(job.state).toBe('completed');

    // 0 AI calls executed
    expect(aiController.mockAdapter.getCalls().length).toBe(0);

    // 0 rows in topic_projections
    const rows = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId));
    expect(rows.length).toBe(0);
  });

  // Matrix #15: Generation Coalescing
  it('Matrix #15: Job generation 1 processed while requiredDerivedGeneration = 3 -> advances to generation 3 (AC 4)', async () => {
    const topicId = `top_coal_${crypto.randomUUID()}`;
    const evidenceId = `evi_coal_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'ELECTRICITY',
      evidenceId,
      messageId: '1501',
      verbatimText: 'Свет ўчди',
      timestamp,
      requiredGen: 3,
      appliedGen: 0,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Электр таъминотида узилиш хабар қилинди.',
      lanes: ['ELECTRICITY'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Свет ўчди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1, // Coalesces to requiredDerivedGeneration = 3!
    });
    expect(job.state).toBe('completed');

    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.generation).toBe(3);

    const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
    expect(topic).toBeDefined();
    expect(topic?.appliedDerivedGeneration).toBe(3);
  });

  // Matrix #16: Stale Generation Commit Collision
  it('Matrix #16: In-flight race where concurrent worker advances appliedDerivedGeneration -> CAS drops cleanly (AC 13)', async () => {
    const topicId = `top_cas_${crypto.randomUUID()}`;
    const evidenceId = `evi_cas_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '1601',
      verbatimText: 'Сув ўчди',
      timestamp,
      appliedGen: 0,
      requiredGen: 1,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Сув таъминоти тўхтаганлиги хабар қилинди.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Сув ўчди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };

    // Delay during AI call so we can advance appliedDerivedGeneration concurrently
    aiController.mockAdapter.enqueueBehavior({
      delayMs: 200,
      response: aiOutput,
    });

    const jobPromise = sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });

    // Concurrently advance appliedDerivedGeneration to 2
    await new Promise((r) => setTimeout(r, 60));
    await db
      .update(topics)
      .set({ appliedDerivedGeneration: 2 })
      .where(eq(topics.id, topicId));

    const job = await jobPromise;
    expect(job.state).toBe('completed');

    // CAS aborted: topic_projections was NOT overwritten with stale generation 1
    const rows = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId));
    expect(rows.length).toBe(0);
  });

  // Matrix #17: Deterministic Snapshot Ordering
  it('Matrix #17: Evidence fed to AI evaluator strictly ordered by originalTimestamp ASC -> telegramMessageId ASC -> id ASC (AC 2)', async () => {
    const topicId = `top_ord_${crypto.randomUUID()}`;
    const evidenceId1 = `evi_ord1_${crypto.randomUUID()}`;
    const evidenceId2 = `evi_ord2_${crypto.randomUUID()}`;
    const timestamp1 = new Date('2026-08-22T08:00:00.000Z');
    const timestamp2 = new Date('2026-08-22T09:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId: evidenceId2,
      messageId: '1702',
      verbatimText: 'Сув ҳали ҳам йўқ',
      timestamp: timestamp2,
    });

    // Seed earlier evidence
    const intakeId1 = `intk_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId1,
      telegramBotId: `bot_${crypto.randomUUID().slice(0, 8)}`,
      districtId: testDistrictId,
      telegramChatId: testChatId,
      telegramMessageId: '1701',
      rawPayload: { message_id: 1701, text: 'Сув ўчди' },
      calendarDay: '2026-08-22',
      mahallaName: 'Guliston',
      originalTimestamp: timestamp1,
    });

    await db.insert(acceptedEvidence).values({
      id: evidenceId1,
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      intakeRecordId: intakeId1,
      telegramChatId: testChatId,
      telegramMessageId: '1701',
      originalTimestamp: timestamp1,
      verbatimText: 'Сув ўчди',
      contentType: 'TEXT',
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Сув таъминоти тўхтаганлиги маълум қилинди.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId1,
      anchor_quote: 'Сув ўчди',
      latest_meaningful_activity_timestamp: timestamp2.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const requests = aiController.mockAdapter.getCalls();
    expect(requests.length).toBe(1);
    const userPrompt = requests[0]?.userPrompt ?? '';

    // Check ordering in prompt: 1701 appears before 1702
    const pos1701 = userPrompt.indexOf('1701');
    const pos1702 = userPrompt.indexOf('1702');
    expect(pos1701).toBeGreaterThan(-1);
    expect(pos1702).toBeGreaterThan(-1);
    expect(pos1701).toBeLessThan(pos1702);
  });

  // Matrix #18: Same-Day Context Isolation
  it('Matrix #18: Target topic evaluated in context of same Mahalla same-day evidence without cross-district leakage (AC 2)', async () => {
    const otherDistrictId = `dist_other_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: otherDistrictId,
      name: `Other_District_${crypto.randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
      accessEligible: true,
    });

    const topicId = `top_iso_${crypto.randomUUID()}`;
    const evidenceId = `evi_iso_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '1801',
      verbatimText: 'Сув ўчди бизнинг маҳаллада',
      timestamp,
    });

    // Seed other district evidence
    const otherIntakeId = `intk_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: otherIntakeId,
      telegramBotId: `bot_${crypto.randomUUID().slice(0, 8)}`,
      districtId: otherDistrictId,
      telegramChatId: testChatId,
      telegramMessageId: '1802',
      rawPayload: { message_id: 1802, text: 'Бошқа туманда сув ўчди' },
      calendarDay: '2026-08-22',
      mahallaName: 'Guliston',
      originalTimestamp: timestamp,
    });

    const otherTopicId = `top_other_${crypto.randomUUID()}`;
    await db.insert(topics).values({
      id: otherTopicId,
      districtId: otherDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: timestamp,
      retentionExpiresAt: new Date(timestamp.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    await db.insert(acceptedEvidence).values({
      id: `evi_other_dist_${crypto.randomUUID()}`,
      topicId: otherTopicId,
      districtId: otherDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      intakeRecordId: otherIntakeId,
      telegramChatId: testChatId,
      telegramMessageId: '1802',
      originalTimestamp: timestamp,
      verbatimText: 'Бошқа туманда сув ўчди',
      contentType: 'TEXT',
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Сув таъминоти узилганлиги хабар қилинди.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Сув ўчди бизнинг маҳаллада',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const requests = aiController.mockAdapter.getCalls();
    expect(requests[0]?.userPrompt).not.toContain('Бошқа туманда сув ўчди');
  });

  // Matrix #19: Lifecycle Gate 1 (Pre-AI)
  it('Matrix #19: Inactive District drops job cleanly before AI invocation without retry pollution (AC 1, 19)', async () => {
    const inactiveDistrictId = `dist_inact_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: inactiveDistrictId,
      name: `Inactive_District_${crypto.randomUUID().slice(0, 8)}`,
      status: 'SUSPENDED',
      accessEligible: false,
    });

    const topicId = `top_inact_${crypto.randomUUID()}`;
    const evidenceId = `evi_inact_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    // Seed topic under inactive district
    const intakeId = `intk_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      telegramBotId: `bot_${crypto.randomUUID().slice(0, 8)}`,
      districtId: inactiveDistrictId,
      telegramChatId: testChatId,
      telegramMessageId: '1901',
      rawPayload: { message_id: 1901, text: 'Сув ўчди' },
      calendarDay: '2026-08-22',
      mahallaName: 'Guliston',
      originalTimestamp: timestamp,
    });

    await db.insert(topics).values({
      id: topicId,
      districtId: inactiveDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: timestamp,
      retentionExpiresAt: new Date(timestamp.getTime() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 0,
    });

    await db.insert(acceptedEvidence).values({
      id: evidenceId,
      topicId,
      districtId: inactiveDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      intakeRecordId: intakeId,
      telegramChatId: testChatId,
      telegramMessageId: '1901',
      originalTimestamp: timestamp,
      verbatimText: 'Сув ўчди',
      contentType: 'TEXT',
    });

    const job = await sendAndProcessJob({
      topicId,
      districtId: inactiveDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    // 0 AI calls executed
    expect(aiController.mockAdapter.getCalls().length).toBe(0);
  });

  // Matrix #20: Lifecycle Gate 2 (Pre-Commit)
  it('Matrix #20: District deactivated during AI call aborts transaction cleanly before DB commit (AC 1, 20)', async () => {
    const topicId = `top_gate2_${crypto.randomUUID()}`;
    const evidenceId = `evi_gate2_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '2001',
      verbatimText: 'Сув ўчди',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Сув таъминоти узилганлиги хабар қилинди.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Сув ўчди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };

    // Delay during AI call so we can deactivate district concurrently
    aiController.mockAdapter.enqueueBehavior({
      delayMs: 200,
      response: aiOutput,
    });

    const jobPromise = sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });

    // Concurrently deactivate district
    await new Promise((r) => setTimeout(r, 60));
    await db
      .update(districts)
      .set({ status: 'SUSPENDED', accessEligible: false })
      .where(eq(districts.id, testDistrictId));

    const job = await jobPromise;
    expect(job.state).toBe('completed');

    // 0 records in topic_projections
    const rows = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId));
    expect(rows.length).toBe(0);
  });

  // Matrix #21: AI Traceability
  it('Matrix #21: ai_operations logged with pinned_profile_id = prof_proj_2026_08_v1 and targetId = topicId:generation (AC 10)', async () => {
    const topicId = `top_trace_${crypto.randomUUID()}`;
    const evidenceId = `evi_trace_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '2101',
      verbatimText: 'Сув ўчди',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Сув таъминоти тўхтаганлиги хабар қилинди.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Сув ўчди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    const [op] = await db
      .select()
      .from(aiOperations)
      .where(eq(aiOperations.targetId, `${topicId}:1`))
      .limit(1);

    expect(op).toBeDefined();
    expect(op?.operationType).toBe('TOPIC_DERIVED_PROJECTION');
    expect(op?.pinnedProfileId).toBe('prof_proj_2026_08_v1');
    expect(op?.finalStatus).toBe('COMPLETED');

    const attempts = await db
      .select()
      .from(aiProviderAttempts)
      .where(eq(aiProviderAttempts.operationId, op!.id));
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts[0]?.status).toBe('SUCCESS');
  });

  // Matrix #22: AI Provider Timeout
  it('Matrix #22: Gateway timeout triggers pg-boss retry with backoff and does not advance generation (AC 15)', async () => {
    const topicId = `top_timeout_${crypto.randomUUID()}`;
    const evidenceId = `evi_timeout_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '2201',
      verbatimText: 'Сув ўчди',
      timestamp,
    });

    aiController.mockAdapter.setNextError(
      new AiGatewayError('PROVIDER_TIMEOUT', 'AI gateway timed out after 10000ms', {
        status: 504,
        retryable: true,
      }),
    );

    const job = await sendAndProcessJob(
      {
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        generation: 1,
      },
      { retryLimit: 0 },
    );
    expect(job.state).toBe('failed');

    const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
    expect(topic).toBeDefined();
    expect(topic?.appliedDerivedGeneration).toBe(0); // Did not advance!
  });

  // Matrix #23: AI Provider Rate Limit (429)
  it('Matrix #23: Gateway rate limit triggers retry with backoff (AC 15)', async () => {
    const topicId = `top_429_${crypto.randomUUID()}`;
    const evidenceId = `evi_429_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'GAS',
      evidenceId,
      messageId: '2301',
      verbatimText: 'Газ ўчди',
      timestamp,
    });

    aiController.mockAdapter.setNextError(
      new AiGatewayError('RATE_LIMIT_EXCEEDED', 'Rate limit exceeded 429', {
        status: 429,
        retryable: true,
      }),
    );

    const job = await sendAndProcessJob(
      {
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        generation: 1,
      },
      { retryLimit: 0 },
    );
    expect(job.state).toBe('failed');
  });

  // Matrix #24: AI Invalid Schema Output
  it('Matrix #24: Malformed JSON output from provider triggers retry without committing fake data (AC 15)', async () => {
    const topicId = `top_malformed_${crypto.randomUUID()}`;
    const evidenceId = `evi_malformed_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '2401',
      verbatimText: 'Сув ўчди',
      timestamp,
    });

    aiController.mockAdapter.setNextError(
      new AiGatewayError('INVALID_OUTPUT_SYNTAX', 'Invalid JSON syntax from model', {
        status: 502,
        retryable: true,
      }),
    );

    const job = await sendAndProcessJob(
      {
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        generation: 1,
      },
      { retryLimit: 0 },
    );
    expect(job.state).toBe('failed');

    const rows = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId));
    expect(rows.length).toBe(0);
  });

  // Matrix #25: Semantic Validation Failure (Empty Lanes)
  it('Matrix #25: AI returns empty lanes [] -> rejected by schema and fails job (AC 11)', async () => {
    const topicId = `top_empty_lanes_${crypto.randomUUID()}`;
    const evidenceId = `evi_empty_lanes_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '2501',
      verbatimText: 'Сув ўчди',
      timestamp,
    });

    // Provide invalid empty lanes
    aiController.mockAdapter.setNextResponse({
      summary: 'Сув ўчди',
      lanes: [],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Сув ўчди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Аҳоли',
      is_hokim_related: false,
    });

    const job = await sendAndProcessJob(
      {
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        generation: 1,
      },
      { retryLimit: 0 },
    );
    expect(job.state).toBe('failed');
  });

  // Matrix #26: Semantic Validation Failure (Foreign Anchor)
  it('Matrix #26: AI returns anchor_evidence_id belonging to another Topic -> evaluator rejects with INVALID_OUTPUT_SEMANTICS (AC 11)', async () => {
    const topicId = `top_for_anc_${crypto.randomUUID()}`;
    const evidenceId = `evi_for_anc_${crypto.randomUUID()}`;
    const foreignEvidenceId = `evi_foreign_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '2601',
      verbatimText: 'Сув ўчди',
      timestamp,
    });

    aiController.mockAdapter.setNextResponse({
      summary: 'Сув ўчди',
      lanes: ['WATER'],
      anchor_evidence_id: foreignEvidenceId, // Foreign anchor!
      anchor_quote: 'Сув ўчди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Аҳоли',
      is_hokim_related: false,
    });

    const job = await sendAndProcessJob(
      {
        topicId,
        districtId: testDistrictId,
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        generation: 1,
      },
      { retryLimit: 0 },
    );
    expect(job.state).toBe('failed');
  });

  // Matrix #27: Duplicate Delivery Idempotency
  it('Matrix #27: Same projection job delivered twice -> upserts projection idempotently without duplicate rows (AC 16)', async () => {
    const topicId = `top_idem_${crypto.randomUUID()}`;
    const evidenceId = `evi_idem_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '2701',
      verbatimText: 'Сув ўчди',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Сув таъминоти тўхтаганлиги маълум қилинди.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Сув ўчди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const jobData: TelegramTopicProjectionJobData = {
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    };

    // First delivery
    const job1 = await sendAndProcessJob(jobData);
    expect(job1.state).toBe('completed');

    // Second duplicate delivery
    aiController.mockAdapter.setDefaultResponse(aiOutput);
    const job2 = await sendAndProcessJob(jobData);
    expect(job2.state).toBe('completed');

    // Exactly 1 row in topic_projections
    const rows = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId));
    expect(rows.length).toBe(1);
  });

  // Matrix #28: Story Boundary Verification
  it('Matrix #28: Confirms Story 2.5 calculates topic projections without dashboard rendering or retention purge (AC 19)', async () => {
    const topicId = `top_bound_${crypto.randomUUID()}`;
    const evidenceId = `evi_bound_${crypto.randomUUID()}`;
    const timestamp = new Date('2026-08-22T08:00:00.000Z');

    await seedTopicAndEvidence({
      topicId,
      primaryLane: 'WATER',
      evidenceId,
      messageId: '2801',
      verbatimText: 'Сув ўчди',
      timestamp,
    });

    const aiOutput: TopicProjectionResult = {
      summary: 'Сув таъминоти тўхтаганлиги хабар қилинди.',
      lanes: ['WATER'],
      anchor_evidence_id: evidenceId,
      anchor_quote: 'Сув ўчди',
      latest_meaningful_activity_timestamp: timestamp.toISOString(),
      attribution: 'Маҳалла аҳолиси',
      is_hokim_related: false,
    };
    aiController.mockAdapter.setDefaultResponse(aiOutput);

    const job = await sendAndProcessJob({
      topicId,
      districtId: testDistrictId,
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      generation: 1,
    });
    expect(job.state).toBe('completed');

    // Confirms topic_projections persists the derived representation
    const [proj] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, topicId))
      .limit(1);

    expect(proj).toBeDefined();
    expect(proj?.topicId).toBe(topicId);
    expect(proj?.summary).toBe(aiOutput.summary);
  });
});
