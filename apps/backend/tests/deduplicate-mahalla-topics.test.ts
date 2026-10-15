import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type pg from 'pg';
import { eq, inArray } from 'drizzle-orm';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import {
  districts,
  districtTelegramGroups,
  topics,
  telegramIntakeRecords,
  acceptedEvidence,
  topicProjections,
} from '../src/adapters/db/schema/index.js';
import {
  parseCliArgs,
  selectPrimaryTopic,
  deduplicateMahallaTopics,
  type TopicRecord,
} from '../src/cli/deduplicate-mahalla-topics.js';

describe('Mahalla Topics & Telegram Groups Deduplication CLI', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let testDistrictId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    await ensureDefaultAiProfiles(db);
  });

  afterAll(async () => {
    if (testDistrictId) {
      await db.delete(districts).where(eq(districts.id, testDistrictId));
    }
    await pool.end();
  });

  beforeEach(async () => {
    // Create an isolated fresh district for each test
    testDistrictId = `dist_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: testDistrictId,
      name: `Test District ${crypto.randomUUID().slice(0, 6)}`,
      status: 'SETUP_INCOMPLETE',
    });
  });

  describe('CLI Argument Parsing', () => {
    it('defaults to dry-run when neither --execute nor --dry-run is supplied', () => {
      const parsed = parseCliArgs([]);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.execute).toBe(false);
      expect(parsed.districtId).toBeUndefined();
    });

    it('enables dry-run explicitly with --dry-run', () => {
      const parsed = parseCliArgs(['--dry-run']);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.execute).toBe(false);
    });

    it('enables execution with --execute', () => {
      const parsed = parseCliArgs(['--execute']);
      expect(parsed.dryRun).toBe(false);
      expect(parsed.execute).toBe(true);
    });

    it('parses --districtId=<id> and --district=<id>', () => {
      const parsed1 = parseCliArgs(['--districtId=dist_123', '--execute']);
      expect(parsed1.districtId).toBe('dist_123');
      expect(parsed1.execute).toBe(true);

      const parsed2 = parseCliArgs(['--district=dist_456', '--dry-run']);
      expect(parsed2.districtId).toBe('dist_456');
      expect(parsed2.dryRun).toBe(true);
    });

    it('parses space-separated --districtId <id> and --district <id>', () => {
      const parsed1 = parseCliArgs(['--districtId', 'dist_abc']);
      expect(parsed1.districtId).toBe('dist_abc');

      const parsed2 = parseCliArgs(['--district', 'dist_xyz', '--execute']);
      expect(parsed2.districtId).toBe('dist_xyz');
      expect(parsed2.execute).toBe(true);
    });
  });

  describe('Primary Topic Selection Logic', () => {
    it('prefers the topic whose name is already canonical', () => {
      const cluster: TopicRecord[] = [
        {
          id: 'top_non_canonical',
          districtId: 'dist_1',
          mahallaName: 'Раваллик ва Яккақайроғоч МФЙ',
          calendarDay: '2026-10-15',
          primaryLane: 'ELECTRICITY',
          status: 'ACTIVE',
          requiredDerivedGeneration: 1,
          appliedDerivedGeneration: 1,
          latestRelevantEvidenceTimestamp: new Date('2026-10-15T10:00:00Z'),
          retentionExpiresAt: new Date('2026-11-15T10:00:00Z'),
          createdAt: new Date('2026-10-15T09:00:00Z'), // Created earlier
          updatedAt: new Date('2026-10-15T09:00:00Z'),
        },
        {
          id: 'top_canonical',
          districtId: 'dist_1',
          mahallaName: 'Раваллик ва Яккақайроғоч',
          calendarDay: '2026-10-15',
          primaryLane: 'ELECTRICITY',
          status: 'ACTIVE',
          requiredDerivedGeneration: 1,
          appliedDerivedGeneration: 1,
          latestRelevantEvidenceTimestamp: new Date('2026-10-15T10:30:00Z'),
          retentionExpiresAt: new Date('2026-11-15T10:30:00Z'),
          createdAt: new Date('2026-10-15T09:30:00Z'), // Created later
          updatedAt: new Date('2026-10-15T09:30:00Z'),
        },
      ];

      const primary = selectPrimaryTopic(cluster);
      expect(primary.id).toBe('top_canonical');
      expect(primary.mahallaName).toBe('Раваллик ва Яккақайроғоч');
    });

    it('falls back to earliest createdAt if neither or both are canonical', () => {
      const cluster: TopicRecord[] = [
        {
          id: 'top_older',
          districtId: 'dist_1',
          mahallaName: 'Раваллик ва Яккақайроғоч МФЙ',
          calendarDay: '2026-10-15',
          primaryLane: 'ELECTRICITY',
          status: 'ACTIVE',
          requiredDerivedGeneration: 1,
          appliedDerivedGeneration: 1,
          latestRelevantEvidenceTimestamp: new Date('2026-10-15T10:00:00Z'),
          retentionExpiresAt: new Date('2026-11-15T10:00:00Z'),
          createdAt: new Date('2026-10-15T08:00:00Z'),
          updatedAt: new Date('2026-10-15T08:00:00Z'),
        },
        {
          id: 'top_newer',
          districtId: 'dist_1',
          mahallaName: 'Раваллик ва Яккақайроғоч маҳалласи',
          calendarDay: '2026-10-15',
          primaryLane: 'ELECTRICITY',
          status: 'ACTIVE',
          requiredDerivedGeneration: 1,
          appliedDerivedGeneration: 1,
          latestRelevantEvidenceTimestamp: new Date('2026-10-15T10:30:00Z'),
          retentionExpiresAt: new Date('2026-11-15T10:30:00Z'),
          createdAt: new Date('2026-10-15T09:00:00Z'),
          updatedAt: new Date('2026-10-15T09:00:00Z'),
        },
      ];

      const primary = selectPrimaryTopic(cluster);
      expect(primary.id).toBe('top_older');
    });
  });

  describe('Database Deduplication & Normalization Execution', () => {
    it('previews changes accurately without mutating database in dry-run mode', async () => {
      const calendarDay = '2026-10-15';
      const now = new Date();

      // 1. Group with non-canonical name
      const groupId = `dtg_${crypto.randomUUID()}`;
      await db.insert(districtTelegramGroups).values({
        id: groupId,
        districtId: testDistrictId,
        mahallaName: 'Раваллик ва Яккақайроғоч МФЙ',
        telegramChatId: `-100${Math.floor(100000000 + Math.random() * 900000000)}`,
        telegramChatTitle: 'Ravallik Chat',
        status: 'VALID',
        transport: 'USERBOT',
      });

      // 2. Duplicate topics in same lane and day
      const primaryTopicId = `top_primary_${crypto.randomUUID()}`;
      const duplicateTopicId = `top_duplicate_${crypto.randomUUID()}`;

      await db.insert(topics).values([
        {
          id: primaryTopicId,
          districtId: testDistrictId,
          mahallaName: 'Раваллик ва Яккақайроғоч', // Canonical
          calendarDay,
          primaryLane: 'ELECTRICITY',
          status: 'ACTIVE',
          requiredDerivedGeneration: 1,
          appliedDerivedGeneration: 1,
          latestRelevantEvidenceTimestamp: now,
          retentionExpiresAt: new Date(now.getTime() + 30 * 86400 * 1000),
          createdAt: new Date(now.getTime() - 3600 * 1000),
        },
        {
          id: duplicateTopicId,
          districtId: testDistrictId,
          mahallaName: 'Раваллик ва Яккақайроғоч МФЙ', // Duplicate non-canonical
          calendarDay,
          primaryLane: 'ELECTRICITY',
          status: 'ACTIVE',
          requiredDerivedGeneration: 1,
          appliedDerivedGeneration: 1,
          latestRelevantEvidenceTimestamp: now,
          retentionExpiresAt: new Date(now.getTime() + 30 * 86400 * 1000),
          createdAt: now,
        },
      ]);

      // 3. Intake record and accepted evidence
      const intakeId = `int_${crypto.randomUUID()}`;
      await db.insert(telegramIntakeRecords).values({
        id: intakeId,
        districtId: testDistrictId,
        mahallaName: 'Раваллик ва Яккақайроғоч',
        source: 'USERBOT',
        telegramChatId: '-100999999',
        telegramMessageId: '101',
        originalTimestamp: now,
        calendarDay,
        rawPayload: { text: 'Test' },
        status: 'ACCEPTED',
      });

      const evi1Id = `evi_${crypto.randomUUID()}`;
      const evi2Id = `evi_${crypto.randomUUID()}`;
      await db.insert(acceptedEvidence).values([
        {
          id: evi1Id,
          topicId: primaryTopicId,
          districtId: testDistrictId,
          mahallaName: 'Раваллик ва Яккақайроғоч',
          calendarDay,
          intakeRecordId: intakeId,
          telegramChatId: '-100999999',
          telegramMessageId: '101',
          originalTimestamp: now,
          verbatimText: 'Чироқ ўчди 1',
          contentType: 'TEXT',
        },
        {
          id: evi2Id,
          topicId: duplicateTopicId,
          districtId: testDistrictId,
          mahallaName: 'Раваллик ва Яккақайроғоч МФЙ',
          calendarDay,
          intakeRecordId: intakeId,
          telegramChatId: '-100999999',
          telegramMessageId: '102',
          originalTimestamp: now,
          verbatimText: 'Чироқ ўчди 2',
          contentType: 'TEXT',
        },
      ]);

      // Run dry-run
      const summary = await deduplicateMahallaTopics(pool, {
        dryRun: true,
        execute: false,
        districtId: testDistrictId,
      });

      expect(summary.dryRun).toBe(true);
      expect(summary.groupsNormalized).toBe(1);
      expect(summary.clustersWithDuplicates).toBe(1);
      expect(summary.duplicateTopicsRemoved).toBe(1);
      expect(summary.evidenceRecordsMoved).toBe(1);

      // Verify DB was NOT mutated
      const groupCheck = await db.select().from(districtTelegramGroups).where(eq(districtTelegramGroups.id, groupId));
      expect(groupCheck[0]!.mahallaName).toBe('Раваллик ва Яккақайроғоч МФЙ');

      const dupTopicCheck = await db.select().from(topics).where(eq(topics.id, duplicateTopicId));
      expect(dupTopicCheck.length).toBe(1);

      const evi2Check = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.id, evi2Id));
      expect(evi2Check[0]!.topicId).toBe(duplicateTopicId);
    });

    it('merges duplicate topics and normalizes groups inside transactions in execute mode', async () => {
      const calendarDay = '2026-10-15';
      const now = new Date();

      // 1. Group with uncanonical name
      const groupId = `dtg_${crypto.randomUUID()}`;
      await db.insert(districtTelegramGroups).values({
        id: groupId,
        districtId: testDistrictId,
        mahallaName: 'Раваллик ва Яккақайроғоч МФЙ',
        telegramChatId: `-100${Math.floor(100000000 + Math.random() * 900000000)}`,
        telegramChatTitle: 'Ravallik Chat',
        status: 'VALID',
        transport: 'USERBOT',
      });

      // 2. Duplicate topics
      const primaryTopicId = `top_primary_${crypto.randomUUID()}`;
      const duplicateTopicId = `top_duplicate_${crypto.randomUUID()}`;

      await db.insert(topics).values([
        {
          id: primaryTopicId,
          districtId: testDistrictId,
          mahallaName: 'Раваллик ва Яккақайроғоч',
          calendarDay,
          primaryLane: 'ELECTRICITY',
          status: 'ACTIVE',
          requiredDerivedGeneration: 1,
          appliedDerivedGeneration: 1,
          latestRelevantEvidenceTimestamp: now,
          retentionExpiresAt: new Date(now.getTime() + 30 * 86400 * 1000),
          createdAt: new Date(now.getTime() - 3600 * 1000),
        },
        {
          id: duplicateTopicId,
          districtId: testDistrictId,
          mahallaName: 'Раваллик ва Яккақайроғоч МФЙ',
          calendarDay,
          primaryLane: 'ELECTRICITY',
          status: 'ACTIVE',
          requiredDerivedGeneration: 1,
          appliedDerivedGeneration: 1,
          latestRelevantEvidenceTimestamp: new Date(now.getTime() + 1000),
          retentionExpiresAt: new Date(now.getTime() + 35 * 86400 * 1000),
          createdAt: now,
        },
      ]);

      // 3. Intake record and evidence
      const intakeId = `int_${crypto.randomUUID()}`;
      await db.insert(telegramIntakeRecords).values({
        id: intakeId,
        districtId: testDistrictId,
        mahallaName: 'Раваллик ва Яккақайроғоч',
        source: 'USERBOT',
        telegramChatId: '-100888888',
        telegramMessageId: '201',
        originalTimestamp: now,
        calendarDay,
        rawPayload: { text: 'Test' },
        status: 'ACCEPTED',
      });

      const evi1Id = `evi_${crypto.randomUUID()}`;
      const evi2Id = `evi_${crypto.randomUUID()}`;
      const evi3Id = `evi_${crypto.randomUUID()}`;

      await db.insert(acceptedEvidence).values([
        {
          id: evi1Id,
          topicId: primaryTopicId,
          districtId: testDistrictId,
          mahallaName: 'Раваллик ва Яккақайроғоч',
          calendarDay,
          intakeRecordId: intakeId,
          telegramChatId: '-100888888',
          telegramMessageId: '201',
          originalTimestamp: now,
          verbatimText: 'Чироқ ўчди 1',
          contentType: 'TEXT',
        },
        {
          id: evi2Id,
          topicId: duplicateTopicId,
          districtId: testDistrictId,
          mahallaName: 'Раваллик ва Яккақайроғоч МФЙ',
          calendarDay,
          intakeRecordId: intakeId,
          telegramChatId: '-100888888',
          telegramMessageId: '202',
          originalTimestamp: new Date(now.getTime() + 500),
          verbatimText: 'Чироқ ўчди 2',
          contentType: 'TEXT',
        },
        {
          id: evi3Id,
          topicId: duplicateTopicId,
          districtId: testDistrictId,
          mahallaName: 'Раваллик ва Яккақайроғоч МФЙ',
          calendarDay,
          intakeRecordId: intakeId,
          telegramChatId: '-100888888',
          telegramMessageId: '203',
          originalTimestamp: new Date(now.getTime() + 1000),
          verbatimText: 'Чироқ ўчди 3',
          contentType: 'TEXT',
        },
      ]);

      // 4. Topic projections for duplicate and primary
      const projDupId = `prj_${crypto.randomUUID()}`;
      await db.insert(topicProjections).values({
        id: projDupId,
        topicId: duplicateTopicId,
        districtId: testDistrictId,
        mahallaName: 'Раваллик ва Яккақайроғоч МФЙ',
        calendarDay,
        summary: 'Duplicate summary',
        lanes: ['ELECTRICITY'],
        primaryLane: 'ELECTRICITY',
        anchorEvidenceId: evi2Id,
        anchorQuote: 'Чироқ ўчди 2',
        latestMeaningfulActivityTimestamp: now,
        attribution: 'Aholi',
        generation: 1,
        aiProfileId: 'prof_proj_2026_08_v1',
      });

      // Run execute
      const summary = await deduplicateMahallaTopics(pool, {
        dryRun: false,
        execute: true,
        districtId: testDistrictId,
      });

      expect(summary.dryRun).toBe(false);
      expect(summary.groupsNormalized).toBe(1);
      expect(summary.clustersWithDuplicates).toBe(1);
      expect(summary.duplicateTopicsRemoved).toBe(1);
      expect(summary.evidenceRecordsMoved).toBe(2);
      expect(summary.projectionsDeleted).toBe(1);

      // Verify DB mutations:
      // 1. Group was renamed to canonical
      const groupAfter = await db.select().from(districtTelegramGroups).where(eq(districtTelegramGroups.id, groupId));
      expect(groupAfter[0]!.mahallaName).toBe('Раваллик ва Яккақайроғоч');

      // 2. Duplicate topic was deleted
      const dupAfter = await db.select().from(topics).where(eq(topics.id, duplicateTopicId));
      expect(dupAfter.length).toBe(0);

      // 3. Duplicate projection was deleted
      const projAfter = await db.select().from(topicProjections).where(eq(topicProjections.id, projDupId));
      expect(projAfter.length).toBe(0);

      // 4. Primary topic survived with updated generation and canonical name
      const primaryAfter = await db.select().from(topics).where(eq(topics.id, primaryTopicId));
      expect(primaryAfter.length).toBe(1);
      expect(primaryAfter[0]!.mahallaName).toBe('Раваллик ва Яккақайроғоч');
      expect(primaryAfter[0]!.requiredDerivedGeneration).toBe(2);

      // 5. All evidence records now point to primary topic and have canonical name
      const allEvidence = await db
        .select()
        .from(acceptedEvidence)
        .where(inArray(acceptedEvidence.id, [evi1Id, evi2Id, evi3Id]));
      expect(allEvidence.length).toBe(3);
      for (const evi of allEvidence) {
        expect(evi.topicId).toBe(primaryTopicId);
        expect(evi.mahallaName).toBe('Раваллик ва Яккақайроғоч');
      }

      // Idempotency check: running again finds 0 duplicates
      const idempotentSummary = await deduplicateMahallaTopics(pool, {
        dryRun: false,
        execute: true,
        districtId: testDistrictId,
      });
      expect(idempotentSummary.clustersWithDuplicates).toBe(0);
      expect(idempotentSummary.duplicateTopicsRemoved).toBe(0);
      expect(idempotentSummary.groupsNormalized).toBe(0);
    });

    it('normalizes single active topics with non-canonical names', async () => {
      const calendarDay = '2026-10-15';
      const now = new Date();

      const singleTopicId = `top_single_${crypto.randomUUID()}`;
      await db.insert(topics).values({
        id: singleTopicId,
        districtId: testDistrictId,
        mahallaName: 'Равотликлар МФЙ',
        calendarDay,
        primaryLane: 'GAS',
        status: 'ACTIVE',
        requiredDerivedGeneration: 1,
        appliedDerivedGeneration: 1,
        latestRelevantEvidenceTimestamp: now,
        retentionExpiresAt: new Date(now.getTime() + 30 * 86400 * 1000),
        createdAt: now,
      });

      const intakeId = `int_${crypto.randomUUID()}`;
      await db.insert(telegramIntakeRecords).values({
        id: intakeId,
        districtId: testDistrictId,
        mahallaName: 'Равотликлар МФЙ',
        source: 'USERBOT',
        telegramChatId: '-100777777',
        telegramMessageId: '301',
        originalTimestamp: now,
        calendarDay,
        rawPayload: { text: 'Test' },
        status: 'ACCEPTED',
      });

      const eviId = `evi_${crypto.randomUUID()}`;
      await db.insert(acceptedEvidence).values({
        id: eviId,
        topicId: singleTopicId,
        districtId: testDistrictId,
        mahallaName: 'Равотликлар МФЙ',
        calendarDay,
        intakeRecordId: intakeId,
        telegramChatId: '-100777777',
        telegramMessageId: '301',
        originalTimestamp: now,
        verbatimText: 'Газ босими паст',
        contentType: 'TEXT',
      });

      const summary = await deduplicateMahallaTopics(pool, {
        dryRun: false,
        execute: true,
        districtId: testDistrictId,
      });

      expect(summary.singleTopicsNormalized).toBe(1);

      const topicCheck = await db.select().from(topics).where(eq(topics.id, singleTopicId));
      expect(topicCheck[0]!.mahallaName).toBe('Равотликлар');

      const eviCheck = await db.select().from(acceptedEvidence).where(eq(acceptedEvidence.id, eviId));
      expect(eviCheck[0]!.mahallaName).toBe('Равотликлар');
    });
  });
});
