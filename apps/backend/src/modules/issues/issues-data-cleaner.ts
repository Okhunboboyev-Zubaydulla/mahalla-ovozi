import { eq } from 'drizzle-orm';
import { operationalIssues } from '../../adapters/db/schema/index.js';
import type { DistrictDataCleaner } from '../subscriptions/ports/district-data-cleaner.js';

/**
 * Returns a DistrictDataCleaner that purges district-scoped operational issues (ADR-001).
 *
 * NOTE: Does NOT delete `del_fail:<districtId>` issues — those have `scope = GLOBAL` and
 * `districtId = null` (they are deletion failure lifecycle artifacts owned directly by the
 * orchestrating deletion service).
 *
 * Must be called within the orchestrator transaction; does not open its own.
 */
export function createIssuesDataCleaner(): DistrictDataCleaner {
  return {
    moduleName: 'issues',

    async deleteDistrictData(tx, districtId) {
      await tx
        .delete(operationalIssues)
        .where(eq(operationalIssues.districtId, districtId));
    },
  };
}
