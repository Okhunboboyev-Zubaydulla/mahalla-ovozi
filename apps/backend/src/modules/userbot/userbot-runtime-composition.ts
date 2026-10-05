/**
 * Userbot runtime composition guard.
 *
 * The userbot process must never run with one of its two outbound dependencies missing. A
 * process without a job-queue client can only drop normalized messages, which is the
 * silent-loss failure this guard exists to make impossible by construction: a missing
 * dependency aborts startup with a named cause instead of surfacing as a per-message warning
 * nobody reads.
 *
 * The invariant lives in the userbot module rather than in the entrypoint so the connection
 * manager's defensive boundary check and the startup guard share one definition without the
 * module layer depending upward on an entrypoint.
 */

import type pg from 'pg';
import type PgBoss from 'pg-boss';

export class UserbotRuntimeCompositionError extends Error {
  readonly code = 'USERBOT_RUNTIME_MISCONFIGURED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'UserbotRuntimeCompositionError';
  }
}

export interface UserbotRuntimeComposition {
  pool: pg.Pool | null | undefined;
  boss: PgBoss | null | undefined;
}

export interface UserbotRuntimeCompositionReport {
  hasPool: boolean;
  hasJobQueueClient: boolean;
}

/**
 * Reports which of the two runtime dependencies are present. Logged on startup so a
 * misconfiguration is visible in the first lines of the log.
 */
export function describeUserbotRuntimeComposition(
  composition: UserbotRuntimeComposition,
): UserbotRuntimeCompositionReport {
  return {
    hasPool: Boolean(composition.pool),
    hasJobQueueClient: Boolean(composition.boss),
  };
}

/**
 * Fails fast when either dependency is absent, naming exactly what is missing. Both are
 * required: the pool without the queue produces Accepted Evidence that never gets processed,
 * and the queue without the pool cannot persist the evidence the queue is meant to process.
 */
export function assertUserbotRuntimeComposition(
  composition: UserbotRuntimeComposition,
): void {
  const missing: string[] = [];

  if (!composition.pool) {
    missing.push('database pool');
  }
  if (!composition.boss) {
    missing.push('job-queue client');
  }

  if (missing.length > 0) {
    throw new UserbotRuntimeCompositionError(
      `Userbot runtime cannot start: ${missing.join(' and ')} not constructed. ` +
        'The userbot process requires both a database pool and a job-queue client.',
    );
  }
}
