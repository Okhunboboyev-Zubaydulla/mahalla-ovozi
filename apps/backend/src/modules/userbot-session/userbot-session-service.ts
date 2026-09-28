import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../adapters/db/client.js';
import {
  districts,
  districtTelegramUserbotSessions,
  DistrictTelegramUserbotSession,
} from '../../adapters/db/schema/index.js';
import { encryptToken, decryptToken } from '../../adapters/crypto/token-cipher.js';
import { recordAuditEvent } from '../audit/audit-service.js';
import { DistrictNotFoundError } from '../districts/districts-service.js';

export type UserbotSessionStatus = 'PENDING' | 'ACTIVE' | 'BANNED' | 'DISABLED';

export class ConflictError extends Error {
  readonly code: string = 'CONFLICT';
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class UserbotSessionNotFoundError extends Error {
  readonly code = 'USERBOT_SESSION_NOT_FOUND' as const;
  readonly statusCode = 404;
  constructor(districtId: string) {
    super(`No userbot session found for district ${districtId}.`);
    this.name = 'UserbotSessionNotFoundError';
  }
}

export class SessionBannedError extends ConflictError {
  override readonly code = 'USERBOT_SESSION_BANNED' as const;
  constructor(districtId: string, message?: string) {
    super(message ?? `Userbot session for district ${districtId} is BANNED and cannot be re-enabled.`);
    this.name = 'SessionBannedError';
  }
}

export class UserbotSessionDisabledError extends ConflictError {
  override readonly code = 'USERBOT_SESSION_DISABLED' as const;
  constructor(districtId: string) {
    super(
      `Userbot session for district ${districtId} is DISABLED via kill switch. Re-enable the session before bootstrapping.`,
    );
    this.name = 'UserbotSessionDisabledError';
  }
}

export interface PublicDistrictUserbotSession {
  id: string;
  districtId: string;
  phoneNumber: string;
  apiId: string;
  status: UserbotSessionStatus;
  hasSession: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DecryptedUserbotSession {
  id: string;
  districtId: string;
  phoneNumber: string;
  apiId: string;
  apiHash: string | null;
  sessionString: string | null;
  status: UserbotSessionStatus;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionActionActor {
  actorId?: string | null;
  actorRole?: string | null;
}

export interface CreateDistrictUserbotSessionParams {
  districtId: string;
  phoneNumber: string;
  apiId: string;
  apiHash?: string | null;
  sessionString?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  customEncryptionKey?: string;
}

export interface UpdateUserbotSessionStatusParams {
  status?: UserbotSessionStatus;
  lastSeenAt?: Date | null;
  sessionString?: string | null;
  customEncryptionKey?: string;
  actorId?: string | null;
  actorRole?: string | null;
}

export interface UserbotSessionStatusUpdateAuditMetadata {
  previousStatus: UserbotSessionStatus;
  newStatus: UserbotSessionStatus;
  lastSeenAt?: string | null;
  hasSessionString?: boolean;
  secretsCleared?: boolean;
}

/**
 * Formats a database record into a safe, public view.
 * Strictly omits encrypted tokens, IVs, authentication tags, and encryption key versions.
 */
export function formatPublicUserbotSession(
  row: DistrictTelegramUserbotSession,
): PublicDistrictUserbotSession {
  return {
    id: row.id,
    districtId: row.districtId,
    phoneNumber: row.phoneNumber,
    apiId: row.apiId,
    status: row.status as UserbotSessionStatus,
    hasSession: Boolean(row.sessionEncrypted && row.sessionEncrypted.length > 0),
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Creates a District-scoped userbot session record.
 * - Rejects if district does not exist with DistrictNotFoundError.
 * - Rejects if session already exists for the District with ConflictError.
 * - Encrypts the session string using AES-256-GCM if provided.
 * - Initializes status to PENDING.
 * - Emits USERBOT_SESSION_CREATED audit event.
 */
export async function createDistrictUserbotSession(
  db: DbOrTx,
  params: CreateDistrictUserbotSessionParams,
): Promise<PublicDistrictUserbotSession> {
  const districtId = params.districtId.trim();

  // 1. Verify district exists
  const [district] = await db
    .select({ id: districts.id })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  // 2. Reject duplicate session for the same District (1 session per District rule)
  const [existing] = await db
    .select({ id: districtTelegramUserbotSessions.id })
    .from(districtTelegramUserbotSessions)
    .where(eq(districtTelegramUserbotSessions.districtId, districtId))
    .limit(1);

  if (existing) {
    throw new ConflictError(`District ${districtId} already has a userbot session.`);
  }

  // 3. Encrypt session string if provided
  let sessionEncrypted: string | null = null;
  let sessionIv: string | null = null;
  let sessionTag: string | null = null;
  let sessionKeyVersion: string = 'v1';

  if (params.sessionString && params.sessionString.trim().length > 0) {
    const encrypted = encryptToken(
      params.sessionString.trim(),
      'v1',
      params.customEncryptionKey,
    );
    sessionEncrypted = encrypted.encryptedToken;
    sessionIv = encrypted.tokenIv;
    sessionTag = encrypted.tokenTag;
    sessionKeyVersion = encrypted.tokenKeyVersion;
  }

  const sessionId = `dtus_${crypto.randomUUID()}`;

  try {
    const [created] = await db
      .insert(districtTelegramUserbotSessions)
      .values({
        id: sessionId,
        districtId,
        phoneNumber: params.phoneNumber.trim(),
        apiId: String(params.apiId).trim(),
        apiHash: params.apiHash?.trim() || null,
        sessionEncrypted,
        sessionIv,
        sessionTag,
        sessionKeyVersion,
        status: 'PENDING',
      })
      .returning();

    if (!created) {
      throw new Error('Failed to insert userbot session.');
    }

    // 4. Emit audit record
    await recordAuditEvent(db, {
      districtId,
      actorId: params.actorId || null,
      actorRole: params.actorRole || null,
      action: 'USERBOT_SESSION_CREATED',
      metadata: {
        sessionId: created.id,
        phoneNumber: params.phoneNumber.trim(),
        hasSession: Boolean(sessionEncrypted),
      },
    });

    return formatPublicUserbotSession(created);
  } catch (err: unknown) {
    // Catch unique constraint collision on districtId under race conditions
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
      throw new ConflictError(`District ${districtId} already has a userbot session.`);
    }
    throw err;
  }
}

/**
 * Retrieves the public/safe session record for a given District.
 * Never returns raw session, IV, or authentication tag.
 */
export async function getDistrictUserbotSession(
  db: DbOrTx,
  districtId: string,
): Promise<PublicDistrictUserbotSession | null> {
  const [session] = await db
    .select()
    .from(districtTelegramUserbotSessions)
    .where(eq(districtTelegramUserbotSessions.districtId, districtId.trim()))
    .limit(1);

  if (!session) {
    return null;
  }

  return formatPublicUserbotSession(session);
}

/**
 * Internal method for worker/connect service to retrieve decrypted session string and API credentials.
 */
export async function getDecryptedUserbotSession(
  db: DbOrTx,
  districtId: string,
  customEncryptionKey?: string,
): Promise<DecryptedUserbotSession | null> {
  const [session] = await db
    .select()
    .from(districtTelegramUserbotSessions)
    .where(eq(districtTelegramUserbotSessions.districtId, districtId.trim()))
    .limit(1);

  if (!session) {
    return null;
  }

  let sessionString: string | null = null;
  if (session.sessionEncrypted && session.sessionIv && session.sessionTag) {
    sessionString = decryptToken(
      {
        encryptedToken: session.sessionEncrypted,
        tokenIv: session.sessionIv,
        tokenTag: session.sessionTag,
      },
      customEncryptionKey,
    );
  }

  return {
    id: session.id,
    districtId: session.districtId,
    phoneNumber: session.phoneNumber,
    apiId: session.apiId,
    apiHash: session.apiHash,
    sessionString,
    status: session.status as UserbotSessionStatus,
    lastSeenAt: session.lastSeenAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/**
 * Immediate kill switch: sets status to DISABLED.
 * Emits USERBOT_SESSION_DISABLED audit record.
 */
export async function disableDistrictUserbotSession(
  db: DbOrTx,
  districtId: string,
  actor?: SessionActionActor | string | null,
  actorRole?: string | null,
): Promise<PublicDistrictUserbotSession> {
  const cleanDistrictId = districtId.trim();
  const resolvedActorId = typeof actor === 'string' ? actor : actor?.actorId ?? null;
  const resolvedActorRole = typeof actor === 'string' ? (actorRole ?? null) : actor?.actorRole ?? null;

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, cleanDistrictId))
      .limit(1);

    if (!existing) {
      throw new UserbotSessionNotFoundError(cleanDistrictId);
    }

    if (existing.status === 'BANNED') {
      throw new SessionBannedError(
        cleanDistrictId,
        `Userbot session for district ${cleanDistrictId} is BANNED and cannot be disabled.`,
      );
    }

    const [updated] = await tx
      .update(districtTelegramUserbotSessions)
      .set({
        status: 'DISABLED',
        updatedAt: new Date(),
      })
      .where(eq(districtTelegramUserbotSessions.id, existing.id))
      .returning();

    if (!updated) {
      throw new UserbotSessionNotFoundError(cleanDistrictId);
    }

    await recordAuditEvent(tx, {
      districtId: cleanDistrictId,
      actorId: resolvedActorId,
      actorRole: resolvedActorRole,
      action: 'USERBOT_SESSION_DISABLED',
      metadata: {
        sessionId: existing.id,
        previousStatus: existing.status,
      },
    });

    return formatPublicUserbotSession(updated);
  });
}

/**
 * Re-enables session back to ACTIVE (or PENDING if no session string exists).
 * Rejects re-enabling if BANNED.
 * Emits USERBOT_SESSION_ENABLED audit record.
 */
export async function enableDistrictUserbotSession(
  db: DbOrTx,
  districtId: string,
  actor?: SessionActionActor | string | null,
  actorRole?: string | null,
): Promise<PublicDistrictUserbotSession> {
  const cleanDistrictId = districtId.trim();
  const resolvedActorId = typeof actor === 'string' ? actor : actor?.actorId ?? null;
  const resolvedActorRole = typeof actor === 'string' ? (actorRole ?? null) : actor?.actorRole ?? null;

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, cleanDistrictId))
      .limit(1);

