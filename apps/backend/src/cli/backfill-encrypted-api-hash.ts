import { createDbPool, createDbClient } from '../adapters/db/client.js';
import { backfillEncryptedApiHash } from '../modules/userbot-session/userbot-session-service.js';
import { assertEncryptionKeyConfigured, getActiveKeyVersion } from '../adapters/crypto/token-cipher.js';

/**
 * Standalone operational CLI routine to backfill encrypted API hash envelope from plaintext values.
 *
 * Usage:
 *   pnpm cli:backfill-api-hash
 */
async function main(): Promise<void> {
  console.log('[cli:backfill-api-hash] Verifying master encryption key configuration...');
  assertEncryptionKeyConfigured();

  const pool = createDbPool();
  const db = createDbClient(pool);

  try {
    const targetVersion = getActiveKeyVersion();
    console.log(`[cli:backfill-api-hash] Starting backfill to active key version: '${targetVersion}'...`);

    const result = await backfillEncryptedApiHash(db, { targetKeyVersion: targetVersion });
    if (result.totalRows === 0) {
      console.log('[cli:backfill-api-hash] Plaintext api_hash column is no longer present or zero unmigrated rows remain; backfill is complete:', result);
    } else {
      console.log('[cli:backfill-api-hash] Backfill finished successfully:', result);
    }

    await pool.end();
    process.exit(0);
  } catch (err: unknown) {
    console.error('[cli:backfill-api-hash] Backfill failed:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

if (process.argv[1]?.includes('backfill-encrypted-api-hash')) {
  main();
}
