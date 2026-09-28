import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient, DbTransaction } from '../src/adapters/db/client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import { districts, districtTelegramGroups } from '../src/adapters/db/schema/index.js';
import { createTelegramGroupsDataCleaner } from '../src/modules/telegram-groups/telegram-groups-data-cleaner.js';

describe('createTelegramGroupsDataCleaner', () => {
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

  async function seedGroupsForDistrict(tag: string) {
    const districtId = `dist_tgg_${tag}_${Date.now()}`;

    await db.insert(districts).values({
      id: districtId,
      name: `TG Groups Clean ${districtId}`,
      region: 'Toshkent',
      status: 'CANCELLED',
    });

    const chatId = `-100${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    const groupId = crypto.randomUUID();
    await db.insert(districtTelegramGroups).values({
      id: groupId,
      districtId,
      mahallaName: 'Mahalla 1',
      telegramChatId: chatId,
      telegramChatTitle: 'Mahalla 1 group',
      status: 'VALID',
    });

    return { districtId, groupId };
  }

  it('deletes district_telegram_groups for target district', async () => {
    const { districtId } = await seedGroupsForDistrict('a');

    const groupsBefore = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.districtId, districtId));
    expect(groupsBefore).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramGroupsDataCleaner().deleteDistrictData(tx, districtId);
    });

    const groupsAfter = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.districtId, districtId));
    expect(groupsAfter).toHaveLength(0);
  });

  it('does not delete telegram groups belonging to other districts', async () => {
    const { districtId: districtA } = await seedGroupsForDistrict('b1');
    const { districtId: districtB } = await seedGroupsForDistrict('b2');

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramGroupsDataCleaner().deleteDistrictData(tx, districtA);
    });

    const groupsB = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.districtId, districtB));
    expect(groupsB).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramGroupsDataCleaner().deleteDistrictData(tx, districtB);
    });
  });

  it('is idempotent when called on an already clean district', async () => {
    const { districtId } = await seedGroupsForDistrict('c');

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramGroupsDataCleaner().deleteDistrictData(tx, districtId);
    });

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createTelegramGroupsDataCleaner().deleteDistrictData(tx, districtId);
      })
    ).resolves.not.toThrow();
  });

  it('rolls back on transaction error', async () => {
    const { districtId } = await seedGroupsForDistrict('d');

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createTelegramGroupsDataCleaner().deleteDistrictData(tx, districtId);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');

    const groupsAfter = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.districtId, districtId));
    expect(groupsAfter).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramGroupsDataCleaner().deleteDistrictData(tx, districtId);
    });
  });
});
