import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbPool } from './client.js';
import * as schema from './schema/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MIGRATION_ADVISORY_LOCK_ID = 847291047129481;

export async function runMigrations(connectionString?: string) {
  const pool = createDbPool(connectionString);
  const client = await pool.connect();
  const db = drizzle(client, { schema });
  const migrationsFolder = path.resolve(__dirname, '../../../drizzle');

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_ID]);
    console.log(`[db:migrate] Running migrations from: ${migrationsFolder}`);
    await migrate(db, { migrationsFolder });
    console.log('[db:migrate] Migrations completed successfully.');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_ID]);
    } catch (unlockErr) {
      console.error('[db:migrate] Failed to release advisory lock:', unlockErr);
    }
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === __filename) {
  runMigrations(process.argv[2]).catch((err) => {
    console.error('[db:migrate] Migration failed:', err);
    process.exit(1);
  });
}
