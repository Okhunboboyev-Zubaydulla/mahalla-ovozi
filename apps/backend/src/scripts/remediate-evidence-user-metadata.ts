/**
 * Standalone Data Remediation Script
 * Restores degraded accepted_evidence.user_metadata from telegram_intake_records.raw_payload.
 *
 * Usage:
 *   # Dry-run inspection
 *   pnpm --filter @mahalla-ovozi/backend exec tsx src/scripts/remediate-evidence-user-metadata.ts --dry-run
 *
 *   # Apply remediation to database
 *   pnpm --filter @mahalla-ovozi/backend exec tsx src/scripts/remediate-evidence-user-metadata.ts --apply
 */
import pg from 'pg';
import { extractTelegramUserMetadata } from '../adapters/jobs/boss-client.js';
import { resolveDatabaseUrl, maskDatabaseUrl } from '../adapters/db/client.js';

interface DegradedEvidenceRow {
  id: string;
  telegram_message_id: string;
  telegram_user_id: string | null;
  current_metadata: Record<string, unknown> | null;
  raw_payload: unknown;
}

async function main(): Promise<void> {
  const isApply = process.argv.includes('--apply');

  // Fails closed like createDbPool (L2-P01-01): no implicit development-database fallback.
  const connectionString = resolveDatabaseUrl();

  console.log(`[Remediation] Mode: ${isApply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[Remediation] Connecting to ${maskDatabaseUrl(connectionString)}...`);

  const pool = new pg.Pool({ connectionString });

  try {
    const query = `
      SELECT 
        ae.id,
        ae.telegram_message_id,
        ae.telegram_user_id,
        ae.user_metadata as current_metadata,
        tir.raw_payload
      FROM accepted_evidence ae
      JOIN telegram_intake_records tir ON tir.id = ae.intake_record_id
      WHERE ae.user_metadata->>'username' IS NULL 
        AND ae.user_metadata->>'firstName' IS NULL
      ORDER BY ae.original_timestamp ASC
    `;

    const { rows } = await pool.query<DegradedEvidenceRow>(query);
    console.log(`[Remediation] Found ${rows.length} evidence records with missing username/firstName.`);

    let repairableCount = 0;
    let appliedCount = 0;

    for (const row of rows) {
      const extracted = extractTelegramUserMetadata(row.raw_payload, row.telegram_user_id);

      if (extracted && (extracted.username || extracted.firstName || extracted.lastName)) {
        repairableCount++;
        const newMetadata = {
          ...row.current_metadata,
          ...extracted,
        };

        if (isApply) {
          await pool.query(
            'UPDATE accepted_evidence SET user_metadata = $1 WHERE id = $2',
            [JSON.stringify(newMetadata), row.id],
          );
          appliedCount++;
          console.log(
            `[APPLIED] Evidence ${row.id} (Msg #${row.telegram_message_id}) -> ${JSON.stringify(newMetadata)}`,
          );
        } else {
          console.log(
            `[DRY-RUN] Evidence ${row.id} (Msg #${row.telegram_message_id}) -> Can restore: ${JSON.stringify(newMetadata)}`,
          );
        }
      } else {
        console.log(
          `[SKIP] Evidence ${row.id} (Msg #${row.telegram_message_id}) -> No sender profile in raw_payload.`,
        );
      }
    }

    console.log(`\n[Remediation Summary]`);
    console.log(`Total inspected:   ${rows.length}`);
    console.log(`Total repairable:  ${repairableCount}`);
    console.log(`Total updated:     ${appliedCount}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[Remediation Error]', err);
  process.exit(1);
});
