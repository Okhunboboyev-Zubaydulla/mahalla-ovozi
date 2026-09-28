import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  ComponentHealthObservation,
  OperationalIssuesListResponse,
  OperationalIssueDetailResponse,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import {
  accounts,
  districts,
  operationalIssues,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { hashPassword } from '../src/adapters/crypto/argon2.js';
import { synchronizeOperationalIssues } from '../src/modules/issues/issue-manager.js';
import { eq, and, sql } from 'drizzle-orm';

const SAME_ORIGIN_HEADERS = {
  origin: 'http://localhost:5173',
  host: 'localhost:3000',
};

describe('Story 4.2: Backend Operational Issues Database & HTTP Integration Tests', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let server: FastifyInstance;

  let poCookie = '';
  let hokimCookie = '';
  let districtAId: string;
  let districtBId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    server = await buildHttpServer({ db, pool });
    await server.ready();

    // 1. Seed Product Owner account
    const poUsername = `po_issues_test_${Date.now()}`;
    const poPassword = 'SecurePOPassword2026!';
    await createOrResetProductOwner(db, {
      username: poUsername,
      password: poPassword,
    });

    const poSignInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: {
        'content-type': 'application/json',
        ...SAME_ORIGIN_HEADERS,
      },
      payload: {
        username: poUsername,
        password: poPassword,
      },
    });

    expect(poSignInRes.statusCode).toBe(200);
    const poSetCookie = poSignInRes.headers['set-cookie'];
    poCookie = Array.isArray(poSetCookie) ? poSetCookie[0] || '' : (poSetCookie as string) || '';

    // 2. Seed Hokim account and districts
    const ts = Date.now();
    districtAId = `dist_a_${ts}`;
    districtBId = `dist_b_${ts}`;
    const districtAName = `Чилонзор тумани ${ts}`;
    const districtBName = `Юнусобод тумани ${ts}`;

    await db.insert(districts).values([
      {
        id: districtAId,
        name: districtAName,
        status: 'ACTIVE',
      },
      {
        id: districtBId,
        name: districtBName,
        status: 'ACTIVE',
      },
    ]);

    const hokimUsername = `hokim_issues_test_${Date.now()}`;
    const hokimPassword = 'SecureHokimPassword2026!';
    const hokimPasswordHash = await hashPassword(hokimPassword);

    await db.insert(accounts).values({
      id: `acc_hokim_${Date.now()}`,
      username: hokimUsername,
      passwordHash: hokimPasswordHash,
      role: 'DISTRICT_HOKIM',
      districtId: districtAId,
      status: 'ACTIVE',
      mustChangePassword: false,
    });

    const hokimSignInRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: {
        'content-type': 'application/json',
        ...SAME_ORIGIN_HEADERS,
      },
      payload: {
        username: hokimUsername,
        password: hokimPassword,
      },
    });

    expect(hokimSignInRes.statusCode).toBe(200);
    const hokimSetCookie = hokimSignInRes.headers['set-cookie'];
    hokimCookie = Array.isArray(hokimSetCookie) ? hokimSetCookie[0] || '' : (hokimSetCookie as string) || '';
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  function createObs(
    component: ComponentHealthObservation['component'],
    status: ComponentHealthObservation['status'],
    districtId: string | null = districtAId,
  ): ComponentHealthObservation {
    const scope = districtId ? 'DISTRICT' : 'GLOBAL';
    return {
      component,
      scope,
      districtId,
      status,
      lastCheckAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      outcome: status === 'Unavailable' || status === 'Degraded' ? 'failure' : 'success',
      errorCode: status === 'Unavailable' ? 'TEST_ERROR_CODE' : null,
      errorMessage: status === 'Unavailable' ? 'Sanitized failure message' : null,
      latencyMs: 15,
      isApplicable: true,
      lifecycleStatus: 'ACTIVE',
    };
  }

  describe('1. Atomic Failure-Start State + Audit Persistence (AC 1, AC 10, AC 13)', () => {
    it('creates active issue and failure-start audit event atomically in one transaction', async () => {
      const obs = createObs('telegram_bot', 'Unavailable', districtAId);
      const districtMap = new Map([[districtAId, 'Чилонзор тумани']]);

      const syncResult = await synchronizeOperationalIssues(db, [obs], {
        districtMap,
        evaluationScope: { type: 'DISTRICT', districtId: districtAId },
      });

      expect(syncResult.created).toBe(1);

      // Verify operational_issues record
      const [issue] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtAId),
            eq(operationalIssues.component, 'telegram_bot'),
            eq(operationalIssues.status, 'ACTIVE'),
          ),
        );

      expect(issue).toBeDefined();
      if (!issue) throw new Error('Issue not found');
      expect(issue.severity).toBe('Critical');
      expect(issue.sanitizedTitle).toContain('Telegram бот');
      expect(issue.targetRoute).toBe(`/telegram-setup?districtId=${districtAId}`);

      // Verify audit_events record
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'OPERATIONAL_ISSUE_DETECTED'),
            eq(auditEvents.actorId, 'system:health-monitor'),
            eq(auditEvents.actorRole, 'SYSTEM'),
            sql`${auditEvents.metadata}->>'issueId' = ${issue.id}`,
          ),
        );

      expect(auditRows.length).toBe(1);
      expect(auditRows[0]?.metadata).toMatchObject({
        issueId: issue.id,
        logicalKey: issue.logicalKey,
        severity: 'Critical',
      });
    });
  });

  describe('2. Continuing Health Checks & Audit Deduplication (AC 6)', () => {
    it('updates latestCheckAt without appending duplicate failure audit records', async () => {
      const obs = createObs('telegram_bot', 'Unavailable', districtAId);
      const districtMap = new Map([[districtAId, 'Чилонзор тумани']]);

      const [initialIssue] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtAId),
            eq(operationalIssues.component, 'telegram_bot'),
            eq(operationalIssues.status, 'ACTIVE'),
          ),
        );

      expect(initialIssue).toBeDefined();
      if (!initialIssue) throw new Error('Initial issue not found');

      const initialCheckTime = initialIssue.latestCheckAt;

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 50));

      const syncResult = await synchronizeOperationalIssues(db, [obs], {
        districtMap,
        evaluationScope: { type: 'DISTRICT', districtId: districtAId },
      });

      expect(syncResult.updated).toBe(1);
      expect(syncResult.created).toBe(0);

      const [refreshedIssue] = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.id, initialIssue.id));

      expect(refreshedIssue).toBeDefined();
      if (!refreshedIssue) throw new Error('Refreshed issue not found');
      expect(refreshedIssue.startedAt.toISOString()).toBe(initialIssue.startedAt.toISOString());
      expect(refreshedIssue.latestCheckAt.getTime()).toBeGreaterThanOrEqual(initialCheckTime.getTime());

      // Confirm no additional audit events were emitted
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'OPERATIONAL_ISSUE_DETECTED'),
            sql`${auditEvents.metadata}->>'issueId' = ${initialIssue.id}`,
          ),
        );

      expect(auditRows.length).toBe(1);
    });
  });

  describe('3. Matching-Scope Verified Recovery & Idempotency (AC 8, AC 9, AC 11)', () => {
    it('unrelated check for another district does NOT resolve active issue (AC 8)', async () => {
      // Check district B as Healthy
      const healthyDistrictBObs = createObs('telegram_bot', 'Healthy', districtBId);
      const districtMap = new Map([
        [districtAId, 'Чилонзор'],
        [districtBId, 'Юнусобод'],
      ]);

      await synchronizeOperationalIssues(db, [healthyDistrictBObs], {
        districtMap,
        evaluationScope: { type: 'DISTRICT', districtId: districtBId },
      });

      // District A issue must still be ACTIVE
      const [issueA] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtAId),
            eq(operationalIssues.component, 'telegram_bot'),
          ),
        );

      expect(issueA).toBeDefined();
      if (!issueA) throw new Error('issueA not found');
      expect(issueA.status).toBe('ACTIVE');
    });

    it('stale/Unknown state does NOT falsely mark active issue as recovered (AC 7)', async () => {
      const unknownObs = createObs('telegram_bot', 'Unknown', districtAId);
      const districtMap = new Map([[districtAId, 'Чилонзор']]);

      await synchronizeOperationalIssues(db, [unknownObs], {
        districtMap,
        evaluationScope: { type: 'DISTRICT', districtId: districtAId },
      });

      const [issueA] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtAId),
            eq(operationalIssues.component, 'telegram_bot'),
          ),
        );

      expect(issueA).toBeDefined();
      if (!issueA) throw new Error('issueA not found');
      expect(issueA.status).toBe('ACTIVE');
    });

    it('matching Healthy check transitions issue to RESOLVED and logs audit event (AC 9, AC 11)', async () => {
      const healthyObs = createObs('telegram_bot', 'Healthy', districtAId);
      const districtMap = new Map([[districtAId, 'Чилонзор']]);

      const syncResult = await synchronizeOperationalIssues(db, [healthyObs], {
        districtMap,
        evaluationScope: { type: 'DISTRICT', districtId: districtAId },
      });

      expect(syncResult.resolved).toBe(1);

      const [resolvedIssue] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtAId),
            eq(operationalIssues.component, 'telegram_bot'),
          ),
        );

      expect(resolvedIssue).toBeDefined();
      if (!resolvedIssue) throw new Error('resolvedIssue not found');
      expect(resolvedIssue.status).toBe('RESOLVED');
      expect(resolvedIssue.resolvedAt).toBeDefined();

      // Check recovery audit event
      const recoveryAuditRows = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'OPERATIONAL_ISSUE_RESOLVED'),
            eq(auditEvents.actorId, 'system:health-monitor'),
            sql`${auditEvents.metadata}->>'issueId' = ${resolvedIssue.id}`,
          ),
        );

      expect(recoveryAuditRows.length).toBe(1);
      expect(recoveryAuditRows[0]?.metadata).toMatchObject({
        issueId: resolvedIssue.id,
        logicalKey: resolvedIssue.logicalKey,
      });
    });
  });

  describe('4. Genuine Recurrence Starts New Distinct Lifecycle (AC 12)', () => {
    it('creates a new distinct issue record with its own ID and audit event upon genuine recurrence', async () => {
      const newFailureObs = createObs('telegram_bot', 'Unavailable', districtAId);
      const districtMap = new Map([[districtAId, 'Чилонзор']]);

      const syncResult = await synchronizeOperationalIssues(db, [newFailureObs], {
        districtMap,
        evaluationScope: { type: 'DISTRICT', districtId: districtAId },
      });

      expect(syncResult.created).toBe(1);

      const allBotIssues = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtAId),
            eq(operationalIssues.component, 'telegram_bot'),
          ),
        );

      expect(allBotIssues.length).toBe(2);
      const resolvedList = allBotIssues.filter((i) => i.status === 'RESOLVED');
      const activeList = allBotIssues.filter((i) => i.status === 'ACTIVE');

      expect(resolvedList.length).toBe(1);
      expect(activeList.length).toBe(1);
      expect(activeList[0]?.id).not.toBe(resolvedList[0]?.id);
    });
  });

  describe('5. HTTP API Endpoints & Product Owner Security (AC 3, AC 4, AC 5, AC 13)', () => {
    let activeIssueId: string;

    beforeAll(async () => {
      const [activeIssue] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtAId),
            eq(operationalIssues.status, 'ACTIVE'),
          ),
        );
      if (!activeIssue) throw new Error('Active issue not found');
      activeIssueId = activeIssue.id;
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/issues',
        headers: SAME_ORIGIN_HEADERS,
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects Hokim role requests with 403 (Product Owner only endpoint)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/issues',
        headers: {
          cookie: hokimCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('GET /api/v1/issues returns 200 with sorted operational issues for Product Owner', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/issues',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<OperationalIssuesListResponse>();

      expect(body.issues).toBeDefined();
      expect(Array.isArray(body.issues)).toBe(true);
      expect(body.totalActive).toBeGreaterThanOrEqual(1);
      expect(body.criticalCount).toBeGreaterThanOrEqual(1);

      const foundIssue = body.issues.find((i) => i.id === activeIssueId);
      expect(foundIssue).toBeDefined();
      expect(foundIssue?.districtName).toContain('Чилонзор тумани');
      expect(foundIssue?.targetRoute).toBe(`/telegram-setup?districtId=${districtAId}`);

      // Privacy boundary check: no bot tokens or passwords
      const rawText = JSON.stringify(body);
      expect(rawText).not.toContain('SecurePOPassword2026!');
      expect(rawText).not.toContain('bot_token_secret');
    });

    it('GET /api/v1/issues respects limit and offset pagination parameters', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/issues?limit=1&offset=0',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<OperationalIssuesListResponse>();
      expect(body.issues.length).toBeLessThanOrEqual(1);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(0);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/v1/issues/:issueId returns issue detail and audit timeline', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/issues/${activeIssueId}`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<OperationalIssueDetailResponse>();

      expect(body.issue).toBeDefined();
      expect(body.issue.id).toBe(activeIssueId);
      expect(body.auditEvents).toBeDefined();
      expect(body.auditEvents.length).toBeGreaterThanOrEqual(1);
      expect(body.auditEvents[0]?.action).toBe('OPERATIONAL_ISSUE_DETECTED');
    });

    it('GET /api/v1/issues/:issueId returns 404 for non-existent issue', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/issues/non_existent_issue_id',
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });

    it('GET /api/v1/districts/:districtId/issues returns only that district issues', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/issues`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<OperationalIssuesListResponse>();

      expect(body.issues.every((i) => i.districtId === districtAId)).toBe(true);
    });

    it('GET /api/v1/districts/:districtId/issues returns 400 for invalid query parameters', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/districts/${districtAId}/issues?status=INVALID_STATUS`,
        headers: {
          cookie: poCookie,
          ...SAME_ORIGIN_HEADERS,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });
  });


  describe('6. Health-Sync Auto-Resolve Boundary (L6-P01-08)', () => {
    // Each family is its own test case, so coverage is per-family, not inferred from one loop.
    const FAMILIES: Array<[string, string]> = [
      ['del_backup_fail:', 'BACKUP_EXPIRY_DELAY'],
      ['del_sync_fail:', 'STORAGE_UNAVAILABLE'],
      ['del_fail:', 'LIFECYCLE_DELETION'],
      ['disaster_restore_reconciliation_failure', 'DISASTER_RECOVERY'],
    ];

    // These rows are inserted ACTIVE and the assertions require them to STAY active, so they
    // must be removed explicitly. Leaving the `disaster_restore_reconciliation_failure` row
    // behind makes the readiness probe (health-routes.ts:69) report 'down' for every later
    // test in the run, which is exactly the cross-suite pollution this cleanup prevents.
    const insertedIssueIds: string[] = [];

    afterAll(async () => {
      for (const issueId of insertedIssueIds) {
        await db.delete(operationalIssues).where(eq(operationalIssues.id, issueId));
      }
    });

    it.each(FAMILIES)(
      'does NOT resolve a %s lifecycle issue on a Healthy scheduled_deletion probe',
      async (keyPrefix, issueCategory) => {
        const ts = Date.now();
        const now = new Date();
        const logicalKey = keyPrefix.slice(-1) === ':' ? keyPrefix + ts : keyPrefix;
        const issueId = 'iss_l6_' + ts + '_' + crypto.randomUUID().slice(0, 8);

        await db.insert(operationalIssues).values({
          id: issueId,
          logicalKey,
          scope: 'GLOBAL',
          districtId: null,
          component: 'scheduled_deletion',
          issueCategory: issueCategory,
          severity: 'Critical',
          status: 'ACTIVE',
          healthStatus: 'UNAVAILABLE',
          sanitizedTitle: 'Lifecycle issue',
          sanitizedDescription: 'Lifecycle issue description',
          recommendedAction: 'Test action',
          targetRoute: null,
          metadata: {},
          startedAt: now,
          latestCheckAt: now,
          resolvedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        insertedIssueIds.push(issueId);

        const healthyProbe = createObs('scheduled_deletion', 'Healthy', null);
        await synchronizeOperationalIssues(db, [healthyProbe], {
          evaluationScope: { type: 'SYSTEM' },
        });

        const [row] = await db
          .select()
          .from(operationalIssues)
          .where(eq(operationalIssues.id, issueId))
          .limit(1);

        expect(row).toBeDefined();
        if (!row) throw new Error('Row not found: ' + logicalKey);
        expect(row.status).toBe('ACTIVE');
      },
    );
  });

});
