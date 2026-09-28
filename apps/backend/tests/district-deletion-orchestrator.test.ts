import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient, DbTransaction } from '../src/adapters/db/client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import {
  districts,
  districtSubscriptions,
  operationalIssues,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import {
  executeDistrictLiveDeletion,
  getDistrictDeletionRecord,
} from '../src/modules/subscriptions/district-deletion-service.js';
import type { DistrictDataCleaner } from '../src/modules/subscriptions/ports/district-data-cleaner.js';
import { InMemoryExternalTombstoneStore } from '../src/adapters/storage/external-tombstone-store.js';

describe('District Deletion Orchestrator with Mock Cleaners (Story 7.4, ADR-001 D-4)', () => {
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

  async function seedMinimalCancelledDistrict(tag: string) {
    const districtId = `dist_orch_${tag}_${Date.now()}`;
    const now = new Date();

    await db.insert(districts).values({
      id: districtId,
      name: `Orch District ${districtId}`,
      region: 'Toshkent',
      status: 'CANCELLED',
    });

    const subId = `sub_${districtId}`;
    await db.insert(districtSubscriptions).values({
      id: subId,
      districtId,
      status: 'CANCELLED',
      statusStartedAt: now,
      scheduledTransitionAt: new Date(now.getTime() - 10000), // deadline past
      scheduledTransitionType: 'LIVE_DELETION',
      internalNote: 'Test cancellation reason',
      updatedById: 'po_user_1',
    });

    const delFailIssueId = `iss_delfail_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(operationalIssues).values({
      id: delFailIssueId,
      logicalKey: `del_fail:${districtId}`,
      scope: 'GLOBAL',
      districtId: null,
      component: 'SUBSCRIPTIONS',
      issueCategory: 'LIFECYCLE_DELETION',
      severity: 'Critical',
      status: 'ACTIVE',
      healthStatus: 'DEGRADED',
      sanitizedTitle: 'Prior deletion failure',
      sanitizedDescription: 'Prior deletion failure description',
      recommendedAction: 'Retry deletion',
      startedAt: now,
      latestCheckAt: now,
    });

    return { districtId, subId, delFailIssueId };
  }

  it('invokes all injected mock cleaners in order with active tx and districtId', async () => {
    const { districtId } = await seedMinimalCancelledDistrict('calls');

    const callLog: string[] = [];
    const mockCleaner1: DistrictDataCleaner = {
      moduleName: 'mock-cleaner-1',
      deleteDistrictData: vi.fn(async (tx: DbTransaction, id: string) => {
        expect(tx).toBeDefined();
        expect(id).toBe(districtId);
        callLog.push('cleaner-1');
      }),
    };

    const mockCleaner2: DistrictDataCleaner = {
      moduleName: 'mock-cleaner-2',
      deleteDistrictData: vi.fn(async (tx: DbTransaction, id: string) => {
        expect(tx).toBeDefined();
        expect(id).toBe(districtId);
        callLog.push('cleaner-2');
      }),
    };

    const tombstoneStore = new InMemoryExternalTombstoneStore();

    const record = await executeDistrictLiveDeletion(db, districtId, {
      cleaners: [mockCleaner1, mockCleaner2],
      tombstoneStore,
      actor: { id: 'po_test_actor', role: 'PRODUCT_OWNER' },
    });

    // 1. Cleaners were invoked in exact order
    expect(mockCleaner1.deleteDistrictData).toHaveBeenCalledTimes(1);
    expect(mockCleaner2.deleteDistrictData).toHaveBeenCalledTimes(1);
    expect(callLog).toEqual(['cleaner-1', 'cleaner-2']);

    // 2. Tombstone record was inserted
    expect(record).not.toBeNull();
    expect(record?.districtId).toBe(districtId);
    expect(record?.liveDeletionStatus).toBe('COMPLETED');

    const storedTombstone = await getDistrictDeletionRecord(db, districtId);
    expect(storedTombstone?.districtId).toBe(districtId);

    // 3. External tombstone store received record
    const externalTombstones = await tombstoneStore.loadAllTombstones();
    expect(externalTombstones.some((t: { districtId: string }) => t.districtId === districtId)).toBe(true);

    // 4. del_fail:<districtId> issue was deleted
    const issues = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.logicalKey, `del_fail:${districtId}`));
    expect(issues).toHaveLength(0);

    // 5. Parent districts row was deleted
    const survivingDistrict = await db
      .select()
      .from(districts)
      .where(eq(districts.id, districtId));
    expect(survivingDistrict).toHaveLength(0);

    // 6. Global audit event was recorded
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'DISTRICT_LIVE_DELETED'));
    expect(audits.some((a) => (a.metadata as any)?.deletedDistrictId === districtId)).toBe(true);
  });

  it('rolls back entire transaction if any cleaner throws', async () => {
    const { districtId, delFailIssueId } = await seedMinimalCancelledDistrict('rollback');

    const mockCleanerSuccess: DistrictDataCleaner = {
      moduleName: 'mock-success',
      deleteDistrictData: vi.fn(async () => {}),
    };

    const mockCleanerFail: DistrictDataCleaner = {
      moduleName: 'mock-fail',
      deleteDistrictData: vi.fn(async () => {
        throw new Error('cleaner failed intentionally');
      }),
    };

    await expect(
      executeDistrictLiveDeletion(db, districtId, {
        cleaners: [mockCleanerSuccess, mockCleanerFail],
      }),
    ).rejects.toThrow('cleaner failed intentionally');

    // Rollback verification:
    // 1. District row still exists
    const districtAfter = await db
      .select()
      .from(districts)
      .where(eq(districts.id, districtId));
    expect(districtAfter).toHaveLength(1);

    // 2. Tombstone was NOT persisted
    const tombstoneAfter = await getDistrictDeletionRecord(db, districtId);
    expect(tombstoneAfter).toBeNull();

    // 3. del_fail issue still exists
    const delFailAfter = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.id, delFailIssueId));
    expect(delFailAfter).toHaveLength(1);

    // Cleanup for test isolation
    await db.delete(operationalIssues).where(eq(operationalIssues.id, delFailIssueId));
    await db.delete(districtSubscriptions).where(eq(districtSubscriptions.districtId, districtId));
    await db.delete(districts).where(eq(districts.id, districtId));
  });
});
