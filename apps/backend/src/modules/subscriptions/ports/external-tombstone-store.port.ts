import type { DistrictDeletionRecord } from '@mahalla-ovozi/api-contracts';

/**
 * Port interface for external deletion tombstone store.
 * Outside PostgreSQL backup history, maintaining privacy-safe deletion proofs.
 * Governed by FR-32, AD-11.
 *
 * The concrete adapter is `FileExternalTombstoneStore` (adapters/storage/).
 * Domain code should depend only on this port; concrete instantiation belongs
 * at the composition root, not inside domain services.
 */
export interface ExternalTombstoneStore {
  loadAllTombstones(): Promise<DistrictDeletionRecord[]>;
  saveTombstone(record: DistrictDeletionRecord): Promise<void>;
  saveAllTombstones(records: DistrictDeletionRecord[]): Promise<void>;
  getTombstone(districtId: string): Promise<DistrictDeletionRecord | null>;
}

/**
 * Thrown when the external tombstone store contains invalid JSON or schema violations.
 * Fail-closed security principle: prevent corrupted storage from allowing resurrected districts.
 */
export class TombstoneStoreCorruptedError extends Error {
  readonly code = 'TOMBSTONE_STORE_CORRUPTED' as const;
  readonly statusCode = 500;

  constructor(message: string, cause?: unknown) {
    super(`Ташқи ўчирилганлик маълумотлар омбори шикастланган: ${message}`);
    this.name = 'TombstoneStoreCorruptedError';
    if (cause) {
      this.cause = cause;
    }
  }
}
