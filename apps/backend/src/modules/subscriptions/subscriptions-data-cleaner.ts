import { eq } from 'drizzle-orm';
import { districtSubscriptions } from '../../adapters/db/schema/index.js';
import type { DistrictDataCleaner } from './ports/district-data-cleaner.js';

/**
 * Returns a DistrictDataCleaner that purges district subscriptions (ADR-001).
 *
 * NOTE: Does NOT delete the parent `districts` row — that final row delete remains
 * inline in the deletion orchestrator as the termination of the live deletion lifecycle.
 *
 * Must be called within the orchestrator transaction; does not open its own.
 */
export function createSubscriptionsDataCleaner(): DistrictDataCleaner {
  return {
    moduleName: 'subscriptions',

    async deleteDistrictData(tx, districtId) {
      await tx
        .delete(districtSubscriptions)
        .where(eq(districtSubscriptions.districtId, districtId));
    },
  };
}
