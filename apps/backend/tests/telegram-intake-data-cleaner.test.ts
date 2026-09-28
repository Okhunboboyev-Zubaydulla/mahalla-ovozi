import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient, DbTransaction } from '../src/adapters/db/client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import {
  districts,
  districtTelegramGroups,
  telegramIntakeRecords,
} from '../src/adapters/db/schema/index.js';
import { createTelegramIntakeDataCleaner } from '../src/modules/telegram-intake/telegram-intake-data-cleaner.js';

describe('createTelegramIntakeDataCleaner', () => {
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

  async function seedIntakeForDistrict(tag: string) {
    const districtId = `dist_int_${tag}_${Date.now()}`;
    const now = new Date();

    await db.insert(districts).values({
      id: districtId,
      name: `Intake Clean ${districtId}`,
      region: 'Toshkent',
      status: 'CANCELLED',
    });

    const chatId = `-100${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    await db.insert(districtTelegramGroups).values({
      id: crypto.randomUUID(),
      districtId,
      mahallaName: 'Mahalla 1',
      telegramChatId: chatId,
      telegramChatTitle: 'Mahalla 1 group',
      status: 'VALID',
    });

    const intakeId = `int_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId,
      mahallaName: 'Mahalla 1',
      telegramBotId: `bot_int_${tag}`,
      telegramChatId: chatId,
      telegramMessageId: '1',
      calendarDay: '2026-08-28',
      originalTimestamp: now,
      rawPayload: { text: 'Intake test message' },
    });

    return { districtId, intakeId };
  }

  it('deletes telegram_intake_records for the target district', async () => {
    const { districtId } = await seedIntakeForDistrict('a');

    const recordsBefore = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.districtId, districtId));
    expect(recordsBefore).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramIntakeDataCleaner().deleteDistrictData(tx, districtId);
    });

    const recordsAfter = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.districtId, districtId));
    expect(recordsAfter).toHaveLength(0);
  });

  it('does not delete telegram intake records belonging to other districts', async () => {
    const { districtId: districtA } = await seedIntakeForDistrict('b1');
    const { districtId: districtB } = await seedIntakeForDistrict('b2');

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramIntakeDataCleaner().deleteDistrictData(tx, districtA);
    });

    const recordsB = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.districtId, districtB));
    expect(recordsB).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramIntakeDataCleaner().deleteDistrictData(tx, districtB);
    });
  });

  it('is idempotent when called on an already clean district', async () => {
    const { districtId } = await seedIntakeForDistrict('c');

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramIntakeDataCleaner().deleteDistrictData(tx, districtId);
    });

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createTelegramIntakeDataCleaner().deleteDistrictData(tx, districtId);
      })
    ).resolves.not.toThrow();
  });

  it('rolls back on transaction error', async () => {
    const { districtId } = await seedIntakeForDistrict('d');

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createTelegramIntakeDataCleaner().deleteDistrictData(tx, districtId);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');

    const recordsAfter = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.districtId, districtId));
    expect(recordsAfter).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramIntakeDataCleaner().deleteDistrictData(tx, districtId);
    });
  });
});
