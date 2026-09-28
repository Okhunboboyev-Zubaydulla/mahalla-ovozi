import { sql } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import { telegramIntakeRecords } from '../../adapters/db/schema/index.js';

export interface DebugPayloadPurgeResult {
  purgedCount: number;
}

/**
 * Purges raw verbatimText and debug payloads from excluded telegram_intake_records
 * whose debug retention period (14 days) has expired.
 * Preserves the status and exclusionReason metadata.
 */
export async function purgeExpiredDebugIntakePayloads(
  db: DbClient,
  now: Date = new Date(),
): Promise<DebugPayloadPurgeResult> {
  const nowIso = now.toISOString();

  // Find and sanitize records where status is EXCLUDED, expiresAt <= nowIso, and verbatimText is not null
  const result = await db.execute(sql`
    UPDATE ${telegramIntakeRecords}
    SET
      raw_payload = jsonb_build_object(
        'status', raw_payload->>'status',
        'exclusionReason', raw_payload->>'exclusionReason',
        'reasoning', raw_payload->>'reasoning',
        'purgedAt', ${nowIso}::text
      ),
      updated_at = NOW()
    WHERE
      raw_payload->>'status' = 'EXCLUDED'
      AND raw_payload->>'expiresAt' IS NOT NULL
      AND (raw_payload->>'expiresAt')::timestamptz <= ${nowIso}::timestamptz
      AND raw_payload->>'verbatimText' IS NOT NULL
  `);

  const purgedCount = Number(result.rowCount ?? 0);
  return { purgedCount };
}
