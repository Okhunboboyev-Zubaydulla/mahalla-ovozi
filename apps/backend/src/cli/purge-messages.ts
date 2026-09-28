import { createDbPool } from '../adapters/db/client.js';

export async function purgeMessagesAndTopics(): Promise<void> {
  const pool = createDbPool();
  console.log('====================================================');
  console.log('   Purging Messages, Intakes, Topics & AI Logs      ');
  console.log('====================================================\n');

  const client = await pool.connect();

  try {
    // 1. Snapshot Initial Counts
    const countQuery = async (table: string, schema = 'public'): Promise<number> => {
      try {
        const res = await client.query(`SELECT count(*)::int as count FROM ${schema}.${table}`);
        return res.rows[0]?.count ?? 0;
      } catch {
        return 0;
      }
    };

    console.log('1. Current Data Counts Before Purge:');
    const initialProjections = await countQuery('topic_projections');
    const initialEvidence = await countQuery('accepted_evidence');
    const initialVisits = await countQuery('user_dashboard_visits');
    const initialTopics = await countQuery('topics');
    const initialAiAttempts = await countQuery('ai_provider_attempts');
    const initialAiOps = await countQuery('ai_operations');
    const initialIntakes = await countQuery('telegram_intake_records');
    const initialJobs = await countQuery('job', 'pgboss');

    console.log(` - Topic Projections:     ${initialProjections}`);
    console.log(` - Accepted Evidence:      ${initialEvidence}`);
    console.log(` - User Visits:            ${initialVisits}`);
    console.log(` - Topics:                 ${initialTopics}`);
    console.log(` - AI Provider Attempts:   ${initialAiAttempts}`);
    console.log(` - AI Operations:          ${initialAiOps}`);
    console.log(` - Telegram Intakes:       ${initialIntakes}`);
    console.log(` - Queued pg-boss Jobs:    ${initialJobs}\n`);

    console.log('2. Preserved Configuration Records:');
    const preservedDistricts = await countQuery('districts');
    const preservedBots = await countQuery('district_telegram_bots');
    const preservedGroups = await countQuery('district_telegram_groups');
    const preservedAccounts = await countQuery('accounts');
    console.log(` - Districts:              ${preservedDistricts}`);
    console.log(` - Telegram Bots:          ${preservedBots}`);
    console.log(` - Telegram Groups:        ${preservedGroups}`);
    console.log(` - User Accounts:          ${preservedAccounts}\n`);

    // 2. Execute Transactional Deletion in Foreign-Key Safe Order
    console.log('3. Executing Purge in Transaction...');
    await client.query('BEGIN');

    const safeDelete = async (table: string): Promise<number> => {
      const res = await client.query(`DELETE FROM ${table}`);
      return res.rowCount ?? 0;
    };

    const delProjectionsCount = await safeDelete('topic_projections');
    const delEvidenceCount = await safeDelete('accepted_evidence');
    const delVisitsCount = await safeDelete('user_dashboard_visits');
    const delTopicsCount = await safeDelete('topics');
    const delAiAttemptsCount = await safeDelete('ai_provider_attempts');
    const delAiOpsCount = await safeDelete('ai_operations');
    const delIntakesCount = await safeDelete('telegram_intake_records');

    // Clear active/retry queue jobs from pg-boss
    let delJobsCount = 0;
    try {
      const delJobs = await client.query(
        "DELETE FROM pgboss.job WHERE name LIKE 'telegram-%' OR name LIKE 'topic-%'"
      );
      delJobsCount = delJobs.rowCount ?? 0;
    } catch {
      // pgboss schema might be empty or uninitialized
    }

    await client.query('COMMIT');
    console.log('   Transaction Committed Successfully.\n');

    // 3. Output Summary of Deleted Rows
    console.log('====================================================');
    console.log('                  PURGE SUMMARY                     ');
    console.log('====================================================');
    console.log(` - Deleted Topic Projections:   ${delProjectionsCount}`);
    console.log(` - Deleted Accepted Evidence:    ${delEvidenceCount}`);
    console.log(` - Deleted User Visits:          ${delVisitsCount}`);
    console.log(` - Deleted Topics:               ${delTopicsCount}`);
    console.log(` - Deleted AI Provider Attempts: ${delAiAttemptsCount}`);
    console.log(` - Deleted AI Operations:        ${delAiOpsCount}`);
    console.log(` - Deleted Telegram Intakes:     ${delIntakesCount}`);
    console.log(` - Deleted Queued pg-boss Jobs:  ${delJobsCount}`);
    console.log('====================================================\n');

    console.log('✅ All previous message data, topics, evidence, and AI logs have been cleared.');
    console.log('✅ District onboarding, Telegram bot connection, group mappings, and user accounts remain active and ready.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error during message purge, rolled back transaction:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.includes('purge-messages')) {
  purgeMessagesAndTopics().catch((err) => {
    console.error('Fatal purge error:', err);
    process.exit(1);
  });
}
