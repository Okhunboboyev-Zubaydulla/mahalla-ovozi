import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { eq, inArray } from 'drizzle-orm';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import {
  districts,
  topics,
  topicProjections,
  acceptedEvidence,
  telegramIntakeRecords,
} from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import { getTashkentCalendarDay } from '../src/modules/telegram-intake/timezone-util.js';
import {
  remediateFalsePositiveEvidence,
  matchFalsePositiveRule,
} from '../src/scripts/remediate-false-positive-evidence.js';

describe('Integration Tests: Remediation of Erroneous Messages in Client Dashboard', () => {
  let pool: pg.Pool;
  let db: DbClient;

  const districtId = `dis_remed_test_${Date.now()}`;
  const testCalendarDay = getTashkentCalendarDay(Math.floor(Date.now() / 1000));

  const elecTopicId = `top_elec_${Date.now()}`;
  const gasTopicId = `top_gas_${Date.now()}`;

  const elecGenuineEvidenceId = `evi_elec_gen_${Date.now()}`;
  const elecFpEvidence1Id = `evi_elec_fp1_${Date.now()}`;
  const elecFpEvidence2Id = `evi_elec_fp2_${Date.now()}`;

  const gasGenuineEvidenceId = `evi_gas_gen_${Date.now()}`;
  const gasFpEvidence1Id = `evi_gas_fp1_${Date.now()}`;
  const gasFpEvidence2Id = `evi_gas_fp2_${Date.now()}`;

  const intakeRecords = [
    { id: `intake_elec_gen_${Date.now()}`, msgId: '1001', text: 'Трансформатор ёниб кетди, свет йўқ' },
    { id: `intake_elec_fp1_${Date.now()}`, msgId: '1002', text: 'Stansada nos sotetkanlani atrofiga borsez shu atrofda' },
    { id: `intake_elec_fp2_${Date.now()}`, msgId: '1003', text: 'Qanchayakan' },
    { id: `intake_gas_gen_${Date.now()}`, msgId: '2001', text: 'Газ босими паст, газ қувури ёрилиб кетган' },
    { id: `intake_gas_fp1_${Date.now()}`, msgId: '2002', text: 'Ушбу Ким ошдига прокурор назорат  у́рнатса яхши бўларди' },
    { id: `intake_gas_fp2_${Date.now()}`, msgId: '2003', text: 'ОЛИМЖОН АКА ХУДДИ ШУ АКА ТУРАЕВ ТУЛКИН АКА БИЛАН ГАПЛАШГАН ЭДИК' },
  ];

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);

    await ensureDefaultAiProfiles(db);
    const profile = await db.query.aiProfiles.findFirst();
    if (!profile) throw new Error('Seeded AI profile missing');

    // 1. Insert test district
    await db.insert(districts).values({
      id: districtId,
      name: 'Remediation Test District',
      region: 'Tashkent Region',
      status: 'ACTIVE',
      accessEligible: true,
    });

    // 2. Insert intake records
    for (const rec of intakeRecords) {
      await db.insert(telegramIntakeRecords).values({
        id: rec.id,
        districtId,
        mahallaName: rec.msgId.startsWith('1') ? 'Катта Қишлоқ МФЙ' : 'Раваллик ва Яккакайрогоч МФЙ',
        source: 'BOT_API',
        telegramBotId: 'bot_1',
        telegramChatId: '-100999888',
        telegramMessageId: rec.msgId,
        originalTimestamp: new Date(),
        calendarDay: testCalendarDay,
        rawPayload: { text: rec.text },
        status: 'ACCEPTED',
      });
    }

    // 3. Insert Electricity Topic (Катта Қишлоқ МФЙ)
    await db.insert(topics).values({
      id: elecTopicId,
      districtId,
      mahallaName: 'Катта Қишлоқ МФЙ',
      calendarDay: testCalendarDay,
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date(),
      retentionExpiresAt: new Date(Date.now() + 86400000 * 30),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 1,
    });

    // Insert 3 evidence items for Electricity (1 genuine + 2 false positives)
    await db.insert(acceptedEvidence).values([
      {
        id: elecGenuineEvidenceId,
        topicId: elecTopicId,
        districtId,
        mahallaName: 'Катта Қишлоқ МФЙ',
        calendarDay: testCalendarDay,
        intakeRecordId: intakeRecords[0]!.id,
        telegramChatId: '-100999888',
        telegramMessageId: '1001',
        originalTimestamp: new Date(Date.now() - 3600000),
        verbatimText: intakeRecords[0]!.text,
        contentType: 'TEXT',
      },
      {
        id: elecFpEvidence1Id,
        topicId: elecTopicId,
        districtId,
        mahallaName: 'Катта Қишлоқ МФЙ',
        calendarDay: testCalendarDay,
        intakeRecordId: intakeRecords[1]!.id,
        telegramChatId: '-100999888',
        telegramMessageId: '1002',
        originalTimestamp: new Date(Date.now() - 1800000),
        verbatimText: intakeRecords[1]!.text,
        contentType: 'TEXT',
      },
      {
        id: elecFpEvidence2Id,
        topicId: elecTopicId,
        districtId,
        mahallaName: 'Катта Қишлоқ МФЙ',
        calendarDay: testCalendarDay,
        intakeRecordId: intakeRecords[2]!.id,
        telegramChatId: '-100999888',
        telegramMessageId: '1003',
        originalTimestamp: new Date(),
        verbatimText: intakeRecords[2]!.text,
        contentType: 'TEXT',
      },
    ]);

    // Insert Electricity Topic Projection (with fake latest_update)
    await db.insert(topicProjections).values({
      id: `prj_elec_${Date.now()}`,
      topicId: elecTopicId,
      districtId,
      mahallaName: 'Катта Қишлоқ МФЙ',
      calendarDay: testCalendarDay,
      summary: 'Катта Қишлоқ МФЙда электр таъминотида узилиш кузатилмоқда',
      latestUpdate: 'Нос сотувчилари ҳақида қўшимча маълумот берилди',
      lanes: ['ELECTRICITY'],
      primaryLane: 'ELECTRICITY',
      anchorEvidenceId: elecGenuineEvidenceId,
      anchorQuote: 'Трансформатор ёниб кетди',
      latestMeaningfulActivityTimestamp: new Date(),
      attribution: 'Маҳалла фуқароси',
      isHokimRelated: false,
      generation: 1,
      aiProfileId: profile.id,
    });

    // 4. Insert Gas Topic (Раваллик ва Яккакайрогоч МФЙ)
    await db.insert(topics).values({
      id: gasTopicId,
      districtId,
      mahallaName: 'Раваллик ва Яккакайрогоч МФЙ',
      calendarDay: testCalendarDay,
      primaryLane: 'GAS',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date(),
      retentionExpiresAt: new Date(Date.now() + 86400000 * 30),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 1,
    });

    // Insert 3 evidence items for Gas (1 genuine + 2 false positives)
    // IMPORTANT: Anchor the projection to gasFpEvidence1Id to test referential unlinking!
    await db.insert(acceptedEvidence).values([
      {
        id: gasGenuineEvidenceId,
        topicId: gasTopicId,
        districtId,
        mahallaName: 'Раваллик ва Яккакайрогоч МФЙ',
        calendarDay: testCalendarDay,
        intakeRecordId: intakeRecords[3]!.id,
        telegramChatId: '-100999888',
        telegramMessageId: '2001',
        originalTimestamp: new Date(Date.now() - 3600000),
        verbatimText: intakeRecords[3]!.text,
        contentType: 'TEXT',
      },
      {
        id: gasFpEvidence1Id,
        topicId: gasTopicId,
        districtId,
        mahallaName: 'Раваллик ва Яккакайрогоч МФЙ',
        calendarDay: testCalendarDay,
        intakeRecordId: intakeRecords[4]!.id,
        telegramChatId: '-100999888',
        telegramMessageId: '2002',
        originalTimestamp: new Date(Date.now() - 1800000),
        verbatimText: intakeRecords[4]!.text,
        contentType: 'TEXT',
      },
      {
        id: gasFpEvidence2Id,
        topicId: gasTopicId,
        districtId,
        mahallaName: 'Раваллик ва Яккакайрогоч МФЙ',
        calendarDay: testCalendarDay,
        intakeRecordId: intakeRecords[5]!.id,
        telegramChatId: '-100999888',
        telegramMessageId: '2003',
        originalTimestamp: new Date(),
        verbatimText: intakeRecords[5]!.text,
        contentType: 'TEXT',
      },
    ]);

    // Insert Gas Topic Projection (with fabricated Hokim claims and anchored to fp1)
    await db.insert(topicProjections).values({
      id: `prj_gas_${Date.now()}`,
      topicId: gasTopicId,
      districtId,
      mahallaName: 'Раваллик ва Яккакайрогоч МФЙ',
      calendarDay: testCalendarDay,
      summary: 'Раваллик ва Яккакайрогоч МФЙда газ қувури юзасидан ҳокимликка эътироз билдирилгани хабар қилинмоқда',
      latestUpdate: 'Ҳокимлик ва мутасадди идораларга эътироз билдирилмоқда',
      lanes: ['GAS', 'HOKIM_RELATED'],
      primaryLane: 'GAS',
      anchorEvidenceId: gasFpEvidence1Id, // Anchored to the false positive to verify safe decoupling
      anchorQuote: 'Ушбу Ким ошдига прокурор назорат',
      latestMeaningfulActivityTimestamp: new Date(),
      attribution: 'Маҳалла аҳолиси',
      isHokimRelated: true,
      generation: 1,
      aiProfileId: profile.id,
    });
  });

  afterAll(async () => {
    // Clean up test data
    await db.delete(topicProjections).where(inArray(topicProjections.topicId, [elecTopicId, gasTopicId]));
    await db.delete(acceptedEvidence).where(inArray(acceptedEvidence.topicId, [elecTopicId, gasTopicId]));
    await db.delete(topics).where(inArray(topics.id, [elecTopicId, gasTopicId]));
    await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.districtId, districtId));
    await db.delete(districts).where(eq(districts.id, districtId));
    await pool.end();
  });

  it('correctly matches false-positive rules for street vendor chatter and prosecutor inquiry', () => {
    const match1 = matchFalsePositiveRule(
      'Stansada nos sotetkanlani atrofiga borsez shu atrofda',
      'Катта Қишлоқ МФЙ',
      'ELECTRICITY',
    );
    expect(match1).not.toBeNull();
    expect(match1?.exclusionReason).toBe('GENERAL_CHATTER');

    const match2 = matchFalsePositiveRule(
      'Qanchayakan',
      'Катта Қишлоқ МФЙ',
      'ELECTRICITY',
    );
    expect(match2).not.toBeNull();
    expect(match2?.exclusionReason).toBe('GENERAL_CHATTER');

    const match3 = matchFalsePositiveRule(
      'Ушбу Ким ошдига прокурор назорат  у́рнатса яхши бўларди',
      'Раваллик ва Яккакайрогоч МФЙ',
      'GAS',
    );
    expect(match3).not.toBeNull();
    expect(match3?.exclusionReason).toBe('GENERAL_CHATTER');

    const match4 = matchFalsePositiveRule(
      'ОЛИМЖОН АКА ХУДДИ ШУ АКА ТУРАЕВ ТУЛКИН АКА БИЛАН ГАПЛАШГАН ЭДИК',
      'Раваллик ва Яккакайрогоч МФЙ',
      'GAS',
    );
    expect(match4).not.toBeNull();
    expect(match4?.exclusionReason).toBe('GENERAL_CHATTER');

    // Genuine civic disruption messages must NOT match
    const genuineElec = matchFalsePositiveRule(
      'Трансформатор ёниб кетди, свет йўқ',
      'Катта Қишлоқ МФЙ',
      'ELECTRICITY',
    );
    expect(genuineElec).toBeNull();

    const genuineGas = matchFalsePositiveRule(
      'Газ босими паст, газ қувури ёрилиб кетган',
      'Раваллик ва Яккакайрогоч МФЙ',
      'GAS',
    );
    expect(genuineGas).toBeNull();
  });

  it('runs dry-run preview without modifying database state', async () => {
    const result = await remediateFalsePositiveEvidence(
      { db, pool },
      { execute: false, dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.matchedEvidenceCount).toBe(4);
    expect(result.affectedTopicsCount).toBe(2);

    // Verify DB remains untouched
    const elecEvidence = await db
      .select()
      .from(acceptedEvidence)
      .where(eq(acceptedEvidence.topicId, elecTopicId));
    expect(elecEvidence.length).toBe(3);

    const gasEvidence = await db
      .select()
      .from(acceptedEvidence)
      .where(eq(acceptedEvidence.topicId, gasTopicId));
    expect(gasEvidence.length).toBe(3);
  });

  it('executes remediation, deletes false positives, updates intake records to EXCLUDED, and updates projections', async () => {
    const result = await remediateFalsePositiveEvidence(
      { db, pool },
      { execute: true, dryRun: false, skipAi: true },
    );

    expect(result.dryRun).toBe(false);
    expect(result.matchedEvidenceCount).toBe(4);
    expect(result.affectedTopicsCount).toBe(2);

    // 1. Verify Electricity Topic state
    const remainingElecEvidence = await db
      .select()
      .from(acceptedEvidence)
      .where(eq(acceptedEvidence.topicId, elecTopicId));
    expect(remainingElecEvidence.length).toBe(1);
    expect(remainingElecEvidence[0]!.id).toBe(elecGenuineEvidenceId);

    const [elecProjection] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, elecTopicId));
    expect(elecProjection).toBeDefined();
    // In single-evidence topic, fake latest_update MUST BE CLEARED to null
    expect(elecProjection!.latestUpdate).toBeNull();
    expect(elecProjection!.lanes).toEqual(['ELECTRICITY']);
    expect(elecProjection!.isHokimRelated).toBe(false);

    // 2. Verify Gas Topic state
    const remainingGasEvidence = await db
      .select()
      .from(acceptedEvidence)
      .where(eq(acceptedEvidence.topicId, gasTopicId));
    expect(remainingGasEvidence.length).toBe(1);
    expect(remainingGasEvidence[0]!.id).toBe(gasGenuineEvidenceId);

    const [gasProjection] = await db
      .select()
      .from(topicProjections)
      .where(eq(topicProjections.topicId, gasTopicId));
    expect(gasProjection).toBeDefined();
    // HOKIM_RELATED must be stripped from lanes and is_hokim_related must be false
    expect(gasProjection!.lanes).not.toContain('HOKIM_RELATED');
    expect(gasProjection!.lanes).toContain('GAS');
    expect(gasProjection!.isHokimRelated).toBe(false);
    // Ungrounded Hokim accusations in summary must be sanitized
    expect(gasProjection!.summary).not.toMatch(/[ҳхh]окимликка\s+эътироз/i);
    expect(gasProjection!.summary).toContain('мутасаддиларга эътироз');
    // Anchor evidence must safely point to the remaining genuine gas evidence
    expect(gasProjection!.anchorEvidenceId).toBe(gasGenuineEvidenceId);

    // 3. Verify telegram_intake_records for deleted evidence are marked EXCLUDED / GENERAL_CHATTER
    const fpIntakeIds = [
      intakeRecords[1]!.id,
      intakeRecords[2]!.id,
      intakeRecords[4]!.id,
      intakeRecords[5]!.id,
    ];

    const updatedIntakes = await db
      .select()
      .from(telegramIntakeRecords)
      .where(inArray(telegramIntakeRecords.id, fpIntakeIds));

    expect(updatedIntakes.length).toBe(4);
    for (const intake of updatedIntakes) {
      expect(intake.status).toBe('EXCLUDED');
      const payload = intake.rawPayload as Record<string, unknown>;
      expect(payload.status).toBe('EXCLUDED');
      expect(payload.exclusionReason).toBe('GENERAL_CHATTER');
    }

    // Genuine intakes must remain ACCEPTED
    const [genElecIntake] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.id, intakeRecords[0]!.id));
    expect(genElecIntake!.status).toBe('ACCEPTED');

    const [genGasIntake] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.id, intakeRecords[3]!.id));
    expect(genGasIntake!.status).toBe('ACCEPTED');
  });

  it('is completely idempotent when run multiple times', async () => {
    // Running again should find 0 false positives and produce no errors
    const secondRun = await remediateFalsePositiveEvidence(
      { db, pool },
      { execute: true, dryRun: false, skipAi: true },
    );

    expect(secondRun.matchedEvidenceCount).toBe(0);
    expect(secondRun.affectedTopicsCount).toBe(0);

    const remainingElecEvidence = await db
      .select()
      .from(acceptedEvidence)
      .where(eq(acceptedEvidence.topicId, elecTopicId));
    expect(remainingElecEvidence.length).toBe(1);

    const remainingGasEvidence = await db
      .select()
      .from(acceptedEvidence)
      .where(eq(acceptedEvidence.topicId, gasTopicId));
    expect(remainingGasEvidence.length).toBe(1);
  });
});
