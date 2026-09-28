import { eq, and } from 'drizzle-orm';
import { DbClient } from '../../adapters/db/client.js';
import { accounts, districts, sessions, Account, Session } from '../../adapters/db/schema/index.js';
import { cryptoService } from '../../adapters/crypto/index.js';
import {
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
  buildRateLimitKey,
} from './rate-limiter.js';
import { createSession, revokeAllAccountSessions } from './session-manager.js';
import { recordAuditEvent } from '../audit/audit-service.js';

// ─── Error classes ────────────────────────────────────────────────────────────

export class InvalidCredentialsError extends Error {
  readonly code = 'INVALID_CREDENTIALS' as const;
  constructor() {
    super('Нотўғри фойдаланувчи номи ёки парол.');
    this.name = 'InvalidCredentialsError';
  }
}

export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED' as const;
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super('Уринишлар сони ошди. Илтимос, кейинроқ қайта уриниб кўринг.');
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class DistrictNotActiveError extends Error {
  readonly code = 'DISTRICT_NOT_ACTIVE' as const;
  constructor() {
    super('Туман ҳали фаоллаштирилмаган ёки фаолияти тўхтатилган.');
    this.name = 'DistrictNotActiveError';
  }
}

export class CredentialConcurrencyConflictError extends Error {
  readonly code = 'CREDENTIAL_CONCURRENCY_CONFLICT' as const;
  constructor() {
    super('Аккаунт маълумотлари янгиланган. Илтимос, қайта тизимга киринг.');
    this.name = 'CredentialConcurrencyConflictError';
  }
}

export class InvalidPasswordPolicyError extends Error {
  readonly code = 'VALIDATION_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPasswordPolicyError';
  }
}

// ─── Pre-computed dummy hash ──────────────────────────────────────────────────

// B1: Equalise timing when account is not found to prevent user enumeration
// via response-time measurement. Computed once at module load.
const DUMMY_HASH = await cryptoService.passwords.hash('dummy-timing-equaliser-password-2026');

// ─── Sign-in result type ──────────────────────────────────────────────────────

export interface SignInResult {
  actor: {
    id: string;
    role: string;
    username: string;
    districtId: string | null;
    mustChangePassword: boolean;
  };
  sessionToken: string;
  expiresAt: Date;
}

// ─── First-login password change result ──────────────────────────────────────

export interface ChangeFirstLoginPasswordResult {
  actor: {
    id: string;
    role: string;
    username: string;
    districtId: string | null;
    mustChangePassword: false;
  };
}

// ─── Functions ────────────────────────────────────────────────────────────────

/**
 * Authenticates a user: rate-limit check, account lookup, Argon2id verify,
 * status check, district-active check (for DISTRICT_HOKIM), session creation.
 * Throws typed errors for all failure modes; the route handles HTTP mapping.
 */
export async function signIn(
  db: DbClient,
  input: { username: string; password: string; ip: string; userAgent: string | undefined },
): Promise<SignInResult> {
  const { username, password, ip, userAgent } = input;
  const rateLimitKey = buildRateLimitKey(ip, username);

  // Check rate limit
  const rateLimitStatus = await checkRateLimit(db, rateLimitKey);
  if (rateLimitStatus.isLocked) {
    throw new RateLimitedError(rateLimitStatus.retryAfterSeconds ?? null);
  }

  // Look up account
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.username, username.trim()))
    .limit(1);

  if (!account) {
    // B1: Run dummy Argon2id verification to equalise response time and prevent
    // user enumeration via timing differences between found/not-found paths.
    await cryptoService.passwords.verify(DUMMY_HASH, password);
    await recordFailedAttempt(db, rateLimitKey);
    await recordAuditEvent(db, {
      action: 'AUTH_SIGN_IN_FAILURE',
      ipAddress: ip,
      userAgent,
      metadata: { username, reason: 'ACCOUNT_NOT_FOUND' },
    });
    throw new InvalidCredentialsError();
  }

  // Verify password with Argon2id
  const isPasswordValid = await cryptoService.passwords.verify(account.passwordHash, password);
  if (!isPasswordValid) {
    await recordFailedAttempt(db, rateLimitKey);
    await recordAuditEvent(db, {
      actorId: account.id,
      actorRole: account.role,
      districtId: account.districtId || undefined,
      action: 'AUTH_SIGN_IN_FAILURE',
      ipAddress: ip,
      userAgent,
      metadata: { username, reason: 'INVALID_PASSWORD' },
    });
    throw new InvalidCredentialsError();
  }

  // Security check: Verify account status is ACTIVE only AFTER password verification
  // to prevent probing disabled account statuses.
  if (account.status !== 'ACTIVE') {
    await recordFailedAttempt(db, rateLimitKey);
    await recordAuditEvent(db, {
      actorId: account.id,
      actorRole: account.role,
      districtId: account.districtId || undefined,
      action: 'AUTH_SIGN_IN_FAILURE',
      ipAddress: ip,
      userAgent,
      metadata: { username, reason: 'ACCOUNT_DISABLED' },
    });
    throw new InvalidCredentialsError();
  }

  // Security check: If role is DISTRICT_HOKIM, ensure assigned district is ACTIVE (AC 6)
  if (account.role === 'DISTRICT_HOKIM') {
    if (!account.districtId) {
      throw new DistrictNotActiveError();
    }

    const [district] = await db
      .select()
      .from(districts)
      .where(eq(districts.id, account.districtId))
      .limit(1);

    if (!district || (district.status !== 'ACTIVE' && district.status !== 'GRACE')) {
      await recordAuditEvent(db, {
        actorId: account.id,
        actorRole: account.role,
        districtId: account.districtId || undefined,
        action: 'AUTH_SIGN_IN_FAILURE',
        ipAddress: ip,
        userAgent,
        metadata: {
          username,
          districtId: account.districtId,
          districtStatus: district?.status ?? 'NOT_FOUND',
          reason: 'DISTRICT_NOT_ACTIVE',
        },
      });
      throw new DistrictNotActiveError();
    }
  }

  // Reset rate limiter on successful authentication
  await resetRateLimit(db, rateLimitKey);

  // Create session with concurrency check
  let sessionResult;
  try {
    sessionResult = await createSession(db, {
      accountId: account.id,
      expectedCredentialVersion: account.credentialVersion,
    });
  } catch (err) {
    // B5: Only concurrency conflicts (credential changed between login and session creation)
    // return 401. All other errors propagate as 500 via the global error handler.
    const message = err instanceof Error ? err.message : '';
    if (message === 'CREDENTIAL_CONCURRENCY_CONFLICT') {
      throw new InvalidCredentialsError();
    }
    throw err;
  }

  await recordAuditEvent(db, {
    actorId: account.id,
    actorRole: account.role,
    districtId: account.districtId || undefined,
    action: 'AUTH_SIGN_IN_SUCCESS',
    ipAddress: ip,
    userAgent,
    metadata: { username: account.username },
  });

  return {
    actor: {
      id: account.id,
      role: account.role,
      username: account.username,
      districtId: account.districtId ?? null,
      mustChangePassword: account.mustChangePassword,
    },
    sessionToken: sessionResult.sessionToken,
    expiresAt: sessionResult.expiresAt,
  };
}

