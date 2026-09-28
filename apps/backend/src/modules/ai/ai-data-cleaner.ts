import { eq, inArray } from 'drizzle-orm';
import { aiOperations, aiProviderAttempts } from '../../adapters/db/schema/index.js';
import type { DistrictDataCleaner } from '../subscriptions/ports/district-data-cleaner.js';

/**
 * Returns a DistrictDataCleaner that purges all AI operation and attempt data for a district (ADR-001).
 *
 * Deletion order is strict FK topological order:
 *   1. ai_provider_attempts (FK -> ai_operations; purged via typed subquery)
 *   2. ai_operations (parent row)
 *
 * Must be called within the orchestrator transaction; does not open its own.
 */
export function createAiDataCleaner(): DistrictDataCleaner {
  return {
    moduleName: 'ai',

    async deleteDistrictData(tx, districtId) {
      // 1. ai_provider_attempts must be deleted before ai_operations (FK constraint)
      await tx
        .delete(aiProviderAttempts)
        .where(
          inArray(
            aiProviderAttempts.operationId,
            tx
              .select({ id: aiOperations.id })
              .from(aiOperations)
              .where(eq(aiOperations.districtId, districtId)),
          ),
        );

      // 2. ai_operations parent rows
      await tx.delete(aiOperations).where(eq(aiOperations.districtId, districtId));
    },
  };
}
