import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient, DbTransaction } from '../src/adapters/db/client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import { districts, operationalIssues } from '../src/adapters/db/schema/index.js';
import { createIssuesDataCleaner } from '../src/modules/issues/issues-data-cleaner.js';

describe('createIssuesDataCleaner', () => {
  let pool: pg.Pool;
  let db: DbClient;

  beforeAll(async () => {
    await runMigrations();
    pool = createDbPool();
    db = createDbClient(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seedIssuesForDistrict(tag: string) {
    const districtId = `dist_iss_${tag}_${Date.now()}`;
    const now = new Date();

    await db.insert(districts).values({
      id: districtId,
      name: `Issues Clean ${districtId}`,
      region: 'Toshkent',
      status: 'CANCELLED',
    });

    const issueId = `iss_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(operationalIssues).values({
      id: issueId,
      logicalKey: `issue_${districtId}`,
      scope: 'DISTRICT',
      districtId,
      component: 'TELEGRAM_INTAKE',
      issueCategory: 'CONNECTIVITY',
      severity: 'Critical',
      status: 'ACTIVE',
      healthStatus: 'DEGRADED',
      sanitizedTitle: 'Test issue',
      sanitizedDescription: 'Test issue description',
      recommendedAction: 'Check bot token',
      startedAt: now,
      latestCheckAt: now,
    });

    // Also seed a del_fail global issue to verify the issues cleaner does NOT delete it (ADR-001 D-1)
    const delFailId = `iss_delfail_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(operationalIssues).values({
      id: delFailId,
      logicalKey: `del_fail:${districtId}`,
      scope: 'GLOBAL',
      districtId: null,
      component: 'SUBSCRIPTIONS',
      issueCategory: 'LIFECYCLE_DELETION',
      severity: 'Critical',
      status: 'ACTIVE',
      healthStatus: 'DEGRADED',
      sanitizedTitle: 'Deletion failed',
      sanitizedDescription: 'Deletion failed description',
      recommendedAction: 'Retry deletion',
      startedAt: now,
      latestCheckAt: now,
    });

    return { districtId, issueId, delFailId };
  }

  it('deletes district-scoped issues but leaves del_fail global issues intact', async () => {
    const { districtId, delFailId } = await seedIssuesForDistrict('a');

    const issuesBefore = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.districtId, districtId));
    expect(issuesBefore).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createIssuesDataCleaner().deleteDistrictData(tx, districtId);
    });

    const issuesAfter = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.districtId, districtId));
    expect(issuesAfter).toHaveLength(0);

    // del_fail issue must NOT be deleted by issues cleaner
    const delFailAfter = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.id, delFailId));
    expect(delFailAfter).toHaveLength(1);

    // Clean up del_fail issue
    await db.delete(operationalIssues).where(eq(operationalIssues.id, delFailId));
  });

  it('does not delete issues belonging to other districts', async () => {
    const { districtId: districtA, delFailId: dfA } = await seedIssuesForDistrict('b1');
    const { districtId: districtB, delFailId: dfB } = await seedIssuesForDistrict('b2');

    await db.transaction(async (tx: DbTransaction) => {
      await createIssuesDataCleaner().deleteDistrictData(tx, districtA);
    });

    const issuesB = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.districtId, districtB));
    expect(issuesB).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createIssuesDataCleaner().deleteDistrictData(tx, districtB);
    });

    await db.delete(operationalIssues).where(eq(operationalIssues.id, dfA));
    await db.delete(operationalIssues).where(eq(operationalIssues.id, dfB));
  });

  it('is idempotent when called on an already clean district', async () => {
    const { districtId, delFailId } = await seedIssuesForDistrict('c');

    await db.transaction(async (tx: DbTransaction) => {
      await createIssuesDataCleaner().deleteDistrictData(tx, districtId);
    });

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createIssuesDataCleaner().deleteDistrictData(tx, districtId);
      })
    ).resolves.not.toThrow();

    await db.delete(operationalIssues).where(eq(operationalIssues.id, delFailId));
  });

  it('rolls back on transaction error', async () => {
    const { districtId, delFailId } = await seedIssuesForDistrict('d');

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createIssuesDataCleaner().deleteDistrictData(tx, districtId);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');

    const issuesAfter = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.districtId, districtId));
    expect(issuesAfter).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createIssuesDataCleaner().deleteDistrictData(tx, districtId);
    });

    await db.delete(operationalIssues).where(eq(operationalIssues.id, delFailId));
  });
});
