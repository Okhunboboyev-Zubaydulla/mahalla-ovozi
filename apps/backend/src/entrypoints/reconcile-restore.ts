import { createDbPool, createDbClient } from '../adapters/db/client.js';
import { createBossClient, initBossQueues } from '../adapters/jobs/boss-client.js';
import { FileExternalTombstoneStore } from '../adapters/storage/external-tombstone-store.js';
import { reconcileDisasterRestore } from '../modules/retention/restore-reconciliation.js';

/**
 * Standalone CLI command for Disaster Restore Reconciliation.
 * Executed after PostgreSQL pgBackRest restore before enabling web ingress and background workers.
 * Governed by FR-32, AD-11.
 *
 * Usage:
 *   pnpm reconcile-restore
 */
async function main() {
  console.log('[reconcile-restore] Starting disaster recovery restore reconciliation...');
  const startTime = Date.now();

  const pool = createDbPool();
  const db = createDbClient(pool);
  const boss = createBossClient();
  const tombstoneStore = new FileExternalTombstoneStore();

  try {
    await boss.start();
    await initBossQueues(boss);

    const result = await reconcileDisasterRestore(pool, boss, db, {
      tombstoneStore,
      actor: { id: null, role: 'SYSTEM' },
    });

    const elapsedMs = Date.now() - startTime;
    console.log(
      JSON.stringify(
        {
          status: 'SUCCESS',
          event: 'DISASTER_RESTORE_RECONCILIATION_CLI_COMPLETED',
          elapsedMs,
          result,
        },
        null,
        2,
      ),
    );

    await boss.stop({ graceful: true, timeout: 5000 }).catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          status: 'FAILED',
          event: 'DISASTER_RESTORE_RECONCILIATION_CLI_FAILED',
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        null,
        2,
      ),
    );

    await boss.stop({ graceful: false }).catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();
