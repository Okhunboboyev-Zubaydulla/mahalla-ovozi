import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient, DbTransaction } from '../src/adapters/db/client.js';
import { runMigrations } from '../src/adapters/db/migrate.js';
import { districts, districtTelegramBots } from '../src/adapters/db/schema/index.js';
import { createTelegramBotsDataCleaner } from '../src/modules/telegram-bot/telegram-bot-data-cleaner.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';

describe('createTelegramBotsDataCleaner', () => {
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

  async function seedBotForDistrict(tag: string) {
    const districtId = `dist_tgb_${tag}_${Date.now()}`;
    const now = new Date();

    await db.insert(districts).values({
      id: districtId,
      name: `TG Bot Clean ${districtId}`,
      region: 'Toshkent',
      status: 'CANCELLED',
    });

    const botId = `bot_${crypto.randomUUID().slice(0, 8)}`;
    const encrypted = encryptToken('123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789');
    await db.insert(districtTelegramBots).values({
      id: crypto.randomUUID(),
      districtId,
      botId,
      botUsername: `bot_${botId}`,
      botFirstName: 'Mahalla Bot',
      encryptedToken: encrypted.encryptedToken,
      tokenIv: encrypted.tokenIv,
      tokenTag: encrypted.tokenTag,
      tokenKeyVersion: encrypted.tokenKeyVersion,
      tokenMasked: encrypted.tokenMasked,
      status: 'VALID',
      lastValidatedAt: now,
    });

    return { districtId, botId };
  }

  it('deletes district_telegram_bots for target district', async () => {
    const { districtId } = await seedBotForDistrict('a');

    const botsBefore = await db
      .select()
      .from(districtTelegramBots)
      .where(eq(districtTelegramBots.districtId, districtId));
    expect(botsBefore).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramBotsDataCleaner().deleteDistrictData(tx, districtId);
    });

    const botsAfter = await db
      .select()
      .from(districtTelegramBots)
      .where(eq(districtTelegramBots.districtId, districtId));
    expect(botsAfter).toHaveLength(0);
  });

  it('does not delete telegram bots belonging to other districts', async () => {
    const { districtId: districtA } = await seedBotForDistrict('b1');
    const { districtId: districtB } = await seedBotForDistrict('b2');

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramBotsDataCleaner().deleteDistrictData(tx, districtA);
    });

    const botsB = await db
      .select()
      .from(districtTelegramBots)
      .where(eq(districtTelegramBots.districtId, districtB));
    expect(botsB).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramBotsDataCleaner().deleteDistrictData(tx, districtB);
    });
  });

  it('is idempotent when called on an already clean district', async () => {
    const { districtId } = await seedBotForDistrict('c');

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramBotsDataCleaner().deleteDistrictData(tx, districtId);
    });

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createTelegramBotsDataCleaner().deleteDistrictData(tx, districtId);
      })
    ).resolves.not.toThrow();
  });

  it('rolls back on transaction error', async () => {
    const { districtId } = await seedBotForDistrict('d');

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createTelegramBotsDataCleaner().deleteDistrictData(tx, districtId);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');

    const botsAfter = await db
      .select()
      .from(districtTelegramBots)
      .where(eq(districtTelegramBots.districtId, districtId));
    expect(botsAfter).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createTelegramBotsDataCleaner().deleteDistrictData(tx, districtId);
    });
  });
});