    if (!existing) {
      throw new UserbotSessionNotFoundError(cleanDistrictId);
    }

    if (existing.status === 'BANNED') {
      throw new SessionBannedError(cleanDistrictId);
    }

    const targetStatus: UserbotSessionStatus =
      existing.sessionEncrypted && existing.sessionEncrypted.length > 0
        ? 'ACTIVE'
        : 'PENDING';

    const [updated] = await tx
      .update(districtTelegramUserbotSessions)
      .set({
        status: targetStatus,
        updatedAt: new Date(),
      })
      .where(eq(districtTelegramUserbotSessions.id, existing.id))
      .returning();

    if (!updated) {
      throw new UserbotSessionNotFoundError(cleanDistrictId);
    }

    await recordAuditEvent(tx, {
      districtId: cleanDistrictId,
      actorId: resolvedActorId,
      actorRole: resolvedActorRole,
      action: 'USERBOT_SESSION_ENABLED',
      metadata: {
        sessionId: existing.id,
        previousStatus: existing.status,
        newStatus: targetStatus,
      },
    });

    return formatPublicUserbotSession(updated);
  });
}

/**
 * Updates session status, liveness timestamp, or session secret (e.g. from worker or watchdog).
 */
export async function updateUserbotSessionStatus(
  db: DbOrTx,
  districtId: string,
  updates: UpdateUserbotSessionStatusParams,
): Promise<PublicDistrictUserbotSession> {
  const cleanDistrictId = districtId.trim();

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, cleanDistrictId))
      .limit(1);

    if (!existing) {
      throw new UserbotSessionNotFoundError(cleanDistrictId);
    }

    const patch: Partial<typeof districtTelegramUserbotSessions.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (updates.status !== undefined) {
      patch.status = updates.status;
    }

    if (updates.lastSeenAt !== undefined) {
      patch.lastSeenAt = updates.lastSeenAt;
    }

    if (updates.sessionString !== undefined) {
      if (updates.sessionString && updates.sessionString.trim().length > 0) {
        const encrypted = encryptToken(
          updates.sessionString.trim(),
          'v1',
          updates.customEncryptionKey,
        );
        patch.sessionEncrypted = encrypted.encryptedToken;
        patch.sessionIv = encrypted.tokenIv;
        patch.sessionTag = encrypted.tokenTag;
        patch.sessionKeyVersion = encrypted.tokenKeyVersion;
      } else {
        patch.sessionEncrypted = null;
        patch.sessionIv = null;
        patch.sessionTag = null;
      }
    }

    const [updated] = await tx
      .update(districtTelegramUserbotSessions)
      .set(patch)
      .where(eq(districtTelegramUserbotSessions.id, existing.id))
      .returning();

    if (!updated) {
      throw new UserbotSessionNotFoundError(cleanDistrictId);
    }

    const previousStatus = existing.status as UserbotSessionStatus;
    const newStatus = updates.status ?? previousStatus;

    const metadata: UserbotSessionStatusUpdateAuditMetadata = {
      previousStatus,
      newStatus,
    };
    if (updates.lastSeenAt !== undefined) {
      metadata.lastSeenAt = updates.lastSeenAt ? updates.lastSeenAt.toISOString() : null;
    }
    if (updates.sessionString !== undefined) {
      metadata.hasSessionString = Boolean(updates.sessionString && updates.sessionString.trim().length > 0);
      if (!updates.sessionString || updates.sessionString.trim().length === 0) {
        metadata.secretsCleared = true;
      }
    }

    await recordAuditEvent(tx, {
      districtId: cleanDistrictId,
      actorId: updates.actorId ?? null,
      actorRole: updates.actorRole ?? null,
      action: 'USERBOT_SESSION_STATUS_UPDATED',
      metadata: metadata as unknown as Record<string, unknown>,
    });

    return formatPublicUserbotSession(updated);
  });
}
