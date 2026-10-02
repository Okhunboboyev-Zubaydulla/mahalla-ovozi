import { describe, it, expect } from 'vitest';
import { SystemBackupRetentionVerifier } from '../src/adapters/backup/system-backup-verifier.js';
import type { PgBackRestStanzaInfo } from '../src/adapters/backup/system-backup-verifier.js';

// The verifier compares backup start timestamps against the live-deletion
// timestamp, so every fixture is anchored to fixed dates instead of "now".
const ACTUAL_LIVE_DELETION_AT = new Date('2026-08-01T12:00:00.000Z');
const PROTECTED_BACKUP_EXPIRY_DEADLINE = new Date('2026-08-31T12:00:00.000Z');

const BASE_PARAMS = {
  districtId: 'dist_backup_verifier_unit',
  actualLiveDeletionAt: ACTUAL_LIVE_DELETION_AT,
  protectedBackupExpiryDeadline: PROTECTED_BACKUP_EXPIRY_DEADLINE,
};

function buildStanzaList(
  backups: Array<{ label: string; start: Date }>,
): PgBackRestStanzaInfo[] {
  return [
    {
      name: 'mahalla_ovozi',
      status: { code: 0, message: 'ok' },
      backup: backups.map((backup) => ({
        label: backup.label,
        type: 'full' as const,
        timestamp: {
          // The adapter expects Unix epoch seconds, not milliseconds.
          start: Math.floor(backup.start.getTime() / 1000),
          stop: 0,
        },
      })),
    },
  ];
}

function verifierWith(
  backupInfoResolver: () => Promise<PgBackRestStanzaInfo[]>,
): SystemBackupRetentionVerifier {
  return new SystemBackupRetentionVerifier({ backupInfoResolver });
}

function missingBinaryVerifier(): SystemBackupRetentionVerifier {
  return verifierWith(async () => {
    throw new Error("spawn pgbackrest ENOENT: no such file or directory, 'pgbackrest'");
  });
}

describe('SystemBackupRetentionVerifier adapter (no database, no external binary)', () => {
  it('Case 1: fails closed with a top-level error when the backup binary is absent', async () => {
    const result = await missingBinaryVerifier().verifyDistrictBackupExpiry(BASE_PARAMS);

    expect(result.isExpired).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('ENOENT');
    expect(result.verificationMethod).toBe('PGBACKREST_CLI_NOT_FOUND');
    expect(result.oldestActiveBackupTimestamp).toBeNull();
    expect(result.totalBackupsCount).toBe(0);
  });

  it('Case 2: NODE_ENV cannot influence the fail-closed outcome', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const outcomes: Array<{
      nodeEnv: string;
      isExpired: boolean;
      hasError: boolean;
      verificationMethod: string;
    }> = [];

    try {
      const nodeEnvValues: Array<string | undefined> = [
        'production',
        'development',
        'test',
        undefined,
      ];

      for (const nodeEnv of nodeEnvValues) {
        if (nodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = nodeEnv;
        }

        const result = await missingBinaryVerifier().verifyDistrictBackupExpiry(BASE_PARAMS);
        outcomes.push({
          nodeEnv: nodeEnv ?? '<unset>',
          isExpired: result.isExpired,
          hasError: result.error !== undefined,
          verificationMethod: result.verificationMethod,
        });
      }
    } finally {
      // Never leak NODE_ENV state into other test files.
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }

    expect(outcomes).toEqual([
      {
        nodeEnv: 'production',
        isExpired: false,
        hasError: true,
        verificationMethod: 'PGBACKREST_CLI_NOT_FOUND',
      },
      {
        nodeEnv: 'development',
        isExpired: false,
        hasError: true,
        verificationMethod: 'PGBACKREST_CLI_NOT_FOUND',
      },
      {
        nodeEnv: 'test',
        isExpired: false,
        hasError: true,
        verificationMethod: 'PGBACKREST_CLI_NOT_FOUND',
      },
      {
        nodeEnv: '<unset>',
        isExpired: false,
        hasError: true,
        verificationMethod: 'PGBACKREST_CLI_NOT_FOUND',
      },
    ]);
  });

  it('Case 3: a backup started at the live-deletion instant still protects the data', async () => {
    const boundaryBackupStart = ACTUAL_LIVE_DELETION_AT;
    const verifier = verifierWith(async () =>
      buildStanzaList([{ label: '20260801-120000F', start: boundaryBackupStart }]),
    );

    const result = await verifier.verifyDistrictBackupExpiry(BASE_PARAMS);

    expect(result.isExpired).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.oldestActiveBackupTimestamp).toEqual(boundaryBackupStart);
    expect(result.verificationMethod).toBe('PGBACKREST_STANZA_INSPECTION');
  });

  it('Case 4: only post-dating backups yield expired', async () => {
    const firstPostDeletionStart = new Date(ACTUAL_LIVE_DELETION_AT.getTime() + 4 * 24 * 60 * 60 * 1000);
    const secondPostDeletionStart = new Date(
      ACTUAL_LIVE_DELETION_AT.getTime() + 9 * 24 * 60 * 60 * 1000,
    );

    const verifier = verifierWith(async () =>
      buildStanzaList([
        { label: '20260805-120000F', start: firstPostDeletionStart },
        { label: '20260810-120000F', start: secondPostDeletionStart },
      ]),
    );

    const result = await verifier.verifyDistrictBackupExpiry(BASE_PARAMS);

    expect(result.isExpired).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.totalBackupsCount).toBe(2);
    expect(result.oldestActiveBackupTimestamp).toEqual(firstPostDeletionStart);
  });

  it('Case 5: an empty stanza list fails closed instead of claiming expiry', async () => {
    const verifier = verifierWith(async () => []);

    const result = await verifier.verifyDistrictBackupExpiry(BASE_PARAMS);

    expect(result.isExpired).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.verificationMethod).toBe('PGBACKREST_NO_STANZAS');
  });

  it('Case 6: a malformed payload fails closed with a top-level error', async () => {
    // Narrow cast: the adapter guards against a resolver that does not return an
    // array, and this is the only way to feed that shape through the typed seam.
    const malformedPayload = { not: 'an array' } as unknown as PgBackRestStanzaInfo[];
    const verifier = verifierWith(async () => malformedPayload);

    const result = await verifier.verifyDistrictBackupExpiry(BASE_PARAMS);

    expect(result.isExpired).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.verificationMethod).toBe('PGBACKREST_INVALID_PAYLOAD');
  });

  it('Case 7: the real execFile path fails closed when the backup binary is absent', async () => {
    // This case deliberately injects NO backupInfoResolver, so the adapter falls
    // through to the real external-command path: it spawns the configured command
    // and takes the execFile catch block — the actual defect site. Every other case
    // exercises only the resolver seam. The command cannot exist on this machine, so
    // execFile fails immediately with ENOENT and nothing is spawned or installed.
    const verifier = new SystemBackupRetentionVerifier({
      command: 'pgbackrest-definitely-not-installed-xyz',
      timeoutMs: 5000,
    });

    const result = await verifier.verifyDistrictBackupExpiry(BASE_PARAMS);

    expect(result.isExpired).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe('');
    expect(result.verificationMethod).toBe('PGBACKREST_CLI_NOT_FOUND');
  });
});
