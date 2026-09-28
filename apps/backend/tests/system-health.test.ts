import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import crypto from 'node:crypto';
import {
  ComponentHealthObservation,
  DistrictHealthSummary,
  HealthStatus,
  OverallSystemHealthResponse,
  DistrictHealthResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createBossClient, initBossQueues } from '../src/adapters/jobs/boss-client.js';
import type PgBoss from 'pg-boss';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { accounts, districts, districtDeletionRecords } from '../src/adapters/db/schema/index.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import {
  HEALTH_STATE_PRECEDENCE,
  aggregateComponentStatuses,
  aggregateOverallSystemHealth,
  evaluateFreshness,
  evaluateThreshold,
  STALE_CHECK_THRESHOLD_MS,
  INTAKE_DELAY_THRESHOLD_MS,
  TOPIC_DELAY_THRESHOLD_MS,
} from '../src/modules/health/health-evaluator.js';
import { checkScheduledDeletionHealth } from '../src/modules/health/health-checker.js';
import { InMemoryExternalTombstoneStore } from '../src/adapters/storage/external-tombstone-store.js';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 4.1: Health Evaluator Pure Engine Tests', () => {
  const now = new Date('2026-08-25T12:00:00.000Z');
  const freshTime = new Date('2026-08-25T11:55:00.000Z').toISOString();
  const olderFreshTime = new Date('2026-08-25T11:52:00.000Z').toISOString();
  const oldestFreshTime = new Date('2026-08-25T11:51:00.000Z').toISOString();
  const staleTime = new Date('2026-08-25T11:45:00.000Z').toISOString(); // 15m ago (>10m)

  function createObs(
    component: ComponentHealthObservation['component'],
    status: HealthStatus,
    options: Partial<ComponentHealthObservation> = {},
  ): ComponentHealthObservation {
    return {
      component,
      scope: options.scope || 'DISTRICT',
      districtId: options.districtId !== undefined ? options.districtId : 'dist-1',
      status,
      lastCheckAt: options.lastCheckAt || freshTime,
      checkedAt: options.checkedAt || freshTime,
      outcome: options.outcome || (status === 'Unavailable' || status === 'Degraded' ? 'failure' : 'success'),
      errorCode: options.errorCode || null,
      errorMessage: options.errorMessage || null,
      latencyMs: options.latencyMs !== undefined ? options.latencyMs : 25,
      isApplicable: options.isApplicable !== undefined ? options.isApplicable : true,
      lifecycleStatus: options.lifecycleStatus || 'ACTIVE',
    };
  }

  describe('1. Deterministic Precedence Rules (AC 5)', () => {
    it('enforces Unavailable > Degraded > Delayed > Unknown > Healthy', () => {
      expect(HEALTH_STATE_PRECEDENCE).toEqual([
        'Unavailable',
        'Degraded',
        'Delayed',
        'Unknown',
        'Healthy',
      ]);

      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Healthy'),
        createObs('telegram_groups', 'Delayed'),
        createObs('message_intake', 'Degraded'),
        createObs('ai_operations', 'Unknown'),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.status).toBe('Degraded');
    });

    it('ranks Unavailable above Degraded and Delayed', () => {
      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Unavailable'),
        createObs('telegram_groups', 'Degraded'),
        createObs('message_intake', 'Delayed'),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.status).toBe('Unavailable');
    });

    it('ranks Delayed above Unknown and Healthy', () => {
      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Healthy'),
        createObs('telegram_groups', 'Delayed'),
        createObs('message_intake', 'Unknown'),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.status).toBe('Delayed');
    });
  });

  describe('2. Required Child Unknown Propagation (AC 5)', () => {
    it('forces Unknown aggregate when a required component is Unknown and no stronger abnormal state exists', () => {
      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Healthy'),
        createObs('telegram_groups', 'Healthy'),
        createObs('message_intake', 'Unknown'),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.status).toBe('Unknown');
    });

    it('does NOT force Unknown if a stronger abnormal state like Degraded exists', () => {
      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Degraded'),
        createObs('telegram_groups', 'Healthy'),
        createObs('message_intake', 'Unknown'),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.status).toBe('Degraded');
    });
  });

  describe('3. Quiet Neutrality & All-Quiet Aggregation Rules (AC 5, AC 6)', () => {
    it('aggregates Healthy + Quiet to Healthy for a district', () => {
      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Healthy'),
        createObs('telegram_groups', 'Quiet'),
        createObs('message_intake', 'Quiet'),
        createObs('ai_operations', 'Healthy'),
        createObs('district_retention', 'Healthy'),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.status).toBe('Healthy');
    });

    it('aggregates to Quiet when all applicable intake sources are Quiet and technical components are Healthy', () => {
      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Healthy'),
        createObs('telegram_groups', 'Quiet'),
        createObs('message_intake', 'Quiet'),
        createObs('ai_operations', 'Quiet'),
        createObs('district_retention', 'Healthy'),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.status).toBe('Quiet');
    });

    it('aggregates overall system health to Quiet ONLY when all districts are Quiet and global components are Healthy', () => {
      const globalComponents: ComponentHealthObservation[] = [
        createObs('database', 'Healthy', { scope: 'GLOBAL', districtId: null }),
        createObs('processing_queue', 'Healthy', { scope: 'GLOBAL', districtId: null }),
        createObs('storage', 'Healthy', { scope: 'GLOBAL', districtId: null }),
        createObs('web_application', 'Healthy', { scope: 'GLOBAL', districtId: null }),
        createObs('retention_jobs', 'Healthy', { scope: 'GLOBAL', districtId: null }),
      ];

      const districtSummaries: DistrictHealthSummary[] = [
        {
          districtId: 'dist-1',
          districtName: 'Chilonzor',
          status: 'Quiet',
          lastCheckAt: freshTime,
          components: [],
          lifecycleStatus: 'ACTIVE',
        },
        {
          districtId: 'dist-2',
          districtName: 'Yunusobod',
          status: 'Quiet',
          lastCheckAt: freshTime,
          components: [],
          lifecycleStatus: 'ACTIVE',
        },
      ];

      const result = aggregateOverallSystemHealth(globalComponents, districtSummaries, now);
      expect(result.status).toBe('Quiet');
    });

    it('aggregates a mix of Healthy and Quiet districts to Healthy overall system health', () => {
      const globalComponents: ComponentHealthObservation[] = [
        createObs('database', 'Healthy', { scope: 'GLOBAL', districtId: null }),
        createObs('processing_queue', 'Healthy', { scope: 'GLOBAL', districtId: null }),
        createObs('storage', 'Healthy', { scope: 'GLOBAL', districtId: null }),
        createObs('web_application', 'Healthy', { scope: 'GLOBAL', districtId: null }),
        createObs('retention_jobs', 'Healthy', { scope: 'GLOBAL', districtId: null }),
      ];

      const districtSummaries: DistrictHealthSummary[] = [
        {
          districtId: 'dist-1',
          districtName: 'Chilonzor',
          status: 'Healthy',
          lastCheckAt: freshTime,
          components: [],
          lifecycleStatus: 'ACTIVE',
        },
        {
          districtId: 'dist-2',
          districtName: 'Yunusobod',
          status: 'Quiet',
          lastCheckAt: freshTime,
          components: [],
          lifecycleStatus: 'ACTIVE',
        },
      ];

      const result = aggregateOverallSystemHealth(globalComponents, districtSummaries, now);
      expect(result.status).toBe('Healthy');
    });
  });

  describe('4. Oldest Contributing lastCheckAt Rule (AC 13)', () => {
    it('derives lastCheckAt as the oldest timestamp among contributing required components', () => {
      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Healthy', { lastCheckAt: freshTime }),
        createObs('telegram_groups', 'Healthy', { lastCheckAt: olderFreshTime }),
        createObs('message_intake', 'Healthy', { lastCheckAt: oldestFreshTime }),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.lastCheckAt).toBe(oldestFreshTime);
    });

    it('ignores non-applicable components when computing oldest lastCheckAt', () => {
      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Healthy', { lastCheckAt: freshTime }),
        createObs('telegram_groups', 'Healthy', { lastCheckAt: olderFreshTime }),
        createObs('message_intake', 'Healthy', {
          lastCheckAt: staleTime,
          isApplicable: false,
        }),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.lastCheckAt).toBe(olderFreshTime);
    });
  });

  describe('5. Non-Applicable Component Exclusion (AC 10)', () => {
    it('excludes non-applicable components from influencing the aggregate status', () => {
      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Healthy'),
        createObs('telegram_groups', 'Healthy'),
        createObs('ai_operations', 'Unavailable', { isApplicable: false }),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.status).toBe('Healthy');
    });

    it('returns Unknown when all components are non-applicable', () => {
      const components: ComponentHealthObservation[] = [
        createObs('telegram_bot', 'Healthy', { isApplicable: false }),
        createObs('telegram_groups', 'Healthy', { isApplicable: false }),
      ];

      const result = aggregateComponentStatuses(components, { isQuietAllowed: true });
      expect(result.status).toBe('Unknown');
    });
  });

  describe('6. Zero-Districts State Handling (AC 11)', () => {
    it('evaluates overall health purely from global components without synthetic district', () => {
      const globalComponents: ComponentHealthObservation[] = [
        createObs('database', 'Healthy', { scope: 'GLOBAL', districtId: null, lastCheckAt: oldestFreshTime }),
        createObs('processing_queue', 'Healthy', { scope: 'GLOBAL', districtId: null, lastCheckAt: freshTime }),
        createObs('storage', 'Healthy', { scope: 'GLOBAL', districtId: null, lastCheckAt: freshTime }),
        createObs('web_application', 'Healthy', { scope: 'GLOBAL', districtId: null, lastCheckAt: freshTime }),
        createObs('retention_jobs', 'Healthy', { scope: 'GLOBAL', districtId: null, lastCheckAt: freshTime }),
      ];

      const result = aggregateOverallSystemHealth(globalComponents, [], now);
      expect(result.status).toBe('Healthy');
      expect(result.districts).toEqual([]);
      expect(result.totalDistricts).toBe(0);
      expect(result.activeDistricts).toBe(0);
      expect(result.lastCheckAt).toBe(oldestFreshTime);
    });
  });

  describe('7. Threshold & Freshness Evaluators (AC 7, AC 8)', () => {
    it('evaluates check freshness (<10m fresh, >10m stale)', () => {
      expect(evaluateFreshness(freshTime, STALE_CHECK_THRESHOLD_MS, now)).toBe(true);
      expect(evaluateFreshness(staleTime, STALE_CHECK_THRESHOLD_MS, now)).toBe(false);
      expect(evaluateFreshness(null, STALE_CHECK_THRESHOLD_MS, now)).toBe(false);
    });

    it('evaluates 5-minute intake delay threshold', () => {
      const within4Min = new Date('2026-08-25T11:56:00.000Z').toISOString();
      const over6Min = new Date('2026-08-25T11:53:00.000Z').toISOString();

      expect(evaluateThreshold(within4Min, INTAKE_DELAY_THRESHOLD_MS, now)).toBe('Healthy');
      expect(evaluateThreshold(over6Min, INTAKE_DELAY_THRESHOLD_MS, now)).toBe('Delayed');
      expect(evaluateThreshold(null, INTAKE_DELAY_THRESHOLD_MS, now)).toBe('Healthy');
    });

    it('evaluates 15-minute topic delay threshold', () => {
      const within12Min = new Date('2026-08-25T11:48:00.000Z').toISOString();
      const over16Min = new Date('2026-08-25T11:43:00.000Z').toISOString();

      expect(evaluateThreshold(within12Min, TOPIC_DELAY_THRESHOLD_MS, now)).toBe('Healthy');
      expect(evaluateThreshold(over16Min, TOPIC_DELAY_THRESHOLD_MS, now)).toBe('Delayed');
    });
  });

  describe('8. Scheduled Deletion Health Checker (AC 3, AC 6)', () => {
    it('returns Unavailable when pg-boss instance is not provided', async () => {
      const obs = await checkScheduledDeletionHealth(undefined);
      expect(obs.component).toBe('scheduled_deletion');
      expect(obs.scope).toBe('GLOBAL');
      expect(obs.status).toBe('Unavailable');
      expect(obs.errorCode).toBe('QUEUE_NOT_CONFIGURED');
    });

    it('returns Healthy when pg-boss is running with 0 scheduled deletion jobs (Epic 6 decoupled baseline)', async () => {
      const mockBoss = {
        getSchedules: async () => [],
      } as unknown as PgBoss;

      const obs = await checkScheduledDeletionHealth(mockBoss);
      expect(obs.component).toBe('scheduled_deletion');
      expect(obs.scope).toBe('GLOBAL');
      expect(obs.status).toBe('Healthy');
      expect(obs.outcome).toBe('success');
    });

    it('returns Unavailable with error details when getSchedules rejects or times out', async () => {
      const mockBoss = {
        getSchedules: async () => {
          throw new Error('Connection refused to scheduler backend');
        },
      } as unknown as PgBoss;

      const obs = await checkScheduledDeletionHealth(mockBoss);
      expect(obs.component).toBe('scheduled_deletion');
      expect(obs.status).toBe('Unavailable');
      expect(obs.errorCode).toBe('SCHEDULED_DELETION_PROBE_ERROR');
      expect(obs.errorMessage).toBe('Режалаштирилган ўчириш тизими текширувида хатолик юз берди: Connection refused to scheduler backend');
    });
  });
});

