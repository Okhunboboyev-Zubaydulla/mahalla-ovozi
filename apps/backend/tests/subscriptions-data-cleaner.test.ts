import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient, DbTransaction } from '../src/adapters/db/client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import { districts, districtSubscriptions } from '../src/adapters/db/schema/index.js';
import { createSubscriptionsDataCleaner } from '../src/modules/subscriptions/subscriptions-data-cleaner.js';

describe('createSubscriptionsDataCleaner', () => {
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

  async function seedSubscriptionForDistrict(tag: string) {
    const districtId = `dist_sub_${tag}_${Date.now()}`;
    const now = new Date();

    await db.insert(districts).values({
      id: districtId,
      name: `Sub Clean ${districtId}`,
      region: 'Toshkent',
      status: 'CANCELLED',
    });

    const subId = `sub_${districtId}`;
    await db.insert(districtSubscriptions).values({
      id: subId,
      districtId,
      status: 'CANCELLED',
      statusStartedAt: now,
    });

    return { districtId, subId };
  }

  it('deletes district_subscriptions for target district and leaves parent districts row intact', async () => {
    const { districtId } = await seedSubscriptionForDistrict('a');

    const subsBefore = await db
      .select()
      .from(districtSubscriptions)
      .where(eq(districtSubscriptions.districtId, districtId));
    expect(subsBefore).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createSubscriptionsDataCleaner().deleteDistrictData(tx, districtId);
    });

    const subsAfter = await db
      .select()
      .from(districtSubscriptions)
      .where(eq(districtSubscriptions.districtId, districtId));
    expect(subsAfter).toHaveLength(0);

    // Parent districts row must remain intact (owned by deletion orchestrator)
    const districtAfter = await db
      .select()
      .from(districts)
      .where(eq(districts.id, districtId));
    expect(districtAfter).toHaveLength(1);
  });

  it('does not delete subscriptions belonging to other districts', async () => {
    const { districtId: districtA } = await seedSubscriptionForDistrict('b1');
    const { districtId: districtB } = await seedSubscriptionForDistrict('b2');

    await db.transaction(async (tx: DbTransaction) => {
      await createSubscriptionsDataCleaner().deleteDistrictData(tx, districtA);
    });

    const subsB = await db
      .select()
      .from(districtSubscriptions)
      .where(eq(districtSubscriptions.districtId, districtB));
    expect(subsB).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createSubscriptionsDataCleaner().deleteDistrictData(tx, districtB);
    });
  });

  it('is idempotent when called on an already clean district', async () => {
    const { districtId } = await seedSubscriptionForDistrict('c');

    await db.transaction(async (tx: DbTransaction) => {
      await createSubscriptionsDataCleaner().deleteDistrictData(tx, districtId);
    });

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createSubscriptionsDataCleaner().deleteDistrictData(tx, districtId);
      })
    ).resolves.not.toThrow();
  });

  it('rolls back on transaction error', async () => {
    const { districtId } = await seedSubscriptionForDistrict('d');

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createSubscriptionsDataCleaner().deleteDistrictData(tx, districtId);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');

    const subsAfter = await db
      .select()
      .from(districtSubscriptions)
      .where(eq(districtSubscriptions.districtId, districtId));
    expect(subsAfter).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createSubscriptionsDataCleaner().deleteDistrictData(tx, districtId);
    });
  });
});
