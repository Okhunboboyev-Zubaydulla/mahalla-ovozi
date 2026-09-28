import { eq, and, isNull, inArray } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import {
  telegramIntakeRecords,
  type TelegramIntakeRecord,
} from '../../adapters/db/schema/index.js';

export interface BurstBufferRepository {
  getUnprocessedBurstIntakes(
    db: DbClient,
    districtId: string,
    telegramChatId: string,
    telegramUserId?: string | null,
  ): Promise<TelegramIntakeRecord[]>;

  markBurstIntakesProcessed(
    db: DbClient,
    intakeIds: string[],
    batchId: string,
  ): Promise<void>;
}

export const defaultBurstBufferRepository: BurstBufferRepository = {
  async getUnprocessedBurstIntakes(
    db: DbClient,
    districtId: string,
    telegramChatId: string,
    telegramUserId?: string | null,
  ): Promise<TelegramIntakeRecord[]> {
    const conditions = [
      eq(telegramIntakeRecords.districtId, districtId),
      eq(telegramIntakeRecords.telegramChatId, telegramChatId),
      isNull(telegramIntakeRecords.processedAt),
    ];

    if (telegramUserId) {
      conditions.push(eq(telegramIntakeRecords.telegramUserId, telegramUserId));
    } else {
      conditions.push(isNull(telegramIntakeRecords.telegramUserId));
    }

    const records = await db
      .select()
      .from(telegramIntakeRecords)
      .where(and(...conditions))
      .orderBy(telegramIntakeRecords.originalTimestamp, telegramIntakeRecords.createdAt);

    return records;
  },

  async markBurstIntakesProcessed(
    db: DbClient,
    intakeIds: string[],
    batchId: string,
  ): Promise<void> {
    if (intakeIds.length === 0) return;

    await db
      .update(telegramIntakeRecords)
      .set({
        batchId,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(telegramIntakeRecords.id, intakeIds));
  },
};
