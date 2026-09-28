import { eq } from 'drizzle-orm';
import { districtTelegramGroups } from '../../adapters/db/schema/index.js';
import type { DistrictDataCleaner } from '../subscriptions/ports/district-data-cleaner.js';

/**
 * Returns a DistrictDataCleaner that purges district telegram groups (ADR-001).
 *
 * Must be called within the orchestrator transaction; does not open its own.
 */
export function createTelegramGroupsDataCleaner(): DistrictDataCleaner {
  return {
    moduleName: 'telegram-groups',

    async deleteDistrictData(tx, districtId) {
      await tx
        .delete(districtTelegramGroups)
        .where(eq(districtTelegramGroups.districtId, districtId));
    },
  };
}
