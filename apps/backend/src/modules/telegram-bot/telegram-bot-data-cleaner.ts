import { eq } from 'drizzle-orm';
import { districtTelegramBots } from '../../adapters/db/schema/index.js';
import type { DistrictDataCleaner } from '../subscriptions/ports/district-data-cleaner.js';

/**
 * Returns a DistrictDataCleaner that purges district telegram bots (ADR-001).
 *
 * Must be called within the orchestrator transaction; does not open its own.
 */
export function createTelegramBotsDataCleaner(): DistrictDataCleaner {
  return {
    moduleName: 'telegram-bot',

    async deleteDistrictData(tx, districtId) {
      await tx
        .delete(districtTelegramBots)
        .where(eq(districtTelegramBots.districtId, districtId));
    },
  };
}