/**
 * Validates the current temporary password and replaces it with a permanent one.
 * Atomic: updates passwordHash + mustChangePassword=false + bumps credentialVersion,
 * syncs the caller's session, revokes all other sessions, and logs an audit event.
 */
export async function changeFirstLoginPassword(
  db: DbClient,
  input: {
    account: Account;
    session: Session;
    currentPassword: string;
    newPassword: string;
    ip: string;
    userAgent: string | undefined;
  },
): Promise<ChangeFirstLoginPasswordResult> {
  const { account, session, currentPassword, newPassword, ip, userAgent } = input;

  // Verify current temporary password against stored hash
  const isCurrentValid = await cryptoService.passwords.verify(account.passwordHash, currentPassword);
  if (!isCurrentValid) {
    await recordAuditEvent(db, {
      actorId: account.id,
      actorRole: account.role,
      districtId: account.districtId || undefined,
      action: 'AUTH_FIRST_LOGIN_PASSWORD_CHANGE_FAILED',
      ipAddress: ip,
      userAgent,
      metadata: { username: account.username, reason: 'INVALID_CURRENT_PASSWORD' },
    });
    throw new InvalidCredentialsError();
  }

  // Disallow retaining identical temporary password
  if (currentPassword === newPassword) {
    throw new InvalidPasswordPolicyError('Янги парол вақтинчалик парол билан бир хил бўлиши мумкин эмас.');
  }

  // Validate new password against policy (>=15 chars, <=128 code points, not on blocklist)
  const policyResult = cryptoService.passwords.validate(newPassword);
  if (!policyResult.isValid) {
    throw new InvalidPasswordPolicyError(policyResult.message || 'Янги парол талабларга жавоб бермайди.');
  }

  // Hash new password with Argon2id
  const newPasswordHash = await cryptoService.passwords.hash(newPassword);
  const now = new Date();
  const newCredentialVersion = account.credentialVersion + 1;

  // Atomic transaction: update account, sync current session version, revoke other sessions, log audit event
  try {
    await db.transaction(async (tx) => {
      const [updatedAccount] = await tx
        .update(accounts)
        .set({
          passwordHash: newPasswordHash,
          mustChangePassword: false,
          credentialVersion: newCredentialVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(accounts.id, account.id),
            eq(accounts.credentialVersion, account.credentialVersion)
          )
        )
        .returning();

      if (!updatedAccount) {
        throw new Error('CREDENTIAL_CONCURRENCY_CONFLICT');
      }

      // Atomically update current session credentialVersion so it remains valid
      await tx
        .update(sessions)
        .set({
          credentialVersion: newCredentialVersion,
          lastActiveAt: now,
        })
        .where(eq(sessions.id, session.id));

      // Revoke all other active sessions for that account (preserves current session)
      await revokeAllAccountSessions(tx, account.id, session.id);

      // Record audit event
      await recordAuditEvent(tx, {
        actorId: account.id,
        actorRole: account.role,
        districtId: account.districtId || undefined,
        action: 'ACCOUNT_HOKIM_FIRST_LOGIN_PASSWORD_CHANGED',
        ipAddress: ip,
        userAgent,
        metadata: {
          accountId: account.id,
          districtId: account.districtId,
          username: account.username,
          credentialVersion: newCredentialVersion,
        },
      });
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'CREDENTIAL_CONCURRENCY_CONFLICT') {
      throw new CredentialConcurrencyConflictError();
    }
    throw err;
  }

  return {
    actor: {
      id: account.id,
      role: account.role,
      username: account.username,
      districtId: account.districtId ?? null,
      mustChangePassword: false,
    },
  };
}
