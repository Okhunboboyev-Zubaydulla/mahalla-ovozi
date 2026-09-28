import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient, DbTransaction } from '../src/adapters/db/client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import { districts, auditEvents } from '../src/adapters/db/schema/index.js';
import { createAuditDataCleaner } from '../src/modules/audit/audit-data-cleaner.js';

describe('createAuditDataCleaner', () => {
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

  async function seedAuditForDistrict(tag: string) {
    const districtId = `dist_aud_${tag}_${Date.now()}`;
    const now = new Date();

    await db.insert(districts).values({
      id: districtId,
      name: `Audit Clean ${districtId}`,
      region: 'Toshkent',
      status: 'CANCELLED',
    });

    const eventId = `aud_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(auditEvents).values({
      id: eventId,
      districtId,
      actorId: 'user_123',
      actorRole: 'DISTRICT_HOKIM',
      action: 'VIEW_DASHBOARD',
      createdAt: now,
    });

    return { districtId, eventId };
  }

  it('deletes district-scoped audit events for target district', async () => {
    const { districtId } = await seedAuditForDistrict('a');

    const eventsBefore = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.districtId, districtId));
    expect(eventsBefore).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAuditDataCleaner().deleteDistrictData(tx, districtId);
    });

    const eventsAfter = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.districtId, districtId));
    expect(eventsAfter).toHaveLength(0);
  });

  it('does not delete audit events belonging to other districts', async () => {
    const { districtId: districtA } = await seedAuditForDistrict('b1');
    const { districtId: districtB } = await seedAuditForDistrict('b2');

    await db.transaction(async (tx: DbTransaction) => {
      await createAuditDataCleaner().deleteDistrictData(tx, districtA);
    });

    const eventsB = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.districtId, districtB));
    expect(eventsB).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAuditDataCleaner().deleteDistrictData(tx, districtB);
    });
  });

  it('is idempotent when called on an already clean district', async () => {
    const { districtId } = await seedAuditForDistrict('c');

    await db.transaction(async (tx: DbTransaction) => {
      await createAuditDataCleaner().deleteDistrictData(tx, districtId);
    });

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createAuditDataCleaner().deleteDistrictData(tx, districtId);
      })
    ).resolves.not.toThrow();
  });

  it('rolls back on transaction error', async () => {
    const { districtId } = await seedAuditForDistrict('d');

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createAuditDataCleaner().deleteDistrictData(tx, districtId);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');

    const eventsAfter = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.districtId, districtId));
    expect(eventsAfter).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAuditDataCleaner().deleteDistrictData(tx, districtId);
    });
  });
});
