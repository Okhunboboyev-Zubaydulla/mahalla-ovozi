import { createDbPool, createDbClient, resolveDatabaseUrl, maskDatabaseUrl } from '../adapters/db/client.js';
import { ensureDefaultAiProfiles } from '../adapters/db/seeds.js';

/**
 * Guard for a destructive CLI (L2-P01-02).
 *
 * The script deletes every district and every account but one, and the cascade reaches bots,
 * groups, intakes, topics, evidence and AI operations. Its target used to be chosen by the
 * ambient DATABASE_URL with a silent fallback, so a single mistyped invocation could destroy
 * a database that is not disposable. It now refuses production outright and requires an
 * explicit confirmation for anything else.
 */
export function resolveTargetDatabaseName(databaseUrl: string): string {
  const queryIndex = databaseUrl.indexOf('?');
  const withoutQuery = queryIndex === -1 ? databaseUrl : databaseUrl.slice(0, queryIndex);
  const lastSlash = withoutQuery.lastIndexOf('/');
  return lastSlash === -1 ? '' : withoutQuery.slice(lastSlash + 1);
}

export function assertCleanTargetAllowed(databaseUrl: string, confirmed: boolean): void {
  const name = resolveTargetDatabaseName(databaseUrl);
  if (/prod/i.test(name)) {
    throw new Error(
      `Refusing to clean database "${name}": the name looks like production. ` +
        'This CLI has no production mode.',
    );
  }
  if (!confirmed) {
    throw new Error(
      `Refusing to clean database "${name}" without confirmation. ` +
        'Re-run with --confirm once you have verified the target printed below.',
    );
  }
}

export async function cleanTestData(options?: { confirmed?: boolean }) {
  const confirmed = options?.confirmed === true;
  const databaseUrl = resolveDatabaseUrl();
  assertCleanTargetAllowed(databaseUrl, confirmed);
  const pool = createDbPool(databaseUrl);
  const db = createDbClient(pool);
  console.log(`Target database: ${maskDatabaseUrl(databaseUrl)}`);
  console.log(`Database name:   ${resolveTargetDatabaseName(databaseUrl)}`);
  console.log('=== Cleaning Test Fixtures\n');

  try {
    // 1. Initial count
    const initialDistricts = await pool.query('SELECT count(*) FROM districts');
    const initialAccounts = await pool.query('SELECT count(*) FROM accounts');
    console.log(`Current Districts: ${initialDistricts.rows[0].count}`);
    console.log(`Current Accounts: ${initialAccounts.rows[0].count}\n`);

    // 2. Delete test sessions (keep Zubaydulla sessions)
    const delSessions = await pool.query(
      "DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE username != 'Zubaydulla')"
    );
    console.log(`Deleted ${delSessions.rowCount} test sessions.`);

    // 3. Delete non-Zubaydulla accounts
    const delAccounts = await pool.query(
      "DELETE FROM accounts WHERE username != 'Zubaydulla'"
    );
    console.log(`Deleted ${delAccounts.rowCount} test accounts.`);

    // 4. Delete all districts (cascades to bots, groups, intakes, topics, evidence, ai operations)
    const delDistricts = await pool.query('DELETE FROM districts');
    console.log(`Deleted ${delDistricts.rowCount} test districts.`);

    // 5. Delete stale pending test jobs from pg-boss queue (if table exists)
    try {
      const delJobs = await pool.query(
        "DELETE FROM pgboss.job WHERE state IN ('created', 'retry', 'active')"
      );
      console.log(`Deleted ${delJobs.rowCount} stale test queue jobs.`);
    } catch (err: unknown) {
      // The pgboss schema may not be initialized yet; log so the failure is not invisible.
      console.warn('Skipped queue cleanup:', err instanceof Error ? err.message : String(err));
    }

    // 6. Ensure default Ollama AI profiles and baseline global analysis settings
    await ensureDefaultAiProfiles(db);
    console.log('Ensured default Ollama gemma4:12b baseline AI profiles and global configuration.');

    // 7. Verify final counts
    const finalDistricts = await pool.query('SELECT count(*) FROM districts');
    const finalAccounts = await pool.query('SELECT count(*) FROM accounts');
    console.log(`\n✅ Final Districts Count: ${finalDistricts.rows[0].count}`);
    console.log(`✅ Final Accounts Count: ${finalAccounts.rows[0].count}`);

    const remainingAccounts = await pool.query('SELECT id, username, role FROM accounts');
    console.log('\nRemaining accounts:', remainingAccounts.rows);
  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.includes('clean-test-data')) {
  cleanTestData({ confirmed: process.argv.includes('--confirm') }).catch((err) => {
    console.error('Fatal cleanup error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
