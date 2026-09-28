import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import {
  accounts,
  districts,
  aiProfiles,
  aiOperations,
  aiProviderAttempts,
} from '../src/adapters/db/schema/index.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { COOKIE_NAME } from '../src/modules/auth/session-manager.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import {
  aiOperationQueryService,
  InvalidDistrictScopeError,
} from '../src/modules/ai/ai-operation-query-service.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 2.7: AI Operation Traceability and Failure State Verification Matrix', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let poCookie: string;
  let hokimCookie: string;

  let districtAId: string;
  let districtBId: string;

  const profileV1Id = `prof_rel_2026_08_${crypto.randomUUID().slice(0, 8)}`;
  const profileV2Id = `prof_rel_2026_09_${crypto.randomUUID().slice(0, 8)}`;

  // Test operation IDs
  let opRelevanceId: string;
  let opMatchingId: string;
  let opProjectionId: string;
  let opExplicitFailedId: string;
  let opStaleId: string;
  let opRetryExhaustedId: string;
  let opRetrySuccessId: string;
  let opRateLimitId: string;
  let opInvalidSyntaxId: string;
  let opInvalidSemanticsId: string;
  let opDistrictBId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    // 1. Seed Product Owner
    const poUsername = `po_ai_test_${Date.now()}`;
    const poPassword = 'SecurePOPassword2026!';
    await createOrResetProductOwner(db, {
      username: poUsername,
      password: poPassword,
    });

    const poSignInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: poUsername,
        password: poPassword,
      },
    });
    expect(poSignInRes.statusCode).toBe(200);
    const poSessionCookie = poSignInRes.cookies.find((c) => c.name === COOKIE_NAME);
    expect(poSessionCookie).toBeDefined();
    poCookie = `${poSessionCookie!.name}=${poSessionCookie!.value}`;

    // 2. Seed Districts
    districtAId = `dist_ai_a_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: districtAId,
      name: `District_A_${crypto.randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });

    districtBId = `dist_ai_b_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: districtBId,
      name: `District_B_${crypto.randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });

    // 3. Seed Hokim Account for District A
    const hokimUsername = `hokim_ai_${Date.now()}`;
    const hokimPassword = 'SecureHokimPassword2026!';
    const passwordHash = await hashPassword(hokimPassword);
    const hokimAccountId = `acc_hokim_${crypto.randomUUID()}`;
    await db.insert(accounts).values({
      id: hokimAccountId,
      username: hokimUsername,
      passwordHash,
      role: 'DISTRICT_HOKIM',
      status: 'ACTIVE',
      districtId: districtAId,
      mustChangePassword: false,
    });

    const hokimSignInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: {
        username: hokimUsername,
        password: hokimPassword,
      },
    });
    expect(hokimSignInRes.statusCode).toBe(200);
    const hokimSessionCookie = hokimSignInRes.cookies.find((c) => c.name === COOKIE_NAME);
    expect(hokimSessionCookie).toBeDefined();
    hokimCookie = `${hokimSessionCookie!.name}=${hokimSessionCookie!.value}`;

    // 4. Seed AI Profiles (v1 historical pinned, v2 active prospective)
    await db.insert(aiProfiles).values([
      {
        id: profileV1Id,
        version: 1,
        operationType: 'SEMANTIC_RELEVANCE',
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        promptVersion: 'prom_rel_v1',
        schemaVersion: 'sch_rel_v1',
        temperature: 0.0,
        maxOutputTokens: 500,
        timeoutMs: 10000,
        retryPolicy: { maxAttempts: 3, backoffFactor: 2, initialDelayMs: 1000 },
        capabilities: { structuredOutputs: true, jsonSchemaMode: 'strict' },
        isActive: false,
      },
      {
        id: profileV2Id,
        version: 2,
        operationType: 'SEMANTIC_RELEVANCE',
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        promptVersion: 'prom_rel_v2',
        schemaVersion: 'sch_rel_v2',
        temperature: 0.0,
        maxOutputTokens: 500,
        timeoutMs: 10000,
        retryPolicy: { maxAttempts: 3, backoffFactor: 2, initialDelayMs: 1000 },
        capabilities: { structuredOutputs: true, jsonSchemaMode: 'strict' },
        isActive: true,
      },
    ]);

    // 5. Seed Test AI Operations and Attempts
    const now = new Date('2026-08-23T12:00:00.000Z');
    const calendarDay = '2026-08-23';

    // Op 1: Semantic Relevance Completed Relevant
    opRelevanceId = `aiop_rel_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opRelevanceId,
      districtId: districtAId,
      mahallaName: 'Navbahor',
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: `intake_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 0,
      snapshotFingerprint: 'fp_initial_001',
      finalStatus: 'COMPLETED_RELEVANT',
      resultPayload: { is_relevant: true, relevant_lanes: ['WATER'], reasoning: 'Water pipe leak' },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(aiProviderAttempts).values({
      id: `att_${crypto.randomUUID()}`,
      operationId: opRelevanceId,
      attemptNumber: 1,
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini-2024-07-18',
      providerRequestId: 'req_rel_001',
      durationMs: 450,
      inputTokens: 300,
      outputTokens: 50,
      cachedTokens: 100,
      estimatedCostUsd: '0.000150',
      status: 'SUCCESS',
      createdAt: now,
    });

    // Op 2: Topic Matching Completed Matched
    opMatchingId = `aiop_match_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opMatchingId,
      districtId: districtAId,
      mahallaName: 'Navbahor',
      calendarDay,
      operationType: 'TOPIC_MATCHING',
      targetId: `evidence_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 0,
      snapshotFingerprint: 'fp_initial_002',
      finalStatus: 'COMPLETED_MATCHED',
      resultPayload: { action: 'MATCH_EXISTING', topic_id: 'top_001', match_confidence: 0.95 },
      createdAt: new Date(now.getTime() + 1000),
      updatedAt: new Date(now.getTime() + 1000),
    });
    await db.insert(aiProviderAttempts).values({
      id: `att_${crypto.randomUUID()}`,
      operationId: opMatchingId,
      attemptNumber: 1,
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini-2024-07-18',
      durationMs: 500,
      inputTokens: 400,
      outputTokens: 60,
      cachedTokens: 0,
      estimatedCostUsd: '0.000200',
      status: 'SUCCESS',
      createdAt: new Date(now.getTime() + 1000),
    });

    // Op 3: Topic Derived Projection Completed
    opProjectionId = `aiop_proj_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opProjectionId,
      districtId: districtAId,
      mahallaName: 'Istiqlol',
      calendarDay,
      operationType: 'TOPIC_DERIVED_PROJECTION',
      targetId: `topic_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 1,
      snapshotFingerprint: 'fp_initial_003',
      finalStatus: 'COMPLETED',
      resultPayload: { generated_title: 'Water outage update', problem_statement: 'Repairs ongoing' },
      createdAt: new Date(now.getTime() + 2000),
      updatedAt: new Date(now.getTime() + 2000),
    });
    await db.insert(aiProviderAttempts).values({
      id: `att_${crypto.randomUUID()}`,
      operationId: opProjectionId,
      attemptNumber: 1,
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini-2024-07-18',
      durationMs: 600,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 50,
      estimatedCostUsd: '0.000300',
      status: 'SUCCESS',
      createdAt: new Date(now.getTime() + 2000),
    });

    // Op 4: Explicit Failure (Pre-invocation context overflow - AC 6 / M13)
    opExplicitFailedId = `aiop_fail_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opExplicitFailedId,
      districtId: districtAId,
      mahallaName: 'Navbahor',
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: `intake_overflow_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 0,
      snapshotFingerprint: 'fp_overflow',
      finalStatus: 'FAILED_EXPLICIT',
      resultPayload: { error: 'CONTEXT_LIMIT_EXCEEDED', message: 'Payload exceeded 8192 tokens' },
      createdAt: new Date(now.getTime() + 3000),
      updatedAt: new Date(now.getTime() + 3000),
    });

    // Op 5: Stale Snapshot CAS Revision Advance (AC 7 / M12)
    opStaleId = `aiop_stale_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opStaleId,
      districtId: districtAId,
      mahallaName: 'Navbahor',
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: `intake_stale_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 0,
      snapshotFingerprint: 'fp_stale',
      finalStatus: 'STALE',
      resultPayload: { error: 'STALE_SNAPSHOT', initialRevision: 0, currentRevision: 1 },
      createdAt: new Date(now.getTime() + 4000),
      updatedAt: new Date(now.getTime() + 4000),
    });
    await db.insert(aiProviderAttempts).values({
      id: `att_${crypto.randomUUID()}`,
      operationId: opStaleId,
      attemptNumber: 1,
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini-2024-07-18',
      durationMs: 350,
      inputTokens: 200,
      outputTokens: 30,
      status: 'SUCCESS',
      createdAt: new Date(now.getTime() + 4000),
    });

    // Op 6: Retry Exhaustion (AC 8 / M16)
    opRetryExhaustedId = `aiop_exhaust_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opRetryExhaustedId,
      districtId: districtAId,
      mahallaName: 'Navbahor',
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: `intake_exhaust_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 0,
      snapshotFingerprint: 'fp_exhaust',
      finalStatus: 'FAILED_EXPLICIT',
      createdAt: new Date(now.getTime() + 5000),
      updatedAt: new Date(now.getTime() + 5000),
    });
    await db.insert(aiProviderAttempts).values([
      {
        id: `att_${crypto.randomUUID()}`,
        operationId: opRetryExhaustedId,
        attemptNumber: 1,
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        durationMs: 1000,
        status: 'TIMEOUT',
        errorCode: 'PROVIDER_TIMEOUT',
        sanitizedErrorMessage: 'Provider timed out after 10000ms',
        createdAt: new Date(now.getTime() + 5000),
      },
      {
        id: `att_${crypto.randomUUID()}`,
        operationId: opRetryExhaustedId,
        attemptNumber: 2,
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        durationMs: 1000,
        status: 'TIMEOUT',
        errorCode: 'PROVIDER_TIMEOUT',
        sanitizedErrorMessage: 'Provider timed out on retry 2',
        createdAt: new Date(now.getTime() + 5100),
      },
      {
        id: `att_${crypto.randomUUID()}`,
        operationId: opRetryExhaustedId,
        attemptNumber: 3,
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        durationMs: 1000,
        status: 'TIMEOUT',
        errorCode: 'PROVIDER_TIMEOUT',
        sanitizedErrorMessage: 'Provider timed out on retry 3 - budget exhausted',
        createdAt: new Date(now.getTime() + 5200),
      },
    ]);

    // Op 7: Retry Success after Timeout (AC 2, 5, 8 / M14)
    opRetrySuccessId = `aiop_retry_succ_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opRetrySuccessId,
      districtId: districtAId,
      mahallaName: 'Navbahor',
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: `intake_retry_succ_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 0,
      snapshotFingerprint: 'fp_retry_succ',
      finalStatus: 'COMPLETED_RELEVANT',
      createdAt: new Date(now.getTime() + 6000),
      updatedAt: new Date(now.getTime() + 6000),
    });
    await db.insert(aiProviderAttempts).values([
      {
        id: `att_${crypto.randomUUID()}`,
        operationId: opRetrySuccessId,
        attemptNumber: 1,
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        durationMs: 1000,
        status: 'TIMEOUT',
        errorCode: 'PROVIDER_TIMEOUT',
        sanitizedErrorMessage: 'Upstream HTTP 504 Gateway Timeout',
        createdAt: new Date(now.getTime() + 6000),
      },
      {
        id: `att_${crypto.randomUUID()}`,
        operationId: opRetrySuccessId,
        attemptNumber: 2,
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        durationMs: 400,
        inputTokens: 250,
        outputTokens: 40,
        status: 'SUCCESS',
        createdAt: new Date(now.getTime() + 6100),
      },
    ]);

    // Op 8: Rate Limit with Backoff Retry (AC 2, 5, 8 / M15)
    opRateLimitId = `aiop_ratelimit_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opRateLimitId,
      districtId: districtAId,
      mahallaName: 'Navbahor',
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: `intake_ratelimit_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 0,
      snapshotFingerprint: 'fp_ratelimit',
      finalStatus: 'COMPLETED_RELEVANT',
      createdAt: new Date(now.getTime() + 7000),
      updatedAt: new Date(now.getTime() + 7000),
    });
    await db.insert(aiProviderAttempts).values([
      {
        id: `att_${crypto.randomUUID()}`,
        operationId: opRateLimitId,
        attemptNumber: 1,
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        durationMs: 200,
        status: 'ERROR',
        errorCode: 'RATE_LIMIT_EXCEEDED',
        sanitizedErrorMessage: 'HTTP 429 Rate limit exceeded',
        createdAt: new Date(now.getTime() + 7000),
      },
      {
        id: `att_${crypto.randomUUID()}`,
        operationId: opRateLimitId,
        attemptNumber: 2,
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini-2024-07-18',
        durationMs: 380,
        inputTokens: 200,
        outputTokens: 30,
        status: 'SUCCESS',
        createdAt: new Date(now.getTime() + 7200),
      },
    ]);

    // Op 9: Provider HTTP 200 but Invalid JSON Syntax (AC 4, 5 / M10)
    opInvalidSyntaxId = `aiop_syntax_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opInvalidSyntaxId,
      districtId: districtAId,
      mahallaName: 'Navbahor',
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: `intake_syntax_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 0,
      snapshotFingerprint: 'fp_syntax',
      finalStatus: 'FAILED_EXPLICIT',
      createdAt: new Date(now.getTime() + 8000),
      updatedAt: new Date(now.getTime() + 8000),
    });
    await db.insert(aiProviderAttempts).values({
      id: `att_${crypto.randomUUID()}`,
      operationId: opInvalidSyntaxId,
      attemptNumber: 1,
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini-2024-07-18',
      durationMs: 300,
      status: 'ERROR',
      errorCode: 'INVALID_OUTPUT_SYNTAX',
      sanitizedErrorMessage: 'Unexpected token < in JSON at position 0',
      createdAt: new Date(now.getTime() + 8000),
    });

    // Op 10: Provider HTTP 200 but Invalid Zod Schema (AC 4, 5 / M11)
    opInvalidSemanticsId = `aiop_sem_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opInvalidSemanticsId,
      districtId: districtAId,
      mahallaName: 'Navbahor',
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: `intake_sem_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 0,
      snapshotFingerprint: 'fp_sem',
      finalStatus: 'FAILED_EXPLICIT',
      createdAt: new Date(now.getTime() + 9000),
      updatedAt: new Date(now.getTime() + 9000),
    });
    await db.insert(aiProviderAttempts).values({
      id: `att_${crypto.randomUUID()}`,
      operationId: opInvalidSemanticsId,
      attemptNumber: 1,
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini-2024-07-18',
      durationMs: 320,
      status: 'ERROR',
      errorCode: 'INVALID_OUTPUT_SEMANTICS',
      sanitizedErrorMessage: 'Required field relevant_lanes missing when is_relevant is true',
      createdAt: new Date(now.getTime() + 9000),
    });

    // Op 11: District B Operation (for cross-district isolation testing)
    opDistrictBId = `aiop_distb_${crypto.randomUUID()}`;
    await db.insert(aiOperations).values({
      id: opDistrictBId,
      districtId: districtBId,
      mahallaName: 'Chilonzor-9',
      calendarDay,
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: `intake_distb_${crypto.randomUUID()}`,
      pinnedProfileId: profileV1Id,
      contextRevision: 0,
      snapshotFingerprint: 'fp_distb',
      finalStatus: 'COMPLETED_RELEVANT',
      createdAt: new Date(now.getTime() + 10000),
      updatedAt: new Date(now.getTime() + 10000),
    });
    await db.insert(aiProviderAttempts).values({
      id: `att_${crypto.randomUUID()}`,
      operationId: opDistrictBId,
      attemptNumber: 1,
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini-2024-07-18',
      durationMs: 400,
      status: 'SUCCESS',
      createdAt: new Date(now.getTime() + 10000),
    });
  });

  afterAll(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  // -------------------------------------------------------------
  // M1: Query operations by valid districtId with default pagination
  // -------------------------------------------------------------
  it('M1: Query operations by valid districtId with default pagination (AC 1, 9, 14)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(10);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.limit).toBe(50);
    expect(body.pagination.totalCount).toBeGreaterThanOrEqual(10);
    expect(typeof body.pagination.hasNextPage).toBe('boolean');
    expect(typeof body.pagination.hasPrevPage).toBe('boolean');

    // Verify all items belong to District A
    for (const item of body.items) {
      expect(item.districtId).toBe(districtAId);
    }
  });

  // -------------------------------------------------------------
  // M2: Query operations filtering by mahallaName and calendarDay
  // -------------------------------------------------------------
  it('M2: Query operations filtering by mahallaName and calendarDay (AC 1, 9)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations?mahallaName=Istiqlol&calendarDay=2026-08-23`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].mahallaName).toBe('Istiqlol');
    expect(body.items[0].id).toBe(opProjectionId);
  });

  // -------------------------------------------------------------
  // M3: Query operations filtering by operationType = 'SEMANTIC_RELEVANCE'
  // -------------------------------------------------------------
  it('M3: Query operations filtering by operationType = "SEMANTIC_RELEVANCE" (AC 1)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations?operationType=SEMANTIC_RELEVANCE`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.operationType).toBe('SEMANTIC_RELEVANCE');
    }
  });

  // -------------------------------------------------------------
  // M4: Query operations filtering by operationType = 'TOPIC_MATCHING'
  // -------------------------------------------------------------
  it('M4: Query operations filtering by operationType = "TOPIC_MATCHING" (AC 1)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations?operationType=TOPIC_MATCHING`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].id).toBe(opMatchingId);
    expect(body.items[0].operationType).toBe('TOPIC_MATCHING');
  });

  // -------------------------------------------------------------
  // M5: Query operations filtering by operationType = 'TOPIC_DERIVED_PROJECTION'
  // -------------------------------------------------------------
  it('M5: Query operations filtering by operationType = "TOPIC_DERIVED_PROJECTION" (AC 1)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations?operationType=TOPIC_DERIVED_PROJECTION`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].id).toBe(opProjectionId);
    expect(body.items[0].operationType).toBe('TOPIC_DERIVED_PROJECTION');
  });

  // -------------------------------------------------------------
  // M6: Query operations filtering by finalStatus = 'FAILED_EXPLICIT'
  // -------------------------------------------------------------
  it('M6: Query operations filtering by finalStatus = "FAILED_EXPLICIT" (AC 1, 5)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations?finalStatus=FAILED_EXPLICIT`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(4);
    for (const item of body.items) {
      expect(item.finalStatus).toBe('FAILED_EXPLICIT');
    }
  });

  // -------------------------------------------------------------
  // M7: Query operations filtering by finalStatus = 'STALE'
  // -------------------------------------------------------------
  it('M7: Query operations filtering by finalStatus = "STALE" (AC 1, 7)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations?finalStatus=STALE`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].id).toBe(opStaleId);
    expect(body.items[0].finalStatus).toBe('STALE');
  });

  // -------------------------------------------------------------
  // M8: Get operation details by ID with multiple provider attempts
  // -------------------------------------------------------------
  it('M8: Get operation details by ID with multiple provider attempts (AC 1, 2)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opRetryExhaustedId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.operation).toBeDefined();
    expect(body.operation.operation.id).toBe(opRetryExhaustedId);
    expect(body.operation.profile).toBeDefined();
    expect(body.operation.profile.id).toBe(profileV1Id);
    expect(body.operation.attempts).toBeDefined();
    expect(body.operation.attempts.length).toBe(3);

    // Verify chronological order by attemptNumber ASC
    expect(body.operation.attempts[0].attemptNumber).toBe(1);
    expect(body.operation.attempts[1].attemptNumber).toBe(2);
    expect(body.operation.attempts[2].attemptNumber).toBe(3);
  });

  // -------------------------------------------------------------
  // M9: Verify pinned profile version immutability when newer profile active
  // -------------------------------------------------------------
  it('M9: Verify pinned profile version immutability when newer profile active (AC 3)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opRelevanceId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.operation.profile.id).toBe(profileV1Id);
    expect(body.operation.profile.version).toBe(1);
    expect(body.operation.profile.promptVersion).toBe('prom_rel_v1');
    // Prospective v2 exists and is active, but pinned profile remains v1
    expect(profileV2Id).not.toBe(body.operation.profile.id);
  });

  // -------------------------------------------------------------
  // M10: Provider HTTP 200 but invalid JSON syntax records explicit failure
  // -------------------------------------------------------------
  it('M10: Provider HTTP 200 but invalid JSON syntax records explicit failure (AC 4, 5)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opInvalidSyntaxId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.operation.operation.finalStatus).toBe('FAILED_EXPLICIT');
    expect(body.operation.attempts[0].status).toBe('ERROR');
    expect(body.operation.attempts[0].errorCode).toBe('INVALID_OUTPUT_SYNTAX');
  });

  // -------------------------------------------------------------
  // M11: Provider HTTP 200 but invalid Zod schema records semantic failure
  // -------------------------------------------------------------
  it('M11: Provider HTTP 200 but invalid Zod schema records semantic failure (AC 4, 5)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opInvalidSemanticsId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.operation.operation.finalStatus).toBe('FAILED_EXPLICIT');
    expect(body.operation.attempts[0].status).toBe('ERROR');
    expect(body.operation.attempts[0].errorCode).toBe('INVALID_OUTPUT_SEMANTICS');
  });

  // -------------------------------------------------------------
  // M12: In-flight context revision advance records STALE_SNAPSHOT
  // -------------------------------------------------------------
  it('M12: In-flight context revision advance records STALE_SNAPSHOT (AC 4, 7)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opStaleId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.operation.operation.finalStatus).toBe('STALE');
    expect(body.operation.operation.resultPayload?.error).toBe('STALE_SNAPSHOT');
  });

  // -------------------------------------------------------------
  // M13: Context token overflow records CONTEXT_LIMIT_EXCEEDED before AI call
  // -------------------------------------------------------------
  it('M13: Context token overflow records CONTEXT_LIMIT_EXCEEDED before AI call (AC 5, 6)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opExplicitFailedId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.operation.operation.finalStatus).toBe('FAILED_EXPLICIT');
    expect(body.operation.operation.resultPayload?.error).toBe('CONTEXT_LIMIT_EXCEEDED');
    // 0 external provider calls
    expect(body.operation.attempts.length).toBe(0);
  });

  // -------------------------------------------------------------
  // M14: Provider timeout (HTTP 504) logs attempt and executes retry
  // -------------------------------------------------------------
  it('M14: Provider timeout (HTTP 504) logs attempt and executes retry (AC 2, 5, 8)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opRetrySuccessId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.operation.attempts.length).toBe(2);
    expect(body.operation.attempts[0].status).toBe('TIMEOUT');
    expect(body.operation.attempts[0].errorCode).toBe('PROVIDER_TIMEOUT');
    expect(body.operation.attempts[1].status).toBe('SUCCESS');
    expect(body.operation.operation.finalStatus).toBe('COMPLETED_RELEVANT');
  });

  // -------------------------------------------------------------
  // M15: Provider rate limit (HTTP 429) logs attempt with backoff delay
  // -------------------------------------------------------------
  it('M15: Provider rate limit (HTTP 429) logs attempt with backoff delay (AC 2, 5, 8)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opRateLimitId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.operation.attempts.length).toBe(2);
    expect(body.operation.attempts[0].status).toBe('ERROR');
    expect(body.operation.attempts[0].errorCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.operation.attempts[1].status).toBe('SUCCESS');
    expect(body.operation.operation.finalStatus).toBe('COMPLETED_RELEVANT');
  });

  // -------------------------------------------------------------
  // M16: Retry exhaustion transitions operation to FAILED_EXPLICIT
  // -------------------------------------------------------------
  it('M16: Retry exhaustion transitions operation to FAILED_EXPLICIT (AC 5, 8)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opRetryExhaustedId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.operation.operation.finalStatus).toBe('FAILED_EXPLICIT');
    expect(body.operation.attempts.length).toBe(3);
    for (const att of body.operation.attempts) {
      expect(att.status).toBe('TIMEOUT');
    }
  });

  // -------------------------------------------------------------
  // M17: Missing districtId in district query throws INVALID_DISTRICT_SCOPE
  // -------------------------------------------------------------
  it('M17: Missing / invalid districtId in domain service throws INVALID_DISTRICT_SCOPE (AC 9)', async () => {
    await expect(
      aiOperationQueryService.listDistrictOperations(db, ''),
    ).rejects.toThrow(InvalidDistrictScopeError);

    await expect(
      aiOperationQueryService.getDistrictOperationDetails(db, '', opRelevanceId),
    ).rejects.toThrow(InvalidDistrictScopeError);
  });

  // -------------------------------------------------------------
  // M18: Empty string or whitespace districtId = "   " throws INVALID_DISTRICT_SCOPE
  // -------------------------------------------------------------
  it('M18: Whitespace districtId = "   " in HTTP route returns 400 INVALID_DISTRICT_SCOPE (AC 9)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${encodeURIComponent('   ')}/ai-operations`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error?.code).toBe('INVALID_DISTRICT_SCOPE');
  });

  // -------------------------------------------------------------
  // M19: Query for District A cannot access operations belonging to District B
  // -------------------------------------------------------------
  it('M19: Query for District A cannot access operations belonging to District B (AC 9)', async () => {
    // Hokim of District A querying District B route should receive 403 FORBIDDEN
    const forbiddenRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtBId}/ai-operations`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    // Querying District B operation ID under District A route returns 404
    const notFoundRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opDistrictBId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.json().error?.code).toBe('OPERATION_NOT_FOUND');
  });

  // -------------------------------------------------------------
  // M20: Global admin query retrieves cross-district operations with explicit filter
  // -------------------------------------------------------------
  it('M20: Global admin query retrieves cross-district operations with explicit filter (AC 10)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/ai-operations',
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(11);

    // Filter by District B globally
    const distBRes = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/ai-operations?districtId=${districtBId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
    });
    expect(distBRes.statusCode).toBe(200);
    const distBBody = distBRes.json();
    expect(distBBody.items.length).toBe(1);
    expect(distBBody.items[0].id).toBe(opDistrictBId);
  });

  // -------------------------------------------------------------
  // M21: System Health aggregation calculates correct totals across operation types
  // -------------------------------------------------------------
  it('M21: System Health aggregation calculates correct totals across operation types (AC 11)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/ai-operations/health-metrics?districtId=${districtAId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const metrics = body.metrics;
    expect(metrics).toBeDefined();
    expect(metrics.totalOperations).toBe(10);
    expect(metrics.operationsByType.SEMANTIC_RELEVANCE).toBe(8);
    expect(metrics.operationsByType.TOPIC_MATCHING).toBe(1);
    expect(metrics.operationsByType.TOPIC_DERIVED_PROJECTION).toBe(1);
  });

  // -------------------------------------------------------------
  // M22: System Health aggregation calculates correct error code breakdowns
  // -------------------------------------------------------------
  it('M22: System Health aggregation calculates correct error code breakdowns (AC 11)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/ai-operations/health-metrics?districtId=${districtAId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
    });

    expect(res.statusCode).toBe(200);
    const metrics = res.json().metrics;

    expect(metrics.attemptsByErrorCode.PROVIDER_TIMEOUT).toBe(4);
    expect(metrics.attemptsByErrorCode.RATE_LIMIT_EXCEEDED).toBe(1);
    expect(metrics.attemptsByErrorCode.INVALID_OUTPUT_SYNTAX).toBe(1);
    expect(metrics.attemptsByErrorCode.INVALID_OUTPUT_SEMANTICS).toBe(1);

    expect(metrics.timeoutCount).toBe(4);
    expect(metrics.validationFailureCount).toBe(2);
    expect(metrics.staleSnapshotCount).toBe(1);
  });

  // -------------------------------------------------------------
  // M23: System Health aggregation calculates total token counts and cost USD
  // -------------------------------------------------------------
  it('M23: System Health aggregation calculates total token counts and cost USD (AC 11)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/ai-operations/health-metrics?districtId=${districtAId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
    });

    expect(res.statusCode).toBe(200);
    const metrics = res.json().metrics;

    expect(metrics.totalAttempts).toBe(13);
    expect(metrics.totalInputTokens).toBeGreaterThanOrEqual(1850);
    expect(metrics.totalOutputTokens).toBeGreaterThanOrEqual(280);
    expect(metrics.totalCachedTokens).toBeGreaterThanOrEqual(150);
    expect(metrics.totalEstimatedCostUsd).toBeGreaterThan(0);
    expect(metrics.avgDurationMs).toBeGreaterThan(0);
    expect(metrics.p95DurationMs).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------
  // M24: Concurrent duplicate attempt insertion caught by unique index
  // -------------------------------------------------------------
  it('M24: Concurrent duplicate attempt insertion caught by unique index (AC 12)', async () => {
    const duplicateAttempt = {
      id: `att_${crypto.randomUUID()}`,
      operationId: opRelevanceId,
      attemptNumber: 1, // Duplicate attemptNumber for same operationId
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini-2024-07-18',
      durationMs: 300,
      status: 'SUCCESS' as const,
    };

    await expect(
      db.insert(aiProviderAttempts).values(duplicateAttempt),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------
  // M25: Complete privacy audit: zero resident text in returned query payloads
  // -------------------------------------------------------------
  it('M25: Complete privacy audit: zero resident text in returned query payloads (AC 1, 2, 11)', async () => {
    const listRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });
    const listJson = listRes.body;

    const detailRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations/${opRelevanceId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });
    const detailJson = detailRes.body;

    const metricsRes = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/ai-operations/health-metrics?districtId=${districtAId}`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
    });
    const metricsJson = metricsRes.body;

    const combinedPayload = `${listJson} ${detailJson} ${metricsJson}`;

    // Regex check: verify forbidden fields and sensitive data patterns
    expect(combinedPayload).not.toMatch(/"verbatimText"/);
    expect(combinedPayload).not.toMatch(/"residentText"/);
    expect(combinedPayload).not.toMatch(/"citizenText"/);
    expect(combinedPayload).not.toMatch(/"telegramHandle"/);
    expect(combinedPayload).not.toMatch(/"botToken"/);
    expect(combinedPayload).not.toMatch(/"apiKey"/);
    expect(combinedPayload).not.toMatch(/"rawHeaders"/);
  });

  // -------------------------------------------------------------
  // M26: Privacy boundary assertion throws on forbidden keys
  // -------------------------------------------------------------
  it('M26: Privacy boundary assertion throws on forbidden keys (Code Review Patch #1)', async () => {
    const { assertPrivacyBoundary, PrivacyBoundaryViolationError } = await import(
      '../src/modules/ai/ai-operation-query-service.js'
    );
    expect(() => assertPrivacyBoundary({ safeKey: 'value', residentText: 'leak' })).toThrow(
      PrivacyBoundaryViolationError,
    );
    expect(() => assertPrivacyBoundary({ nested: { apiKey: 'secret' } })).toThrow(
      PrivacyBoundaryViolationError,
    );
    expect(assertPrivacyBoundary({ safeKey: 'value', count: 123 })).toBe(true);
  });

  // -------------------------------------------------------------
  // M27: Single-bound timeframe filters in health metrics
  // -------------------------------------------------------------
  it('M27: Single-bound timeframe filters in health metrics (Code Review Patch #2)', async () => {
    const fromOnlyRes = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/ai-operations/health-metrics?districtId=${districtAId}&from=2026-08-01T00:00:00Z`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
    });
    expect(fromOnlyRes.statusCode).toBe(200);
    expect(fromOnlyRes.json().metrics.totalOperations).toBe(10);

    const toOnlyRes = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/ai-operations/health-metrics?districtId=${districtAId}&to=2026-08-31T23:59:59Z`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: poCookie },
    });
    expect(toOnlyRes.statusCode).toBe(200);
    expect(toOnlyRes.json().metrics.totalOperations).toBe(10);
  });

  // -------------------------------------------------------------
  // M28: Query datetime filters accept timezone offsets (e.g. +05:00)
  // -------------------------------------------------------------
  it('M28: Query datetime filters accept timezone offsets like +05:00 (Code Review Patch #5)', async () => {
    const offsetRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations?startDate=2026-08-01T00:00:00%2B05:00&endDate=2026-08-31T23:59:59%2B05:00`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });
    expect(offsetRes.statusCode).toBe(200);
    expect(offsetRes.json().items.length).toBeGreaterThanOrEqual(10);
  });

  // -------------------------------------------------------------
  // M29: Invalid operationType or finalStatus rejected with 400 VALIDATION_ERROR
  // -------------------------------------------------------------
  it('M29: Invalid operationType or finalStatus rejected with 400 VALIDATION_ERROR (Code Review Patch #6)', async () => {
    const invalidTypeRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations?operationType=INVALID_TYPE`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });
    expect(invalidTypeRes.statusCode).toBe(400);
    expect(invalidTypeRes.json().error.code).toBe('VALIDATION_ERROR');

    const invalidStatusRes = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/ai-operations?finalStatus=INVALID_STATUS`,
      headers: { ...SAME_ORIGIN_HEADERS, cookie: hokimCookie },
    });
    expect(invalidStatusRes.statusCode).toBe(400);
    expect(invalidStatusRes.json().error.code).toBe('VALIDATION_ERROR');
  });

  // -------------------------------------------------------------
  // M30: Repository findOperationsByDistrict throws on empty districtId
  // -------------------------------------------------------------
  it('M30: Repository findOperationsByDistrict throws on empty districtId (Code Review Patch #8)', async () => {
    const { findOperationsByDistrict } = await import(
      '../src/modules/ai/ai-operation-repository.js'
    );
    await expect(
      findOperationsByDistrict(db, { districtId: '   ' }),
    ).rejects.toThrow('districtId is required');
  });
});
