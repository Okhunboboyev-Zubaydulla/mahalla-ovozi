import { eq } from 'drizzle-orm';
import {
  districtAnalysisSettingsDrafts,
  districtAnalysisSettingsVersions,
} from '../../adapters/db/schema/index.js';
import type { DistrictDataCleaner } from '../subscriptions/ports/district-data-cleaner.js';

/**
 * Returns a DistrictDataCleaner that purges all district analysis settings drafts and versions (ADR-001).
 *
 * Deletion order is strict FK topological order:
 *   1. district_analysis_settings_drafts (FK base_active_version_id -> district_analysis_settings_versions)
 *   2. district_analysis_settings_versions
 *
 * Must be called within the orchestrator transaction; does not open its own.
 */
export function createAnalysisSettingsDataCleaner(): DistrictDataCleaner {
  return {
    moduleName: 'analysis-settings',

    async deleteDistrictData(tx, districtId) {
      // 1. drafts must be deleted before versions (FK constraint on base_active_version_id)
      await tx
        .delete(districtAnalysisSettingsDrafts)
        .where(eq(districtAnalysisSettingsDrafts.districtId, districtId));

      // 2. versions
      await tx
        .delete(districtAnalysisSettingsVersions)
        .where(eq(districtAnalysisSettingsVersions.districtId, districtId));
    },
  };
}
