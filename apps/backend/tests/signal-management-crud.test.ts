import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import {
  districts,
  telegramIntakeRecords,
  aiProfiles,
  aiOperations,
  acceptedEvidence,
  topics,
  topicProjections,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { COOKIE_NAME } from '../src/modules/auth/session-manager.js';
import { createBossClient, initBossQueues } from '../src/adapters/jobs/boss-client.js';
import { purgeExpiredDebugIntakePayloads } from '../src/modules/retention/debug-payload-retention.js';
import { extractSignalVerbatimText } from '../src/modules/topics/topic-evidence-management-service.js';
import type PgBoss from 'pg-boss';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Signal & Evidence Management Console & CRUD Verification', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;
  let server: FastifyInstance;

  let poCookie: string;
  let testDistrictId: string;
  const mahallaName = 'Istiqlol MFY';
  const calendarDay = '2026-09-01';

  let relevantIntakeId: string;
  let excludedIntakeId: string;
  let evidenceId: string;
  let topicId: string;
  let profileId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient();
    await boss.start();
    await initBossQueues(boss);

    server = await buildHttpServer({ db, pool, boss });
    await server.ready();

    // 1. Authenticate Product Owner
    const poUsername = `po_signals_${Date.now()}`;
    const poPassword = 'SecurePOPassword2026!';
    await createOrResetProductOwner(db, {
      username: poUsername,
      password: poPassword,
    });

    const signInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: poUsername,
        password: poPassword,
      },
    });
    expect(signInRes.statusCode).toBe(200);
    const sessionCookie = signInRes.cookies.find((c) => c.name === COOKIE_NAME);
    expect(sessionCookie).toBeDefined();
    poCookie = `${sessionCookie!.name}=${sessionCookie!.value}`;

    // 2. Create Test District
    testDistrictId = `dist_sig_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: testDistrictId,
      name: `District_Signals_${crypto.randomUUID().slice(0, 6)}`,
      status: 'ACTIVE',
    });

    // 2.1 Seed Test AI Profile
    profileId = `prof_test_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(aiProfiles).values({
      id: profileId,
      version: 1,
      operationType: 'SEMANTIC_RELEVANCE',
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini',
      promptVersion: 'v1',
      schemaVersion: 'v1',
      temperature: 0.0,
      maxOutputTokens: 500,
      timeoutMs: 10000,
      retryPolicy: { maxAttempts: 3 },
      capabilities: { structuredOutputs: true },
      isActive: true,
    });

    // 3. Create Relevant Intake & Evidence & Topic
    relevantIntakeId = `intake_rel_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: relevantIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-1001234567',
      telegramMessageId: '1001',
      originalTimestamp: new Date('2026-09-01T10:00:00.000Z'),
      calendarDay,
      rawPayload: {
        text: 'Suv o`chib qoldi, 3 kundan beri suv yo`q',
        from: { id: 111, first_name: 'Resident A' },
      },
    });

    const relevantAiOpId = `aiop_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: relevantAiOpId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: relevantIntakeId,
      pinnedProfileId: profileId,
      snapshotFingerprint: 'fp_test',
      finalStatus: 'COMPLETED_RELEVANT',
      resultPayload: {
        is_relevant: true,
        relevant_lanes: ['WATER'],
        exclusion_reason: null,
        reasoning: 'Tap water outage reported by resident for 3 days',
      },
    });

    topicId = `top_${crypto.randomUUID()}`;
    await db.insert(topics).values({
      id: topicId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      primaryLane: 'WATER',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date('2026-09-01T10:00:00.000Z'),
      retentionExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      requiredDerivedGeneration: 1,
      appliedDerivedGeneration: 1,
    });

    evidenceId = `evi_${crypto.randomUUID()}`;
    await db.insert(acceptedEvidence).values({
      id: evidenceId,
      topicId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      intakeRecordId: relevantIntakeId,
      telegramChatId: '-1001234567',
      telegramMessageId: '1001',
      originalTimestamp: new Date('2026-09-01T10:00:00.000Z'),
      verbatimText: 'Suv o`chib qoldi, 3 kundan beri suv yo`q',
      contentType: 'TEXT',
      aiOperationId: relevantAiOpId,
    });

    await db.insert(topicProjections).values({
      id: `prj_${crypto.randomUUID()}`,
      topicId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      summary: 'Истиқлол МФЙда сув таъминотида 3 кунлик узилиш кузатилмоқда.',
      lanes: ['WATER'],
      primaryLane: 'WATER',
      anchorEvidenceId: evidenceId,
      anchorQuote: '3 kundan beri suv yo`q',
      latestMeaningfulActivityTimestamp: new Date('2026-09-01T10:00:00.000Z'),
      attribution: 'Telegram',
      generation: 1,
      aiProfileId: profileId,
    });

    // 4. Create Excluded Intake with Bounded Debug Retention
    excludedIntakeId = `intake_ex_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: excludedIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-1001234567',
      telegramMessageId: '1002',
      originalTimestamp: new Date('2026-09-01T11:00:00.000Z'),
      calendarDay,
      rawPayload: {
        status: 'EXCLUDED',
        exclusionReason: 'ADVERTISEMENT_OR_SPAM',
        verbatimText: 'Kvartira ijaraga beriladi, arzon narxda!',
        reasoning: 'Commercial apartment rental advertisement',
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });

    await db.insert(aiOperations).values({
      id: `aiop_${crypto.randomUUID()}`,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: excludedIntakeId,
      pinnedProfileId: profileId,
      snapshotFingerprint: 'fp_test',
      finalStatus: 'COMPLETED_IRRELEVANT',
      resultPayload: {
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
        reasoning: 'Commercial apartment rental advertisement',
      },
    });
  });

  it('1. GET /api/v1/admin/signals lists signals with full text, decisions, and reasoning', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThanOrEqual(2);

    const relevant = body.items.find((i: any) => i.intakeId === relevantIntakeId);
    expect(relevant).toBeDefined();
    expect(relevant.isRelevant).toBe(true);
    expect(relevant.verbatimText).toContain('Suv o`chib qoldi');
    expect(relevant.reasoning).toContain('Tap water outage');
    expect(relevant.relevantLanes).toContain('WATER');

    const excluded = body.items.find((i: any) => i.intakeId === excludedIntakeId);
    expect(excluded).toBeDefined();
    expect(excluded.isRelevant).toBe(false);
    expect(excluded.verbatimText).toContain('Kvartira ijaraga beriladi');
    expect(excluded.exclusionReason).toBe('ADVERTISEMENT_OR_SPAM');
    expect(excluded.reasoning).toContain('Commercial apartment rental');
  });

  it('2. GET /api/v1/admin/signals filters by isRelevant status', async () => {
    const resRelevant = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&isRelevant=true`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(resRelevant.statusCode).toBe(200);
    const bodyRel = JSON.parse(resRelevant.payload);
    expect(bodyRel.items.every((i: any) => i.isRelevant === true)).toBe(true);

    const resExcluded = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&isRelevant=false`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(resExcluded.statusCode).toBe(200);
    const bodyEx = JSON.parse(resExcluded.payload);
    expect(bodyEx.items.every((i: any) => i.isRelevant === false)).toBe(true);
  });

  it('2a. GET /api/v1/admin/signals filters by mahallaName case-insensitively with substring matching', async () => {
    // Partial lowercase query
    const resPartial = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&mahallaName=istiq`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(resPartial.statusCode).toBe(200);
    const bodyPartial = JSON.parse(resPartial.payload);
    expect(bodyPartial.items.length).toBeGreaterThanOrEqual(1);
    expect(bodyPartial.items.some((i: any) => i.intakeId === relevantIntakeId)).toBe(true);
    expect(bodyPartial.items.every((i: any) => i.mahallaName.toLowerCase().includes('istiq'))).toBe(true);

    // Uppercase full match query
    const resUpper = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&mahallaName=ISTIQLOL`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(resUpper.statusCode).toBe(200);
    const bodyUpper = JSON.parse(resUpper.payload);
    expect(bodyUpper.items.length).toBeGreaterThanOrEqual(1);
    expect(bodyUpper.items.every((i: any) => i.mahallaName.toUpperCase().includes('ISTIQLOL'))).toBe(true);

    // SQL LIKE wildcard character % treated as literal search, not wildcard matching all
    const resWildcard = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&mahallaName=%`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(resWildcard.statusCode).toBe(200);
    const bodyWildcard = JSON.parse(resWildcard.payload);
    expect(bodyWildcard.items.length).toBe(0);

    // Non-existent mahalla returns empty
    const resNone = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&mahallaName=nonexistent_xyz`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(resNone.statusCode).toBe(200);
    const bodyNone = JSON.parse(resNone.payload);
    expect(bodyNone.items.length).toBe(0);
  });

  it('2b. GET /api/v1/admin/signals filters by startDate and endDate range', async () => {
    // Range including the 2026-09-01 record
    const resMatch = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&startDate=2026-09-01T00:00:00.000Z&endDate=2026-09-01T23:59:59.999Z`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(resMatch.statusCode).toBe(200);
    const bodyMatch = JSON.parse(resMatch.payload);
    expect(bodyMatch.items.length).toBeGreaterThanOrEqual(1);
    expect(bodyMatch.items.some((i: any) => i.intakeId === relevantIntakeId)).toBe(true);

    // Range outside the record timestamp (e.g. tomorrow)
    const resMiss = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&startDate=2026-09-02T00:00:00.000Z&endDate=2026-09-02T23:59:59.999Z`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(resMiss.statusCode).toBe(200);
    const bodyMiss = JSON.parse(resMiss.payload);
    expect(bodyMiss.items.length).toBe(0);

    // Inverted date range (startDate > endDate) returns empty cleanly without error
    const resInverted = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&startDate=2026-09-05T00:00:00.000Z&endDate=2026-09-01T00:00:00.000Z`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(resInverted.statusCode).toBe(200);
    const bodyInverted = JSON.parse(resInverted.payload);
    expect(bodyInverted.items.length).toBe(0);
    expect(bodyInverted.pagination.hasNextPage).toBe(false);
  });

  it('3. GET /api/v1/admin/signals/:id returns single signal detail', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals/${relevantIntakeId}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.signal.intakeId).toBe(relevantIntakeId);
    expect(body.signal.verbatimText).toContain('Suv o`chib qoldi');
  });

  it('4. POST /api/v1/admin/signals/:id/promote promotes an excluded message and logs audit event', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/signals/${excludedIntakeId}/promote`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
      payload: {
        lanes: ['HOKIM_RELATED'],
        changeReason: 'Manual PO test override for promotion',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.intakeId).toBe(excludedIntakeId);

    // Verify audit event recorded
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.action} = 'SIGNAL_PROMOTED_TO_EVIDENCE'`)
      .orderBy(sql`${auditEvents.createdAt} DESC`)
      .limit(1);

    expect(audit).toBeDefined();
    expect((audit!.metadata as any)?.intakeId).toBe(excludedIntakeId);
    expect((audit!.metadata as any)?.changeReason).toBe('Manual PO test override for promotion');
  });

  it('4b. POST /api/v1/admin/signals/:id/promote promotes a STRUCTURALLY excluded message (nested raw Telegram payload)', async () => {
    // Structurally excluded intakes (qualification-job-handler / burst-debounce-job-handler)
    // keep the raw Telegram update and add only status/exclusionReason at the root —
    // there is NO flat `verbatimText` key. The message text lives at raw_payload.message.text.
    // Promotion must still work for these, and must NOT claim retention purged the text.
    const structuralIntakeId = `intake_struct_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: structuralIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-1001234567',
      telegramMessageId: '1003',
      originalTimestamp: new Date('2026-09-01T11:30:00.000Z'),
      calendarDay,
      rawPayload: {
        update_id: 991001,
        message: {
          message_id: 1003,
          date: 1756721400,
          text: 'Quvur yorilgan, suv behuda ketmoqda',
          chat: { id: -1001234567, type: 'supergroup' },
          from: { id: 555001, first_name: 'Bekzod', username: 'bekzod_uz' },
        },
        status: 'EXCLUDED',
        exclusionReason: 'FORWARDED_POST',
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/signals/${structuralIntakeId}/promote`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
      payload: {
        lanes: ['WATER'],
        changeReason: 'Structurally excluded but genuinely relevant',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);

    // promoteSignal enqueues a topic-assignment job; Accepted Evidence is created by
    // the worker, not synchronously here. What we must assert is that the enqueued
    // job carries the text resolved from the NESTED payload — without the fix this
    // path threw 404 and no job existed at all.
    const { rows: jobs } = await pool.query(
      `SELECT data FROM pgboss.job
       WHERE name = 'telegram-topic-assignment'
         AND data->>'intakeId' = $1`,
      [structuralIntakeId],
    );

    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(String(jobs[0].data.verbatimText)).toContain('Quvur yorilgan');
  });

  it('5. PATCH /api/v1/admin/signals/:id/evidence updates verbatim text and logs audit event', async () => {
    const newText = 'Suv o`chib qoldi, 3 kundan beri suv yo`q (tahrirlangan)';
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/admin/signals/${evidenceId}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
      payload: {
        verbatimText: newText,
        changeReason: 'Corrected punctuation in resident message',
      },
    });

    expect(res.statusCode).toBe(200);
    const [updatedEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(sql`${acceptedEvidence.id} = ${evidenceId}`)
      .limit(1);

    expect(updatedEvidence).toBeDefined();
    expect(updatedEvidence!.verbatimText).toBe(newText);

    // Verify audit event
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.action} = 'EVIDENCE_TEXT_UPDATED'`)
      .orderBy(sql`${auditEvents.createdAt} DESC`)
      .limit(1);

    expect(audit).toBeDefined();
    expect((audit!.metadata as any)?.evidenceId).toBe(evidenceId);
  });

  it('6. POST /api/v1/admin/signals/:id/reclassify reclassifies evidence lane', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/signals/${evidenceId}/reclassify`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
      payload: {
        lanes: ['ELECTRICITY'],
        changeReason: 'Resident message actually reported electric transformer outage',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.newTopicId).toBeDefined();

    // Verify evidence moved to electricity topic
    const [updatedEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(sql`${acceptedEvidence.id} = ${evidenceId}`)
      .limit(1);

    expect(updatedEvidence).toBeDefined();
    expect(updatedEvidence!.topicId).toBe(body.newTopicId);
  });

  it('7. DELETE /api/v1/admin/signals/:id/evidence deletes evidence and cascades clean topic removal', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/v1/admin/signals/${evidenceId}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
      payload: {
        changeReason: 'Test cleanup of single-evidence topic',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);

    const [deletedEvidence] = await db
      .select()
      .from(acceptedEvidence)
      .where(sql`${acceptedEvidence.id} = ${evidenceId}`)
      .limit(1);
    expect(deletedEvidence).toBeUndefined();

    // Verify audit event
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.action} = 'EVIDENCE_DELETED'`)
      .orderBy(sql`${auditEvents.createdAt} DESC`)
      .limit(1);

    expect(audit).toBeDefined();
    expect((audit!.metadata as any)?.evidenceId).toBe(evidenceId);
  });

  it('8. POST /api/v1/admin/signals/manual creates manual civic signal', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/signals/manual',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
      payload: {
        districtId: testDistrictId,
        mahallaName: 'Beshariq MFY',
        verbatimText: 'Qishloqda transformator yonib ketdi',
        lanes: ['ELECTRICITY'],
        changeReason: 'Direct citizen hotline appeal',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.intakeId).toBeDefined();

    // Verify intake record exists
    const [intake] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(sql`${telegramIntakeRecords.id} = ${body.intakeId}`)
      .limit(1);

    expect(intake).toBeDefined();
    expect(intake!.mahallaName).toBe('Beshariq MFY');
  });

  it('9. purgeExpiredDebugIntakePayloads purges expired debug payloads while keeping active ones', async () => {
    const expiredIntakeId = `intake_exp_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: expiredIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-1001234567',
      telegramMessageId: '9999',
      originalTimestamp: new Date('2026-08-01T10:00:00.000Z'),
      calendarDay: '2026-08-01',
      rawPayload: {
        status: 'EXCLUDED',
        exclusionReason: 'GENERAL_CHATTER',
        verbatimText: 'Expired text from 30 days ago',
        expiresAt: new Date(Date.now() - 1000).toISOString(), // expired
      },
    });

    const purgeResult = await purgeExpiredDebugIntakePayloads(db, new Date());
    expect(purgeResult.purgedCount).toBeGreaterThanOrEqual(1);

    const [purged] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(sql`${telegramIntakeRecords.id} = ${expiredIntakeId}`)
      .limit(1);

    expect(purged).toBeDefined();
    const payload = purged!.rawPayload as any;
    expect(payload.status).toBe('EXCLUDED');
    expect(payload.exclusionReason).toBe('GENERAL_CHATTER');
    expect(payload.verbatimText).toBeUndefined();
    expect(payload.purgedAt).toBeDefined();
  });

  it('10. GET /api/v1/admin/signals filters by lane and search keywords', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&lane=ELECTRICITY&search=transformator`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0].verbatimText).toContain('transformator');
  });

  it('10b. GET /api/v1/admin/signals search finds a channel_post payload by its displayed text', async () => {
    // L3-P04R-02: channel_post traffic IS ingested (telegram-intake-routes.ts:61-70,
    // telegram-intake-service.ts:267-268), but the search predicate only read
    // raw_payload.message.*, so these messages were DISPLAYED correctly yet UNFINDABLE
    // by search. The predicate now derives its arms from TELEGRAM_MESSAGE_UPDATE_KEYS.
    const channelIntakeId = `intake_chan_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: channelIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-1001234567',
      telegramMessageId: '1007',
      originalTimestamp: new Date('2026-09-01T12:15:00.000Z'),
      calendarDay,
      rawPayload: {
        update_id: 991007,
        channel_post: {
          message_id: 1007,
          date: 1756721700,
          text: 'Kanal posti: mahallada ichimlik suvi muammosi',
          chat: { id: -1001234567, type: 'channel' },
        },
      },
    });

    // The message must be findable by a word that exists ONLY in its channel_post text.
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&search=ichimlik`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const found = body.items.find((item: any) => item.intakeId === channelIntakeId);

    expect(found).toBeDefined();
    expect(found.verbatimText).toContain('ichimlik suvi muammosi');
  });

  it('11. POST /api/v1/admin/signals/:id/promote rejects promoting purged messages without verbatim text', async () => {
    const purgedIntakeId = `intake_purged_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: purgedIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-1001234567',
      telegramMessageId: '12345',
      originalTimestamp: new Date('2026-08-01T10:00:00.000Z'),
      calendarDay: '2026-08-01',
      rawPayload: {
        status: 'EXCLUDED',
        exclusionReason: 'ADVERTISEMENT_OR_SPAM',
        purgedAt: new Date().toISOString(),
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/signals/${purgedIntakeId}/promote`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
      payload: {
        lanes: ['WATER'],
        changeReason: 'Attempt to promote purged message',
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('12. extractSignalVerbatimText resolves native message fields and service event fallbacks', () => {
    // 1. Evidence verbatim text precedence
    expect(extractSignalVerbatimText('Evidence verbatim text', { message: { text: 'Raw text' } })).toBe('Evidence verbatim text');

    // 2. Raw message text
    expect(extractSignalVerbatimText(null, { message: { text: 'Suv oqib yotibdi' } })).toBe('Suv oqib yotibdi');

    // 3. Media caption
    expect(extractSignalVerbatimText(null, { message: { caption: 'Quvur yorildi rasm' } })).toBe('Quvur yorildi rasm');

    // 4. Service message: left_chat_participant
    expect(
      extractSignalVerbatimText(null, {
        message: { left_chat_participant: { first_name: 'Ali', last_name: 'Valiyev' } },
      }),
    ).toBe('(Хизмат хабари: Ali Valiyev гуруҳни тарк этди)');

    // 5. Fallback for completely empty payload
    expect(extractSignalVerbatimText(null, {})).toBe('(Матн мавжуд эмас)');
  });

  it('13. GET /api/v1/admin/signals extracts native Telegram text for in-flight signals and marks service message exclusions as REJECTED', async () => {
    const rawMsgIntakeId = `intake_raw_${crypto.randomUUID()}`;
    const serviceMsgIntakeId = `intake_service_${crypto.randomUUID()}`;

    // Insert in-flight message with raw Telegram update
    await db.insert(telegramIntakeRecords).values({
      id: rawMsgIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-10099887766',
      telegramMessageId: '5501',
      originalTimestamp: new Date('2026-09-02T12:00:00.000Z'),
      calendarDay: '2026-09-02',
      rawPayload: {
        update_id: 112233,
        message: {
          message_id: 5501,
          date: 1788350400,
          chat: { id: -10099887766, type: 'supergroup', title: 'Test Group' },
          from: { id: 12345, is_bot: false, first_name: 'TestUser' },
          text: 'Mahallamizda suv bosimi juda past',
        },
      },
    });

    // Insert service message (user left group)
    await db.insert(telegramIntakeRecords).values({
      id: serviceMsgIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-10099887766',
      telegramMessageId: '5502',
      originalTimestamp: new Date('2026-09-02T12:01:00.000Z'),
      calendarDay: '2026-09-02',
      rawPayload: {
        update_id: 112234,
        message: {
          message_id: 5502,
          date: 1788350460,
          chat: { id: -10099887766, type: 'supergroup', title: 'Test Group' },
          from: { id: 12345, is_bot: false, first_name: 'TestUser' },
          left_chat_participant: { id: 12345, is_bot: false, first_name: 'TestUser' },
        },
      },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    const rawSignal = body.items.find((item: any) => item.intakeId === rawMsgIntakeId);
    expect(rawSignal).toBeDefined();
    expect(rawSignal.verbatimText).toBe('Mahallamizda suv bosimi juda past');
    expect(rawSignal.status).toBe('PENDING');

    const serviceSignal = body.items.find((item: any) => item.intakeId === serviceMsgIntakeId);
    expect(serviceSignal).toBeDefined();
    expect(serviceSignal.status).toBe('REJECTED');
    expect(serviceSignal.exclusionReason).toBe('SERVICE_MESSAGE');
    expect(serviceSignal.verbatimText).toContain('тарк этди');
  });

  it('14. GET /api/v1/admin/signals correctly classifies FAILED and STALE AI operations as REJECTED with AI_PROCESSING_ERROR', async () => {
    const failedIntakeId = `intake_failed_${crypto.randomUUID()}`;
    const staleIntakeId = `intake_stale_${crypto.randomUUID()}`;

    await db.insert(telegramIntakeRecords).values([
      {
        id: failedIntakeId,
        districtId: testDistrictId,
        mahallaName,
        telegramBotId: 'bot_test',
        telegramChatId: '-10099887766',
        telegramMessageId: '5503',
        originalTimestamp: new Date('2026-09-02T12:02:00.000Z'),
        calendarDay: '2026-09-02',
        rawPayload: {
          update_id: 112235,
          message: {
            message_id: 5503,
            date: 1788350520,
            chat: { id: -10099887766, type: 'supergroup', title: 'Test Group' },
            from: { id: 12345, is_bot: false, first_name: 'TestUser' },
            text: 'Gaz bosimi tushib ketdi',
          },
        },
      },
      {
        id: staleIntakeId,
        districtId: testDistrictId,
        mahallaName,
        telegramBotId: 'bot_test',
        telegramChatId: '-10099887766',
        telegramMessageId: '5504',
        originalTimestamp: new Date('2026-09-02T12:03:00.000Z'),
        calendarDay: '2026-09-02',
        rawPayload: {
          update_id: 112236,
          message: {
            message_id: 5504,
            date: 1788350580,
            chat: { id: -10099887766, type: 'supergroup', title: 'Test Group' },
            from: { id: 12345, is_bot: false, first_name: 'TestUser' },
            text: 'Svet o`chdi',
          },
        },
      },
    ]);

    await db.insert(aiOperations).values([
      {
        id: `aiop_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        mahallaName,
        calendarDay: '2026-09-02',
        operationType: 'SEMANTIC_RELEVANCE',
        targetId: failedIntakeId,
        pinnedProfileId: profileId,
        snapshotFingerprint: 'fp_test',
        finalStatus: 'FAILED',
        resultPayload: { error: 'DeepInfra rate limit exceeded: 429' },
      },
      {
        id: `aiop_${crypto.randomUUID()}`,
        districtId: testDistrictId,
        mahallaName,
        calendarDay: '2026-09-02',
        operationType: 'SEMANTIC_RELEVANCE',
        targetId: staleIntakeId,
        pinnedProfileId: profileId,
        snapshotFingerprint: 'fp_test',
        finalStatus: 'STALE',
        resultPayload: null,
      },
    ]);

    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    const failedSignal = body.items.find((item: any) => item.intakeId === failedIntakeId);
    expect(failedSignal).toBeDefined();
    expect(failedSignal.status).toBe('REJECTED');
    expect(failedSignal.exclusionReason).toBe('AI_PROCESSING_ERROR');
    expect(failedSignal.reasoning).toContain('АИ қайта ишлашда хатолик юз берди');

    const staleSignal = body.items.find((item: any) => item.intakeId === staleIntakeId);
    expect(staleSignal).toBeDefined();
    expect(staleSignal.status).toBe('REJECTED');
    expect(staleSignal.exclusionReason).toBe('AI_PROCESSING_ERROR');
    expect(staleSignal.reasoning).toContain('Эскирганлиги сабабли бекор қилинди');
  });

  it('15. Atomically purges pgboss.job background queue jobs when deleting evidence or batch deleting signals', async () => {
    // A. Single evidence deletion: creates topic, evidence, and queued projection job
    const ghostTestTopicId = `top_ghost_${crypto.randomUUID()}`;
    const ghostIntakeId = `intake_ghost_${crypto.randomUUID()}`;
    const ghostEvidenceId = `evd_ghost_${crypto.randomUUID()}`;

    await db.insert(topics).values({
      id: ghostTestTopicId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      primaryLane: 'GAS',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date(),
      retentionExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });

    await db.insert(telegramIntakeRecords).values({
      id: ghostIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-100555444',
      telegramMessageId: '7701',
      originalTimestamp: new Date(),
      calendarDay,
      rawPayload: { text: 'Gaz o`chdi' },
    });

    await db.insert(acceptedEvidence).values({
      id: ghostEvidenceId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      topicId: ghostTestTopicId,
      intakeRecordId: ghostIntakeId,
      telegramChatId: '-100555444',
      telegramMessageId: '7701',
      contentType: 'TEXT',
      verbatimText: 'Gaz o`chdi',
      originalTimestamp: new Date(),
    });

    // Enqueue a projection job for this topic into pgboss
    await boss.send(
      'telegram-topic-projection',
      {
        topicId: ghostTestTopicId,
        districtId: testDistrictId,
        mahallaName,
        calendarDay,
        generation: 1,
      },
      {
        singletonKey: `proj:${ghostTestTopicId}:1`,
      },
    );

    // Also insert a qualification job referencing ghostIntakeId
    await boss.send('telegram-content-qualification', {
      intakeId: ghostIntakeId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      telegramChatId: '-100555444',
      telegramMessageId: '7701',
      originalTimestamp: new Date().toISOString(),
    });

    // Verify jobs exist in pgboss.job
    const preCheckJobs = await db.execute(sql`
      SELECT id, name, data FROM pgboss.job 
      WHERE (data->>'topicId' = ${ghostTestTopicId}) OR (data->>'intakeId' = ${ghostIntakeId})
    `);
    expect(preCheckJobs.rows.length).toBeGreaterThanOrEqual(2);

    // Call DELETE /api/v1/admin/signals/:id/evidence
    const delRes = await server.inject({
      method: 'DELETE',
      url: `/api/v1/admin/signals/${ghostEvidenceId}/evidence`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
      payload: {
        changeReason: 'Cleanup with zero queue trace verification',
      },
    });
    expect(delRes.statusCode).toBe(200);

    // Verify that ALL pgboss.job rows for ghostTestTopicId and ghostIntakeId are deleted
    const postCheckJobs = await db.execute(sql`
      SELECT id FROM pgboss.job 
      WHERE (data->>'topicId' = ${ghostTestTopicId}) OR (data->>'intakeId' = ${ghostIntakeId})
    `);
    expect(postCheckJobs.rows.length).toBe(0);

    // B. Batch deletion of unassigned intake: verify queue purge
    const unassignedIntakeId = `intake_unassigned_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: unassignedIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-100555444',
      telegramMessageId: '7702',
      originalTimestamp: new Date(),
      calendarDay,
      rawPayload: { text: 'Spam reklama' },
    });

    await boss.send('telegram-content-qualification', {
      intakeId: unassignedIntakeId,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      telegramChatId: '-100555444',
      telegramMessageId: '7702',
      originalTimestamp: new Date().toISOString(),
    });

    const preBatchJobs = await db.execute(sql`
      SELECT id FROM pgboss.job WHERE data->>'intakeId' = ${unassignedIntakeId}
    `);
    expect(preBatchJobs.rows.length).toBeGreaterThanOrEqual(1);

    const batchDelRes = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/signals/batch-delete',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
      payload: {
        ids: [unassignedIntakeId],
        changeReason: 'Batch delete with zero queue trace verification',
      },
    });
    expect(batchDelRes.statusCode).toBe(200);

    const postBatchJobs = await db.execute(sql`
      SELECT id FROM pgboss.job WHERE data->>'intakeId' = ${unassignedIntakeId}
    `);
    expect(postBatchJobs.rows.length).toBe(0);
  });

  it('correctly resolves burst intake with rawPayload.status = EXCLUDED to REJECTED even if aiOp was COMPLETED_RELEVANT', async () => {
    const burstExcludedIntakeId = `intake_burst_ex_${crypto.randomUUID()}`;
    await db.insert(telegramIntakeRecords).values({
      id: burstExcludedIntakeId,
      districtId: testDistrictId,
      mahallaName,
      telegramBotId: 'bot_test',
      telegramChatId: '-100999888',
      telegramMessageId: '8801',
      originalTimestamp: new Date(),
      calendarDay,
      rawPayload: {
        message: { text: 'svettiyam ucirishsa endi' },
        status: 'EXCLUDED',
        exclusionReason: 'GENERAL_CHATTER',
        reasoning: 'Cynical hypothetical remark excluded from burst',
      },
    });

    // Seed ai_operations with legacy burst COMPLETED_RELEVANT
    await db.insert(aiOperations).values({
      id: `aiop_${crypto.randomUUID()}`,
      districtId: testDistrictId,
      mahallaName,
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: burstExcludedIntakeId,
      pinnedProfileId: profileId,
      contextRevision: 1,
      snapshotFingerprint: 'dummy_fp',
      finalStatus: 'COMPLETED_RELEVANT',
      resultPayload: {
        is_relevant: true,
        relevant_lanes: ['WATER'],
        accepted_message_ids: ['8800'],
        reasoning: 'Parent burst accepted water outage, excluded electricity sarcasm',
      },
    });

    // Verify detail endpoint resolves to REJECTED
    const detailRes = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals/${burstExcludedIntakeId}`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(detailRes.statusCode).toBe(200);
    const detailBody = JSON.parse(detailRes.body);
    expect(detailBody.signal.status).toBe('REJECTED');
    expect(detailBody.signal.isRelevant).toBe(false);
    expect(detailBody.signal.exclusionReason).toBe('GENERAL_CHATTER');

    // Verify list endpoint filtering (isRelevant=false) includes this excluded intake
    const listRes = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/signals?districtId=${testDistrictId}&isRelevant=false`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    const foundItem = listBody.items.find((i: any) => i.intakeId === burstExcludedIntakeId);
    expect(foundItem).toBeDefined();
    expect(foundItem.status).toBe('REJECTED');
    expect(foundItem.isRelevant).toBe(false);
  });

  afterAll(async () => {
    if (server) await server.close();
    if (boss) await boss.stop();
    if (pool) await pool.end();
  });
});
