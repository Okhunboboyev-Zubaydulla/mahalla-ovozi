import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  DistrictDeletionRecord,
  DistrictDeletionRecordSchema,
} from '@mahalla-ovozi/api-contracts';
// Port and error class live in the domain layer; import for local use and re-export for backward compat.
import type { ExternalTombstoneStore } from '../../modules/subscriptions/ports/external-tombstone-store.port.js';
import { TombstoneStoreCorruptedError } from '../../modules/subscriptions/ports/external-tombstone-store.port.js';
export type { ExternalTombstoneStore };
export { TombstoneStoreCorruptedError };

/**
 * Strips all non-whitelisted properties from a deletion record before persisting
 * to ensure resident messages, evidence quotes, credentials, bot tokens, or private notes
 * never cross into the external tombstone store. (AC 3, AD-09, AD-11)
 */
function sanitizeTombstoneForPersistence(record: DistrictDeletionRecord): DistrictDeletionRecord {
  const parsed = DistrictDeletionRecordSchema.parse(record);
  return {
    id: parsed.id,
    districtId: parsed.districtId,
    districtName: parsed.districtName,
    cancelledAt: parsed.cancelledAt,
    cancelledById: parsed.cancelledById,
    cancellationReason: parsed.cancellationReason,
    scheduledLiveDeletionAt: parsed.scheduledLiveDeletionAt,
    actualLiveDeletionAt: parsed.actualLiveDeletionAt,
    liveDeletionStatus: parsed.liveDeletionStatus,
    protectedBackupExpiryDeadline: parsed.protectedBackupExpiryDeadline,
    backupExpiryStatus: parsed.backupExpiryStatus,
    backupExpiryVerifiedAt: parsed.backupExpiryVerifiedAt,
    restoreReconciliationStatus: parsed.restoreReconciliationStatus,
    restoreReconciliationVerifiedAt: parsed.restoreReconciliationVerifiedAt,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

/**
 * Persistent file-backed adapter for ExternalTombstoneStore.
 * Guarantees atomic writes with temp files, flush to disk (`fileHandle.sync()`),
 * serialized write queue mutex, and exponential backoff retry loops on rename to tolerate Windows file locks.
 */
export class FileExternalTombstoneStore implements ExternalTombstoneStore {
  private readonly filePath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(customPath?: string) {
    this.filePath =
      customPath ||
      process.env.TOMBSTONE_STORE_PATH ||
      path.resolve(process.cwd(), 'deploy/backup/tombstones.json');
  }

  getFilePath(): string {
    return this.filePath;
  }

  private async runWithWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previousLock = this.writeLock;
    let releaseLock: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await previousLock;
      return await fn();
    } finally {
      releaseLock!();
    }
  }

  async loadAllTombstones(): Promise<DistrictDeletionRecord[]> {
    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }

      const raw = await fs.promises.readFile(this.filePath, 'utf-8');
      if (!raw || raw.trim() === '') {
        return [];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (jsonErr) {
        throw new TombstoneStoreCorruptedError(
          `JSON parsing failed: ${(jsonErr as Error).message}`,
          jsonErr,
        );
      }

      const validation = z.array(DistrictDeletionRecordSchema).safeParse(parsed);
      if (!validation.success) {
        throw new TombstoneStoreCorruptedError(
          `Schema validation failed: ${validation.error.message}`,
          validation.error,
        );
      }

      return validation.data;
    } catch (err) {
      if (err instanceof TombstoneStoreCorruptedError) {
        throw err;
      }
      throw new TombstoneStoreCorruptedError(
        `Failed to read tombstones from disk: ${(err as Error).message}`,
        err,
      );
    }
  }

  private async writeTombstonesFile(records: DistrictDeletionRecord[]): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    const tempPath = path.join(
      dir,
      `.tombstones.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );

    const content = JSON.stringify(records, null, 2);

    try {
      const handle = await fs.promises.open(tempPath, 'w');
      try {
        await handle.writeFile(content, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      // Exponential backoff retry loop for atomic rename (Windows EPERM/EBUSY safety)
      let renamed = false;
      const MAX_ATTEMPTS = 6;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          await fs.promises.rename(tempPath, this.filePath);
          renamed = true;
          break;
        } catch (renameErr: any) {
          const isLockError =
            renameErr.code === 'EPERM' ||
            renameErr.code === 'EBUSY' ||
            renameErr.code === 'EACCES';
          if (attempt === MAX_ATTEMPTS - 1 || !isLockError) {
            throw renameErr;
          }
          const backoffMs = Math.pow(2, attempt) * 25; // 25ms, 50ms, 100ms, 200ms, 400ms
          await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        }
      }

      if (!renamed) {
        throw new Error(`Failed to atomically rename temporary tombstone file to ${this.filePath}`);
      }
    } catch (writeErr) {
      await fs.promises.unlink(tempPath).catch(() => {});
      throw writeErr;
    }
  }

  async saveTombstone(record: DistrictDeletionRecord): Promise<void> {
    await this.saveAllTombstones([record]);
  }

  async saveAllTombstones(records: DistrictDeletionRecord[]): Promise<void> {
    if (records.length === 0) return;
    const sanitizedRecords = records.map(sanitizeTombstoneForPersistence);

    await this.runWithWriteLock(async () => {
      const existing = await this.loadAllTombstones();
      const tombMap = new Map<string, DistrictDeletionRecord>();
      for (const r of existing) {
        tombMap.set(r.districtId, r);
      }
      for (const r of sanitizedRecords) {
        tombMap.set(r.districtId, r);
      }
      const updated = Array.from(tombMap.values());
      await this.writeTombstonesFile(updated);
    });
  }

  async getTombstone(districtId: string): Promise<DistrictDeletionRecord | null> {
    const all = await this.loadAllTombstones();
    return all.find((r) => r.districtId === districtId) || null;
  }
}

/**
 * In-memory adapter for ExternalTombstoneStore.
 * Useful for fast, isolated, deterministic unit and integration tests.
 */
export class InMemoryExternalTombstoneStore implements ExternalTombstoneStore {
  private tombstones = new Map<string, DistrictDeletionRecord>();
  private corrupted = false;

  setCorrupted(corrupted: boolean): void {
    this.corrupted = corrupted;
  }

  async loadAllTombstones(): Promise<DistrictDeletionRecord[]> {
    if (this.corrupted) {
      throw new TombstoneStoreCorruptedError('Simulated corruption in in-memory store');
    }
    return Array.from(this.tombstones.values()).map(sanitizeTombstoneForPersistence);
  }

  async saveTombstone(record: DistrictDeletionRecord): Promise<void> {
    await this.saveAllTombstones([record]);
  }

  async saveAllTombstones(records: DistrictDeletionRecord[]): Promise<void> {
    if (this.corrupted) {
      throw new TombstoneStoreCorruptedError('Simulated corruption in in-memory store');
    }
    for (const record of records) {
      const sanitized = sanitizeTombstoneForPersistence(record);
      this.tombstones.set(sanitized.districtId, sanitized);
    }
  }

  async getTombstone(districtId: string): Promise<DistrictDeletionRecord | null> {
    if (this.corrupted) {
      throw new TombstoneStoreCorruptedError('Simulated corruption in in-memory store');
    }
    const record = this.tombstones.get(districtId);
    return record ? sanitizeTombstoneForPersistence(record) : null;
  }

  clear(): void {
    this.tombstones.clear();
    this.corrupted = false;
  }
}
