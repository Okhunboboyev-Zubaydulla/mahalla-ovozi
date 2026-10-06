import { createDbPool, createDbClient, maskDatabaseUrl, resolveDatabaseUrl } from '../adapters/db/client.js';
import {
  verifyApiHashEnvelopes,
  type EnvelopeScanSection,
} from '../modules/userbot-session/userbot-session-service.js';

const CLI_TAG = 'cli:verify-api-hash-envelopes';

/**
 * Prints one envelope section. Counts go to stdout so they can be read by a human or captured by a
 * pipeline; offending rows go to stderr so they never contaminate that machine-readable stream.
 */
function reportSection(label: string, section: EnvelopeScanSection): void {
  console.log(`[${CLI_TAG}] ${label} complete envelopes: ${section.completeCount}`);
  console.log(
    `[${CLI_TAG}] ${label} all-null envelopes (credential legitimately absent): ${section.absentCount}`,
  );
  console.log(`[${CLI_TAG}] ${label} partial (corrupt) envelopes: ${section.partialCount}`);

  for (const row of section.partialRows) {
    console.error(
      `[${CLI_TAG}] CORRUPT ${label} row id='${row.id}' district='${row.districtId}' status='${row.status}'`,
    );
  }

  if (section.partialRowsTruncated) {
    console.error(
      `[${CLI_TAG}] Offending ${label} id list truncated to the first ${section.partialRows.length} of ${section.partialCount} rows.`,
    );
  }
}

/**
 * Read-only preflight routine that reports the health of every stored encrypted credential
 * envelope: the apiHash envelope and the sessionString envelope.
 *
 * It issues SELECT statements only: no writes, no schema changes, no backfills. Exit code 0 means
 * every row is either fully populated or legitimately empty on BOTH envelopes; exit code 1 means
 * at least one row holds a corrupt PARTIAL envelope on either, so the routine can gate a deploy.
 *
 * Usage:
 *   pnpm cli:verify-api-hash-envelopes
 */
async function main(): Promise<void> {
  console.log(`[${CLI_TAG}] Scanning database target: ${maskDatabaseUrl(resolveDatabaseUrl())}`);

  const pool = createDbPool();
  const db = createDbClient(pool);

  try {
    const report = await verifyApiHashEnvelopes(db);

    console.log(`[${CLI_TAG}] Total rows scanned: ${report.totalRows}`);
    reportSection('apiHash', report);
    reportSection('session', report.session);

    if (report.partialCount > 0) {
      console.error(
        `[${CLI_TAG}] FAILED: ${report.partialCount} row(s) hold a corrupt apiHash envelope, of which ${report.activePartialCount} are ACTIVE.`,
      );
    }

    if (report.session.partialCount > 0) {
      console.error(
        `[${CLI_TAG}] FAILED: ${report.session.partialCount} row(s) hold a corrupt session envelope, of which ${report.session.activePartialCount} are ACTIVE.`,
      );
    }

    if (report.partialCount > 0 || report.session.partialCount > 0) {
      await pool.end();
      process.exit(1);
    }

    console.log(
      `[${CLI_TAG}] OK: no corrupt credential envelopes found across ${report.totalRows} row(s).`,
    );
    await pool.end();
    process.exit(0);
  } catch (err: unknown) {
    console.error(`[${CLI_TAG}] Verification failed:`, err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

if (process.argv[1]?.includes('verify-api-hash-envelopes')) {
  main();
}
