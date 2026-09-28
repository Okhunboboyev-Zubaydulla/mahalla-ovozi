import { createDbPool } from '../adapters/db/client.js';

export async function viewEvidence(): Promise<void> {
  const pool = createDbPool();
  const client = await pool.connect();

  try {
    console.log('\n==============================================================');
    console.log('                 ACCEPTED CIVIC EVIDENCE                      ');
    console.log('==============================================================\n');

    const res = await client.query(`
      SELECT 
        ae.mahalla_name AS "Mahalla",
        t.primary_lane AS "Lane",
        ae.telegram_message_id AS "Msg ID",
        ae.verbatim_text AS "Verbatim Text",
        TO_CHAR(ae.original_timestamp, 'YYYY-MM-DD HH24:MI:SS') AS "Timestamp",
        ae.id AS "Evidence ID"
      FROM accepted_evidence ae
      LEFT JOIN topics t ON ae.topic_id = t.id
      ORDER BY ae.original_timestamp DESC
      LIMIT 25;
    `);

    if (res.rows.length === 0) {
      console.log('No accepted evidence records found in the database yet.\n');
    } else {
      console.table(res.rows);
      console.log(`Total records displayed: ${res.rows.length}\n`);
    }
  } catch (err) {
    console.error('Error fetching evidence:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

viewEvidence().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
