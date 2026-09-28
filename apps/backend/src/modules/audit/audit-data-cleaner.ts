import { eq } from 'drizzle-orm';
import { auditEvents } from '../../adapters/db/schema/index.js';
import type { DistrictDataCleaner } from '../subscriptions/ports/district-data-cleaner.js';

/**
 * Returns a DistrictDataCleaner that purges district-scoped audit events (ADR-001).
 *
 * Must be called within the orchestrator transaction; does not open its own.
 */
export function createAuditDataCleaner(): DistrictDataCleaner {
  return {
    moduleName: 'audit',

    async deleteDistrictData(tx, districtId) {
      await tx.delete(auditEvents).where(eq(auditEvents.districtId, districtId));
    },
  };
}
