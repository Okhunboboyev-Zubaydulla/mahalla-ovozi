import { createDbPool, createDbClient } from '../adapters/db/client.js';
import { createBossClient } from '../adapters/jobs/boss-client.js';
import { reconcileRestoredRetention } from '../modules/retention/restore-reconciliation.js';

export function parseDistrictArgument(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm cli:reconcile-retention [--district <districtId>] [districtId]');
      process.exit(0);
    }
    if (arg.startsWith('--district=')) {
      const val = arg.split('=')[1]?.trim();
      return val && val.length > 0 ? val : undefined;
    }
    if (arg === '--district' && i + 1 < args.length) {
      const val = args[i + 1]?.trim();
      return val && val.length > 0 ? val : undefined;
    }
    if (!arg.startsWith('-')) {
      const val = arg.trim();
      return val && val.length > 0 ? val : undefined;
    }
  }
  return undefined;
}

export async function runReconcileRetentionCli() {
  const pool = createDbPool();
  const db = createDbClient(pool);
  const boss = createBossClient();

  const targetDistrictId = parseDistrictArgument(process.argv.slice(2));

  console.log('=== Mahalla Ovozi: Disaster-Recovery Retention Reconciliation ===\n');
  if (targetDistrictId) {
    console.log(`Target District: ${targetDistrictId}`);
  } else {
    console.log('Target: ALL Registered Districts');
  }

  try {
    await boss.start();

    const result = await reconcileRestoredRetention(pool, boss, db, targetDistrictId);

    console.log('\n✅ Reconciliation Completed Successfully:');
    console.log(`- Districts Reconciled: ${result.districtsReconciled}`);
    console.log(`- Expired Topics Purged: ${result.totalTopicsPurged}`);
    console.log(`- Accepted Evidence Purged: ${result.totalEvidencePurged}`);
    console.log(`- Topic Projections Purged: ${result.totalProjectionsPurged}`);
    if (result.districtsFailed && result.districtsFailed > 0) {
      console.log(`- Districts Failed: ${result.districtsFailed}`);
    }
    console.log(`- Duration: ${result.durationMs}ms`);
  } catch (error) {
    console.error('Fatal error during retention reconciliation:', error);
    process.exitCode = 1;
  } finally {
    await boss.stop({ graceful: true, timeout: 2000 }).catch(() => {});
    await pool.end();
  }
}

if (process.argv[1]?.includes('reconcile-retention')) {
  runReconcileRetentionCli().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
