import { eq } from 'drizzle-orm';
import { topicProjections, acceptedEvidence, topics } from '../../adapters/db/schema/index.js';
import type { DistrictDataCleaner } from '../subscriptions/ports/district-data-cleaner.js';

/**
 * Returns a DistrictDataCleaner that purges all topic-domain data for a district (ADR-001).
 *
 * Deletion order is strict FK topological order:
 *   1. topic_projections (FK -> topics)
 *   2. accepted_evidence (FK -> topics)
 *   3. topics (parent row)
 *
 * Must be called within the orchestrator transaction; does not open its own.
 */
export function createTopicsDataCleaner(): DistrictDataCleaner {
  return {
    moduleName: 'topics',

    async deleteDistrictData(tx, districtId) {
      // 1. topic_projections must be deleted before topics (FK constraint)
      await tx.delete(topicProjections).where(eq(topicProjections.districtId, districtId));

      // 2. accepted_evidence must be deleted before topics (FK constraint)
      await tx.delete(acceptedEvidence).where(eq(acceptedEvidence.districtId, districtId));

      // 3. topics parent rows last
      await tx.delete(topics).where(eq(topics.districtId, districtId));
    },
  };
}
