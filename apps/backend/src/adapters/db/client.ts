import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

const { Pool } = pg;

/**
 * Resolves the PostgreSQL connection string from an explicit argument or DATABASE_URL.
 *
 * Fails closed (L2-P01-01). This previously fell back to a hardcoded DSN for the
 * DEVELOPMENT database, which made the connection target a property of the environment
 * rather than of the code, and embedded a development password in a tracked file. A caller
 * that supplies no target now gets an error instead of an unintended database.
 */
export function resolveDatabaseUrl(connectionString?: string): string {
  const url = connectionString || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'No database target: supply a connection string or set DATABASE_URL. ' +
        'Refusing to open a connection to an implicit database.',
    );
  }
  return url;
}

/**
 * Replaces the password in a connection string so the resolved target can be logged safely.
 *
 * Used wherever a database target is printed for operator confirmation, so a connection
 * string never reaches a log or console with its credential intact.
 */
export function maskDatabaseUrl(databaseUrl: string): string {
  return databaseUrl.replace(/:\/\/([^:@/]+):[^@/]*@/, '://$1:***@');
}

export function createDbPool(
  connectionString?: string,
  options?: Partial<pg.PoolConfig>,
) {
  const url = resolveDatabaseUrl(connectionString);
  const rawTimeout = process.env.DB_STATEMENT_TIMEOUT_MS;
  const parsedTimeout = rawTimeout !== undefined ? Number(rawTimeout) : NaN;
  const statementTimeout = !Number.isNaN(parsedTimeout) && parsedTimeout >= 0 ? parsedTimeout : 15000;
  return new Pool({
    connectionString: url,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: statementTimeout,
    ...options,
  });
}

export function createDbClient(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

export type DbClient = ReturnType<typeof createDbClient>;
export type DbOrTx = DbClient | Parameters<Parameters<DbClient['transaction']>[0]>[0];
// DbTransaction is the transaction-only type (the `tx` parameter inside db.transaction()).
// Use this when a function MUST run inside a caller-provided transaction.
// Use DbOrTx when a function can run against either a client or an active transaction.
export type DbTransaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];


export interface DbHealthResult {
  isHealthy: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Performs a non-blocking database connection probe with timeout boundary (AD-11).
 */
export async function checkDbHealth(
  pool: pg.Pool,
  timeoutMs: number = 3000,
): Promise<DbHealthResult> {
  const startTime = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Database health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });

    const queryPromise = pool.query('SELECT 1 AS health');
    await Promise.race([queryPromise, timeoutPromise]);

    const latencyMs = Math.round(performance.now() - startTime);
    return {
      isHealthy: true,
      latencyMs,
    };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - startTime);
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      isHealthy: false,
      latencyMs,
      error: errorMsg,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Gracefully closes the database connection pool, draining active clients.
 */
export async function closeDbPool(pool: pg.Pool): Promise<void> {
  try {
    await pool.end();
  } catch (err: unknown) {
    console.error('[db:client] Error while closing database pool:', err);
  }
}

export interface PostgresErrorPayload {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  message?: string;
}

/**
 * Safely extracts raw PostgreSQL error properties from an Error or nested Drizzle Error.cause.
 */
export function extractPostgresError(err: unknown): PostgresErrorPayload | null {
  if (!err || typeof err !== 'object') {
    return null;
  }
  const root =
    'cause' in err && err.cause && typeof err.cause === 'object'
      ? (err.cause as Record<string, unknown>)
      : (err as Record<string, unknown>);

  const code = typeof root.code === 'string' ? root.code : undefined;
  const constraint = typeof root.constraint === 'string' ? root.constraint : undefined;
  const detail = typeof root.detail === 'string' ? root.detail : undefined;
  const table = typeof root.table === 'string' ? root.table : undefined;
  const message = typeof root.message === 'string' ? root.message : undefined;

  if (!code && !constraint && !detail) {
    return null;
  }

  return { code, constraint, detail, table, message };
}

/**
 * Returns true if the error is a PostgreSQL driver error, optionally matching a specific code (e.g. '23505').
 */
export function isPostgresError(err: unknown, expectedCode?: string): boolean {
  const pgErr = extractPostgresError(err);
  if (!pgErr || !pgErr.code) {
    return false;
  }
  if (expectedCode) {
    return pgErr.code === expectedCode;
  }
  return true;
}

/**
 * Matches a PostgreSQL constraint violation against a declarative map,
 * throwing the mapped domain error if a constraint match is found.
 */
export function mapPostgresConstraintError(
  err: unknown,
  constraintMap: Record<string, () => Error>,
  defaultError?: () => Error,
): void {
  const pgErr = extractPostgresError(err);
  if (!pgErr) {
    return;
  }

  const constraint = (pgErr.constraint || '').toLowerCase();
  const detail = (pgErr.detail || '').toLowerCase();
  const message = (pgErr.message || '').toLowerCase();

  for (const [targetConstraint, errorFactory] of Object.entries(constraintMap)) {
    const target = targetConstraint.toLowerCase();
    if (
      constraint.includes(target) ||
      detail.includes(target) ||
      message.includes(target)
    ) {
      throw errorFactory();
    }
  }

  if (defaultError && (pgErr.code === '23505' || pgErr.code === '23503' || pgErr.code === '23514')) {
    throw defaultError();
  }
}


