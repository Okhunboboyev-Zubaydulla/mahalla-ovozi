import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DbClient } from '../../adapters/db/client.js';
import { signInRateLimits } from '../../adapters/db/schema/index.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export interface RateLimitCheckResult {
  isLocked: boolean;
  retryAfterSeconds?: number;
}

export function buildRateLimitKey(ip: string, username: string): string {
  const cleanIp = ip.trim().toLowerCase();
  const cleanUser = username.trim().toLowerCase();
  return `${cleanIp}:${cleanUser}`;
}

export async function checkRateLimit(
  db: DbClient,
  key: string
): Promise<RateLimitCheckResult> {
  const [record] = await db
    .select()
    .from(signInRateLimits)
    .where(eq(signInRateLimits.key, key))
    .limit(1);

  if (!record) {
    return { isLocked: false };
  }

  const now = Date.now();
  if (record.lockedUntil && record.lockedUntil.getTime() > now) {
    const retryAfterSeconds = Math.ceil((record.lockedUntil.getTime() - now) / 1000);
    return { isLocked: true, retryAfterSeconds };
  }

  return { isLocked: false };
}

export async function recordFailedAttempt(
  db: DbClient,
  key: string
): Promise<RateLimitCheckResult> {
  const now = new Date();
  const lockedUntilThreshold = new Date(now.getTime() - LOCKOUT_DURATION_MS);

  // B6: Atomic upsert — increments failed_attempts in a single SQL statement,
  // eliminating the read-modify-write race condition under concurrent brute-force.
  const [result] = await db
    .insert(signInRateLimits)
    .values({
      id: `rl_${crypto.randomUUID()}`,
      key,
      failedAttempts: 1,
      firstFailedAt: now,
      lastFailedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: signInRateLimits.key,
      set: {
        // Reset counter if previous lockout has expired, otherwise increment
        failedAttempts: sql`
          CASE
            WHEN ${signInRateLimits.lockedUntil} IS NOT NULL
              AND ${signInRateLimits.lockedUntil} <= ${lockedUntilThreshold}
            THEN 1
            ELSE ${signInRateLimits.failedAttempts} + 1
          END
        `,
        firstFailedAt: sql`
          CASE
            WHEN ${signInRateLimits.lockedUntil} IS NOT NULL
              AND ${signInRateLimits.lockedUntil} <= ${lockedUntilThreshold}
            THEN ${now}
            ELSE ${signInRateLimits.firstFailedAt}
          END
        `,
        lastFailedAt: now,
        updatedAt: now,
      },
    })
    .returning();

  if (!result) {
    throw new Error('RATE_LIMIT_UPSERT_FAILED: .returning() returned no rows');
  }

  const isNowLocked = result.failedAttempts >= MAX_FAILED_ATTEMPTS;
  const lockedUntil = isNowLocked ? new Date(now.getTime() + LOCKOUT_DURATION_MS) : null;

  if (isNowLocked && !result.lockedUntil) {
    await db
      .update(signInRateLimits)
      .set({ lockedUntil })
      .where(eq(signInRateLimits.key, key));
  }

  return {
    isLocked: isNowLocked,
    retryAfterSeconds: isNowLocked ? Math.ceil(LOCKOUT_DURATION_MS / 1000) : undefined,
  };
}

export async function resetRateLimit(db: DbClient, key: string): Promise<void> {
  await db.delete(signInRateLimits).where(eq(signInRateLimits.key, key));
}
