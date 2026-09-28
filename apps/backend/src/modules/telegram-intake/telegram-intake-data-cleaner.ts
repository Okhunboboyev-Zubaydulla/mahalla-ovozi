import { eq } from 'drizzle-orm';
import { telegramIntakeRecords } from '../../adapters/db/schema/index.js';
import type { DistrictDataCleaner } from '../subscriptions/ports/district-data-cleaner.js';

/**
 * Returns a DistrictDataCleaner that purges all telegram intake records for a district (ADR-001).
 *
 * Must be called within the orchestrator transaction; does not open its own.
 */
export function createTelegramIntakeDataCleaner(): DistrictDataCleaner {
  return {
    moduleName: 'telegram-intake',

    async deleteDistrictData(tx, districtId) {
      await tx.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.districtId, districtId));
    },
  };
}
