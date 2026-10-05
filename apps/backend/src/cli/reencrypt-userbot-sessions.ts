import { createDbPool, createDbClient } from '../adapters/db/client.js';
import { reencryptUserbotSessions } from '../modules/userbot-session/userbot-session-service.js';
import { assertEncryptionKeyConfigured, getActiveKeyVersion } from '../adapters/crypto/token-cipher.js';

/**
 * Standalone operational CLI routine to re-encrypt stored userbot sessions to the active key version.
 * Run during key rotation dual-key window.
 *
 * Usage:
 *   pnpm cli:reencrypt-userbot
 */
async function main(): Promise<void> {
  console.log('[cli:reencrypt-userbot] Verifying master encryption key configuration...');
  assertEncryptionKeyConfigured();

  const pool = createDbPool();
  const db = createDbClient(pool);

  try {
    const targetVersion = getActiveKeyVersion();
    console.log(`[cli:reencrypt-userbot] Starting re-encryption to active key version: '${targetVersion}'...`);

    const result = await reencryptUserbotSessions(db, { targetKeyVersion: targetVersion });
    console.log('[cli:reencrypt-userbot] Re-encryption finished successfully:', result);

    await pool.end();
    process.exit(0);
  } catch (err: unknown) {
    console.error('[cli:reencrypt-userbot] Re-encryption failed:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

if (process.argv[1]?.includes('reencrypt-userbot-sessions')) {
  main();
}
