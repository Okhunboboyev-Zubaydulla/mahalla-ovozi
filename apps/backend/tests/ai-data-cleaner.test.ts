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
  aiOperations,
  aiProviderAttempts,
} from '../src/adapters/db/schema/index.js';
import { ensureDefaultAiProfiles } from '../src/adapters/db/seeds.js';
import { createAiDataCleaner } from '../src/modules/ai/ai-data-cleaner.js';

describe('createAiDataCleaner', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let aiProfileId: string;

  beforeAll(async () => {
    await runMigrations();
    pool = createDbPool();
    db = createDbClient(pool);
    await ensureDefaultAiProfiles(db);
    const profile = await db.query.aiProfiles.findFirst();
    aiProfileId = profile!.id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seedAiForDistrict(tag: string) {
    const districtId = `dist_ai_${tag}_${Date.now()}`;
    const now = new Date();

    await db.insert(districts).values({
      id: districtId,
      name: `AI Clean ${districtId}`,
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

    const intakeId = `int_ai_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(telegramIntakeRecords).values({
      id: intakeId,
      districtId,
      mahallaName: 'Mahalla 1',
      telegramBotId: `bot_ai_${tag}`,
      telegramChatId: chatId,
      telegramMessageId: '1',
      calendarDay: '2026-08-28',
      originalTimestamp: now,
      rawPayload: { text: 'Test message' },
    });

    const aiOpId = `aiop_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(aiOperations).values({
      id: aiOpId,
      districtId,
      mahallaName: 'Mahalla 1',
      calendarDay: '2026-08-28',
      operationType: 'SEMANTIC_RELEVANCE',
      targetId: intakeId,
      pinnedProfileId: aiProfileId,
      finalStatus: 'COMPLETED_RELEVANT',
      snapshotFingerprint: `fp_${tag}`,
    });

    const attemptId = `att_${tag}_${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(aiProviderAttempts).values({
      id: attemptId,
      operationId: aiOpId,
      attemptNumber: 1,
      provider: 'OPENAI',
      modelId: 'gpt-4o-mini',
      durationMs: 300,
      status: 'SUCCESS',
    });

    return { districtId, aiOpId, attemptId, intakeId };
  }

  it('deletes ai_provider_attempts and ai_operations for the target district', async () => {
    const { districtId, aiOpId } = await seedAiForDistrict('a');

    const opsBefore = await db.select().from(aiOperations).where(eq(aiOperations.districtId, districtId));
    expect(opsBefore).toHaveLength(1);
    const attBefore = await db.select().from(aiProviderAttempts).where(eq(aiProviderAttempts.operationId, aiOpId));
    expect(attBefore).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAiDataCleaner().deleteDistrictData(tx, districtId);
    });

    const opsAfter = await db.select().from(aiOperations).where(eq(aiOperations.districtId, districtId));
    expect(opsAfter).toHaveLength(0);
    const attAfter = await db.select().from(aiProviderAttempts).where(eq(aiProviderAttempts.operationId, aiOpId));
    expect(attAfter).toHaveLength(0);
  });

  it('does not delete AI operations or attempts belonging to other districts', async () => {
    const { districtId: districtA } = await seedAiForDistrict('b1');
    const { districtId: districtB, aiOpId: opB } = await seedAiForDistrict('b2');

    await db.transaction(async (tx: DbTransaction) => {
      await createAiDataCleaner().deleteDistrictData(tx, districtA);
    });

    const opsB = await db.select().from(aiOperations).where(eq(aiOperations.districtId, districtB));
    expect(opsB).toHaveLength(1);
    const attB = await db.select().from(aiProviderAttempts).where(eq(aiProviderAttempts.operationId, opB));
    expect(attB).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAiDataCleaner().deleteDistrictData(tx, districtB);
    });
  });

  it('is idempotent when called on an already clean district', async () => {
    const { districtId } = await seedAiForDistrict('c');

    await db.transaction(async (tx: DbTransaction) => {
      await createAiDataCleaner().deleteDistrictData(tx, districtId);
    });

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createAiDataCleaner().deleteDistrictData(tx, districtId);
      })
    ).resolves.not.toThrow();
  });

  it('rolls back on transaction abort', async () => {
    const { districtId } = await seedAiForDistrict('d');

    await expect(
      db.transaction(async (tx: DbTransaction) => {
        await createAiDataCleaner().deleteDistrictData(tx, districtId);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');

    const opsAfter = await db.select().from(aiOperations).where(eq(aiOperations.districtId, districtId));
    expect(opsAfter).toHaveLength(1);

    await db.transaction(async (tx: DbTransaction) => {
      await createAiDataCleaner().deleteDistrictData(tx, districtId);
    });
  });
});