describe('Story 4.1: Backend Health HTTP Routes & Security Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;
  let boss: PgBoss;

  let poCookie = '';
  let hokimCookie = '';
  let districtAId: string;
  let districtBId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient({ schema: 'pgboss_system_health' });
    await boss.start();
    await initBossQueues(boss);

    server = await buildHttpServer({
      db,
      pool,
      boss,
      tombstoneStore: new InMemoryExternalTombstoneStore(),
    });
    await server.ready();

    // Clean any leftover deletion records in test DB
    await db.delete(districtDeletionRecords);

    // 1. Seed Product Owner
    const poUsername = `po_health_test_${Date.now()}`;
    const poPassword = 'SecurePOPassword2026!';
    await createOrResetProductOwner(db, {
      username: poUsername,
      password: poPassword,
    });

    const poSignInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: { username: poUsername, password: poPassword },
    });

    const poCookieHeader = poSignInRes.headers['set-cookie'];
    if (typeof poCookieHeader === 'string') {
      poCookie = poCookieHeader.split(';')[0] || '';
    } else if (Array.isArray(poCookieHeader) && poCookieHeader[0]) {
      poCookie = poCookieHeader[0].split(';')[0] || '';
    }

    // 2. Seed Districts
    districtAId = `dist_health_a_${crypto.randomUUID().slice(0, 8)}`;
    districtBId = `dist_health_b_${crypto.randomUUID().slice(0, 8)}`;

    await db.insert(districts).values([
      {
        id: districtAId,
        name: `Chilonzor Health ${Date.now()}`,
        status: 'ACTIVE',
      },
      {
        id: districtBId,
        name: `Yunusobod Health ${Date.now()}`,
        status: 'SUSPENDED',
      },
    ]);

    // 3. Seed District A Hokim Account
    const hokimUsername = `hokim_health_${Date.now()}`;
    const hokimPassword = 'HokimPassword2026!';
    const passwordHash = await hashPassword(hokimPassword);

    await db.insert(accounts).values({
      id: `acc_hokim_${crypto.randomUUID().slice(0, 8)}`,
      username: hokimUsername,
      passwordHash,
      role: 'DISTRICT_HOKIM',
      districtId: districtAId,
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    const hokimSignInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: SAME_ORIGIN_HEADERS,
      payload: { username: hokimUsername, password: hokimPassword },
    });

    const hokimCookieHeader = hokimSignInRes.headers['set-cookie'];
    if (typeof hokimCookieHeader === 'string') {
      hokimCookie = hokimCookieHeader.split(';')[0] || '';
    } else if (Array.isArray(hokimCookieHeader) && hokimCookieHeader[0]) {
      hokimCookie = hokimCookieHeader[0].split(';')[0] || '';
    }
  });

  afterAll(async () => {
    await server.close();
    await boss.stop();
    await pool.end();
  });

  it('1. GET /api/v1/health/system returns 200 with truthful overall and district health for PO (AC 1)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/health/system',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body: OverallSystemHealthResponse = JSON.parse(res.payload);

    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('lastCheckAt');
    expect(body).toHaveProperty('evaluatedAt');
    expect(body).toHaveProperty('globalComponents');
    expect(body).toHaveProperty('districts');
    expect(Array.isArray(body.globalComponents)).toBe(true);
    expect(Array.isArray(body.districts)).toBe(true);
    expect(body.globalComponents.length).toBe(6);

    // Verify all 6 global component types (AC 1)
    const globalTypes = body.globalComponents.map((c) => c.component);
    expect(globalTypes).toContain('database');
    expect(globalTypes).toContain('processing_queue');
    expect(globalTypes).toContain('storage');
    expect(globalTypes).toContain('web_application');
    expect(globalTypes).toContain('retention_jobs');
    expect(globalTypes).toContain('scheduled_deletion');

    // Verify scheduled_deletion operational health is Healthy (AC 3)
    const scheduledDel = body.globalComponents.find((c) => c.component === 'scheduled_deletion');
    expect(scheduledDel).toBeDefined();
    expect(scheduledDel?.status).toBe('Healthy');

    // Verify district items exist
    const distA = body.districts.find((d) => d.districtId === districtAId);
    expect(distA).toBeDefined();
    expect(distA?.lifecycleStatus).toBe('ACTIVE');

    const distB = body.districts.find((d) => d.districtId === districtBId);
    expect(distB).toBeDefined();
    expect(distB?.lifecycleStatus).toBe('SUSPENDED');
  });

  it('2. GET /api/v1/health/system rejects unauthenticated or Hokim requests (AC 1)', async () => {
    // Unauthenticated
    const unauthRes = await server.inject({
      method: 'GET',
      url: '/api/v1/health/system',
      headers: SAME_ORIGIN_HEADERS,
    });
    expect(unauthRes.statusCode).toBe(401);

    // Hokim (Product Owner only endpoint)
    const hokimRes = await server.inject({
      method: 'GET',
      url: '/api/v1/health/system',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: hokimCookie,
      },
    });
    expect(hokimRes.statusCode).toBe(403);
  });

  it('3. GET /api/v1/districts/:districtId/health returns 200 with district-scoped health (AC 1, AC 12)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/districts/${districtAId}/health`,
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body: DistrictHealthResponse = JSON.parse(res.payload);

    expect(body.districtId).toBe(districtAId);
    expect(body.lifecycleStatus).toBe('ACTIVE');
    expect(Array.isArray(body.components)).toBe(true);

    const componentTypes = body.components.map((c) => c.component);
    expect(componentTypes).toContain('telegram_bot');
    expect(componentTypes).toContain('telegram_groups');
    expect(componentTypes).toContain('message_intake');
    expect(componentTypes).toContain('ai_operations');
    expect(componentTypes).toContain('district_retention');
  });

  it('4. GET /api/v1/districts/:districtId/health returns 404 for nonexistent district', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/districts/nonexistent-district-id/health',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('5. Privacy boundary: Zero tokens, credentials, or raw stack traces leak into health response (AC 2, AC 14)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/health/system',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: poCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const rawPayload = res.payload;

    // Check that no Telegram bot tokens appear in payload
    expect(rawPayload).not.toMatch(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/);
    // Check that no Postgres connection credentials appear
    expect(rawPayload).not.toContain('mahalla_dev_password');
    // Check that no raw stack traces appear
    expect(rawPayload).not.toContain('    at ');
  });

  it('6. Public Liveness Probe: GET /api/v1/health/live returns 200 without auth (AC 4)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/health/live',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('timestamp');
  });

  it('7. Public Readiness Probe: GET /api/v1/health/ready returns 200 with dependency status without auth (AC 4)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ready');
    expect(body.checks).toEqual({
      database: 'ok',
      queue: 'ok',
      restoreReconciliation: 'ok',
    });
    expect(body).toHaveProperty('timestamp');
  });

  it('8. Public Summary Probe: GET /api/v1/health returns 200 without auth (AC 4)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('Healthy');
    expect(body).toHaveProperty('timestamp');
  });
});
