import type { DbTransaction } from '../../../adapters/db/client.js';

/**
 * Contract for module-owned district data cleanup (ADR-001).
 *
 * Each backend module that owns district-scoped data implements this interface
 * via a factory function (e.g. createTopicsDataCleaner()). The deletion service
 * holds a DistrictDataCleaner[] array iterated in FK topological order and calls
 * each cleaner inside its open transaction.
 *
 * Rules:
 * - deleteDistrictData MUST use the provided tx and MUST NOT open its own transaction.
 * - deleteDistrictData MUST delete only rows belonging to the given districtId.
 * - FK order is the caller responsibility; each cleaner only knows its own tables.
 */
export interface DistrictDataCleaner {
  /** Human-readable module name for logging and debugging. */
  readonly moduleName: string;
  /**
   * Deletes all district-scoped data owned by this module within the provided transaction.
   * Must not start its own transaction. Atomicity is inherited from the caller.
   */
  deleteDistrictData(tx: DbTransaction, districtId: string): Promise<void>;
}
