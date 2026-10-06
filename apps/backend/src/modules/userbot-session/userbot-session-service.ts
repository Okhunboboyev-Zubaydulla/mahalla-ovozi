import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import {
  CreateUserbotSessionRequestSchema,
  type UserbotAuditAction,
} from '@mahalla-ovozi/api-contracts';
import { findUniqueViolation, type DbOrTx } from '../../adapters/db/client.js';
import {
  districts,
  districtTelegramUserbotSessions,
  DistrictTelegramUserbotSession,
} from '../../adapters/db/schema/index.js';
import {
  encryptToken,
  decryptToken,
  getActiveKeyVersion,
  resolveKeyForVersion,
  type KeyOverride,
} from '../../adapters/crypto/token-cipher.js';
import { recordAuditEvent } from '../audit/audit-service.js';
import { DistrictNotFoundError } from '../districts/districts-service.js';
import { logger } from '../../utils/logger.js';
import {
  loadTelegramLibrary,
  DEFAULT_TELEGRAM_LIBRARY_SPECIFIER,
  type TelegramLibrary,
} from '../../adapters/telegram/telegram-library-loader.js';
import {
  classifyTelegramSignal,
  isSessionRevokedSignal,
} from '../../adapters/telegram/telegram-signal-classifier.js';
import { UserbotCredentialValidationError } from './userbot-auth-port.js';
import {
  classifyApiHashEnvelope,
  classifyEncryptedEnvelope,
  classifySessionEnvelope,
  isUserbotSessionEnvelopeComplete,
  narrowApiHashEnvelope,
  narrowSessionEnvelope,
  type ApiHashEnvelopeColumns,
  type ApiHashEnvelopeState,
  type EncryptedEnvelopeState,
  type SessionEnvelopeColumns,
} from './userbot-credential-envelope.js';

export { UserbotCredentialValidationError };

// The envelope policy lives in its own neutral module so the connection manager and the preflight
// CLI can classify a stored credential without importing this service. It is re-exported here so
// every existing import path keeps working unchanged.
export {
  classifyApiHashEnvelope,
  classifyEncryptedEnvelope,
  classifySessionEnvelope,
  isUserbotSessionEnvelopeComplete,
  narrowApiHashEnvelope,
  narrowSessionEnvelope,
  type ApiHashEnvelopeColumns,
  type ApiHashEnvelopeState,
  type EncryptedEnvelopeState,
  type SessionEnvelopeColumns,
};

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
  constructor(districtId: string, message?: string) {
    super(
      message ??
        `Userbot session for district ${districtId} is DISABLED via kill switch. Re-enable the session before bootstrapping.`,
    );
    this.name = 'UserbotSessionDisabledError';
  }
}

/**
 * Raised when a stored apiHash credential envelope is only PARTIALLY populated.
 *
 * The envelope is three columns: api_hash_encrypted, api_hash_iv, api_hash_tag. They are all
 * nullable with no defaults, so a row is only ever in one of three legitimate states: all three
 * present (decryptable), all three absent (the api hash is legitimately absent), or a mix.
 * The mixed state cannot be produced by any write path in this module, so it means the stored
 * credential is corrupt. Surfacing it as a typed conflict keeps the fault attributable to the
 * offending row instead of degrading into a silent empty api hash downstream.
 */
export class UserbotApiHashEnvelopeCorruptError extends ConflictError {
  override readonly code = 'USERBOT_API_HASH_ENVELOPE_CORRUPT' as const;
  constructor(rowId: string, districtId: string, message?: string) {
    super(
      message ??
        `Userbot session row '${rowId}' (district '${districtId}') has a corrupt encrypted apiHash envelope: api_hash_encrypted, api_hash_iv, and api_hash_tag must be either all present or all absent.`,
    );
    this.name = 'UserbotApiHashEnvelopeCorruptError';
  }
}

/**
 * Raised when a stored sessionString credential envelope is only PARTIALLY populated.
 *
 * The envelope is three columns: session_encrypted, session_iv, session_tag. They are all nullable
 * with no defaults, so a row is only ever in one of three legitimate states: all three present
 * (decryptable), all three absent (no session has been bootstrapped yet), or a mix. The mixed
 * state cannot be produced by any write path in this module, so it means the stored credential is
 * corrupt. It is a SEPARATE class from the apiHash counterpart rather than a parameterised one,
 * because callers discriminate on class identity to tell which credential is corrupt.
 */
export class UserbotSessionEnvelopeCorruptError extends ConflictError {
  override readonly code = 'USERBOT_SESSION_ENVELOPE_CORRUPT' as const;
  constructor(rowId: string, districtId: string, message?: string) {
    super(
      message ??
        `Userbot session row '${rowId}' (district '${districtId}') has a corrupt encrypted session envelope: session_encrypted, session_iv, and session_tag must be either all present or all absent.`,
    );
    this.name = 'UserbotSessionEnvelopeCorruptError';
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
  lastSuccessfulConnectionAt: Date | null;
  inboundUpdateCounter: number;
  isStale: boolean;
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
  lastSuccessfulConnectionAt: Date | null;
  inboundUpdateCounter: number;
  isStale: boolean;
  updatePosition: string | null;
  updatePositionAdvancedAt: Date | null;
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
  apiId: string | number;
  apiHash?: string | null;
  sessionString?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  customEncryptionKey?: string;
  keyVersion?: string;
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
    // `hasSession` means "this row holds a complete, usable session credential", not merely "the
    // ciphertext column is non-empty". A row with real ciphertext but a null/blank IV or tag cannot
    // be decrypted, so reporting it as a usable session was the lie: callers read `hasSession` to
    // decide whether an operator-visible session actually exists. Classifying the whole triple
    // makes a half-written row report false. This is deliberately a SINGLE-COLUMN-shaped decision
    // (only the session triple is consulted, the apiHash triple is not), so it does not use the
    // apiHash-aware `isUserbotSessionEnvelopeComplete`. A PARTIAL row still never reaches here: the
    // guarded callers assert the envelope first, and the unguarded ones hold this invariant BY
    // CONSTRUCTION — every write sets all three session columns together or nulls all three. Do not
    // break that discipline: a partial triple written here would silently report hasSession: false.
    hasSession: classifySessionEnvelope(row) === 'COMPLETE',
    lastSeenAt: row.lastSeenAt,
    lastSuccessfulConnectionAt: row.lastSuccessfulConnectionAt ?? null,
    inboundUpdateCounter: row.inboundUpdateCounter ?? 0,
    isStale: row.isStale ?? false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The unique index that enforces the one-userbot-session-per-District rule on
 * `district_telegram_userbot_sessions`.
 */
const SESSION_DISTRICT_UNIQUE_INDEX = 'district_telegram_userbot_sessions_district_id_idx';

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
  // 1. Boundary validation for credentials (enforced before reaching DB operations)
  const validationResult = CreateUserbotSessionRequestSchema.safeParse({
    phoneNumber: params.phoneNumber,
    apiId: params.apiId,
    apiHash: params.apiHash,
  });

  if (!validationResult.success) {
    const firstIssue = validationResult.error.issues[0];
    const fieldName = firstIssue?.path[0] ? String(firstIssue.path[0]) : 'credential';
    throw new UserbotCredentialValidationError(
      fieldName,
      firstIssue?.message || 'Invalid userbot credentials.',
    );
  }

  const cleanPhoneNumber = validationResult.data.phoneNumber;
  const cleanApiId = validationResult.data.apiId;
  const normalizedApiHash = validationResult.data.apiHash ?? null;

  const districtId = params.districtId.trim();

  // 2. Verify district exists
  const [district] = await db
    .select({ id: districts.id })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  // 3. Reject duplicate session for the same District (1 session per District rule)
  const [existing] = await db
    .select({ id: districtTelegramUserbotSessions.id })
    .from(districtTelegramUserbotSessions)
    .where(eq(districtTelegramUserbotSessions.districtId, districtId))
    .limit(1);

  if (existing) {
    throw new ConflictError(`District ${districtId} already has a userbot session.`);
  }

  // 3b. Detect shared application credential across districts
  const [existingShared] = await db
    .select({
      id: districtTelegramUserbotSessions.id,
      districtId: districtTelegramUserbotSessions.districtId,
    })
    .from(districtTelegramUserbotSessions)
    .where(
      and(
        eq(districtTelegramUserbotSessions.apiId, cleanApiId),
        ne(districtTelegramUserbotSessions.districtId, districtId),
      ),
    )
    .limit(1);

  let sharedApplicationCredential = false;
  let sharedWithDistrictId: string | undefined = undefined;

  if (existingShared) {
    sharedApplicationCredential = true;
    sharedWithDistrictId = existingShared.districtId;
    logger.warn(
      {
        event: 'USERBOT_SHARED_APPLICATION_CREDENTIAL_DETECTED',
        districtId,
        sharedWithDistrictId: existingShared.districtId,
        apiId: cleanApiId,
      },
      'Shared Telegram application credential detected across districts',
    );
  }

  // 4. Encrypt session string if provided
  const targetKeyVersion = params.keyVersion ?? getActiveKeyVersion();
  let sessionEncrypted: string | null = null;
  let sessionIv: string | null = null;
  let sessionTag: string | null = null;
  let sessionKeyVersion: string = targetKeyVersion;

  if (params.sessionString && params.sessionString.trim().length > 0) {
    const encrypted = encryptToken(
      params.sessionString.trim(),
      targetKeyVersion,
      params.customEncryptionKey,
    );
    sessionEncrypted = encrypted.encryptedToken;
    sessionIv = encrypted.tokenIv;
    sessionTag = encrypted.tokenTag;
    sessionKeyVersion = encrypted.tokenKeyVersion;
  }

  // Encrypt API hash if provided (normalized: whitespace-only converted to null)
  let apiHashEncrypted: string | null = null;
  let apiHashIv: string | null = null;
  let apiHashTag: string | null = null;
  let apiHashKeyVersion: string = targetKeyVersion;

  if (normalizedApiHash) {
    const encApiHash = encryptToken(
      normalizedApiHash,
      targetKeyVersion,
      params.customEncryptionKey,
    );
    apiHashEncrypted = encApiHash.encryptedToken;
    apiHashIv = encApiHash.tokenIv;
    apiHashTag = encApiHash.tokenTag;
    apiHashKeyVersion = encApiHash.tokenKeyVersion;
  }

  const sessionId = `dtus_${crypto.randomUUID()}`;

  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(districtTelegramUserbotSessions)
        .values({
          id: sessionId,
          districtId,
          phoneNumber: cleanPhoneNumber,
          apiId: cleanApiId,
          apiHashEncrypted,
          apiHashIv,
          apiHashTag,
          apiHashKeyVersion,
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

      // 5. Emit audit record
      await recordAuditEvent(tx, {
        districtId,
        actorId: params.actorId || null,
        actorRole: params.actorRole ?? (params.actorId ? 'PRODUCT_OWNER' : null),
        action: 'USERBOT_SESSION_CREATED' satisfies UserbotAuditAction,
        metadata: {
          sessionId: created.id,
          phoneNumber: cleanPhoneNumber,
          previousStatus: null,
          newStatus: 'PENDING',
          hasSession: Boolean(sessionEncrypted),
          ...(sharedApplicationCredential
            ? {
                sharedApplicationCredential: true,
                sharedWithDistrictId,
              }
            : {}),
        },
      });

      return formatPublicUserbotSession(created);
    });
  } catch (err: unknown) {
    // Catch unique constraint collision on districtId under race conditions. The SQLSTATE
    // may sit on a wrapped cause rather than the thrown error, so match the whole chain.
    //
    // Only a violation of the session table's district-id index is a session conflict. This
    // block also wraps the audit-event write, and a 23505 raised by any other source must
    // reach the caller unchanged rather than be misreported as a duplicate session.
    const violation = findUniqueViolation(err);

    if (violation?.constraint === SESSION_DISTRICT_UNIQUE_INDEX) {
      // Classification decision, recorded before the conflict is raised so a future
      // misclassification or under-detection is visible in production. Deliberately limited
      // to the District id, the SQLSTATE and the constraint name: no session string, API id,
      // API hash, phone number, encryption key or raw query parameter reaches this line.
      logger.warn(
        {
          event: 'USERBOT_SESSION_CREATE_DUPLICATE_CLASSIFIED',
          districtId,
          sqlState: violation.code,
          constraint: violation.constraint,
        },
        'Duplicate userbot session insert classified as a District conflict',
      );

      throw new ConflictError(`District ${districtId} already has a userbot session.`);
    }

    if (violation?.code === '23505' && violation.constraint !== SESSION_DISTRICT_UNIQUE_INDEX) {
      logger.warn(
        {
          event: 'USERBOT_SESSION_CREATE_UNIQUE_VIOLATION_UNCLASSIFIED',
          districtId,
          sqlState: violation.code,
          constraint: violation.constraint,
        },
        'Unique violation on unclassified constraint during userbot session creation',
      );
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

  assertApiHashEnvelopeIntact(session);
  assertSessionEnvelopeIntact(session);

  return formatPublicUserbotSession(session);
}

/**
 * Guards an EXISTING stored session row against a corrupt apiHash credential envelope.
 *
 * COMPLETE and ABSENT are both legitimate: the api hash is either decryptable or genuinely not
 * stored. PARTIAL is a state no write path in this module can produce, so it is corrupt storage
 * and is raised as UserbotApiHashEnvelopeCorruptError instead of being tolerated. Callers invoke
 * this before any state change so a corrupt row cannot be transitioned.
 */
export function assertApiHashEnvelopeIntact(
  row: ApiHashEnvelopeColumns & { id: string; districtId: string },
): void {
  if (classifyApiHashEnvelope(row) === 'PARTIAL') {
    throw new UserbotApiHashEnvelopeCorruptError(row.id, row.districtId);
  }
}

/**
 * Guards an EXISTING stored session row against a corrupt sessionString credential envelope.
 *
 * COMPLETE and ABSENT are both legitimate: a session string is either decryptable or genuinely not
 * stored yet. PARTIAL is a state no write path in this module can produce, so it is corrupt storage
 * and is raised as UserbotSessionEnvelopeCorruptError instead of degrading into a silent null.
 * Callers invoke this before any state change so a corrupt row cannot be transitioned.
 */
export function assertSessionEnvelopeIntact(
  row: SessionEnvelopeColumns & { id: string; districtId: string },
): void {
  if (classifySessionEnvelope(row) === 'PARTIAL') {
    throw new UserbotSessionEnvelopeCorruptError(row.id, row.districtId);
  }
}

/**
 * Internal method for worker/connect service to retrieve decrypted session string and API credentials.
 *
 * A stored apiHash envelope is either complete (decrypted), entirely absent (the api hash is
 * legitimately absent, returned as null), or partial. A partial envelope is corrupt storage and
 * fails loudly with UserbotApiHashEnvelopeCorruptError instead of degrading into a silent null.
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
  const sessionEnvelopeState = classifySessionEnvelope(session);

  if (sessionEnvelopeState === 'PARTIAL') {
    throw new UserbotSessionEnvelopeCorruptError(session.id, session.districtId);
  }

  // Narrowing is delegated to the classifier-backed helper rather than a compound truthiness test:
  // truthiness treats an all-whitespace triple as present and would hand blank strings to
  // decryptToken, while this returns null unless all three columns are genuinely present.
  const sessionEnvelope = narrowSessionEnvelope(session);

  if (sessionEnvelope) {
    if (!session.sessionKeyVersion || session.sessionKeyVersion.trim().length === 0) {
      throw new Error(
        `Userbot session row '${session.id}' (district '${session.districtId}') has ciphertext but a null or missing sessionKeyVersion`,
      );
    }
    sessionString = decryptToken(
      {
        encryptedToken: sessionEnvelope.ciphertext,
        tokenIv: sessionEnvelope.iv,
        tokenTag: sessionEnvelope.tag,
        tokenKeyVersion: session.sessionKeyVersion,
      },
      customEncryptionKey,
    );
  }

  let apiHash: string | null = null;
  const apiHashEnvelopeState = classifyApiHashEnvelope(session);

  if (apiHashEnvelopeState === 'PARTIAL') {
    throw new UserbotApiHashEnvelopeCorruptError(session.id, session.districtId);
  }

  // The helper agrees with the 'COMPLETE' state asserted above, but is not the same test: the
  // state check classifies and throws for PARTIAL, while this narrows the three columns to
  // non-null strings for decryptToken. Both must be the classifier-backed form, so an
  // all-whitespace triple is absent here too rather than being passed to the decryptor.
  const apiHashEnvelope = narrowApiHashEnvelope(session);

  if (apiHashEnvelope) {
    if (!session.apiHashKeyVersion || session.apiHashKeyVersion.trim().length === 0) {
      throw new Error(
        `Userbot session row '${session.id}' (district '${session.districtId}') has encrypted apiHash but a null or missing apiHashKeyVersion`,
      );
    }
    apiHash = decryptToken(
      {
        encryptedToken: apiHashEnvelope.ciphertext,
        tokenIv: apiHashEnvelope.iv,
        tokenTag: apiHashEnvelope.tag,
        tokenKeyVersion: session.apiHashKeyVersion,
      },
      customEncryptionKey,
    );
  }

  return {
    id: session.id,
    districtId: session.districtId,
    phoneNumber: session.phoneNumber,
    apiId: session.apiId,
    apiHash,
    sessionString,
    status: session.status as UserbotSessionStatus,
    lastSeenAt: session.lastSeenAt,
    lastSuccessfulConnectionAt: session.lastSuccessfulConnectionAt ?? null,
    inboundUpdateCounter: session.inboundUpdateCounter ?? 0,
    isStale: session.isStale ?? false,
    updatePosition: session.updatePosition ?? null,
    updatePositionAdvancedAt: session.updatePositionAdvancedAt ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/**
 * The maximum number of offending row ids reported before the list is truncated, so a badly
 * corrupted deployment cannot flood an operator's terminal.
 */
export const API_HASH_ENVELOPE_OFFENDER_LIMIT = 20;

export interface ApiHashEnvelopeOffendingRow {
  id: string;
  districtId: string;
  status: string;
}

/**
 * Per-envelope scan counts. `partialRows` is capped at API_HASH_ENVELOPE_OFFENDER_LIMIT and
 * `partialRowsTruncated` says whether any offending id was dropped from that list.
 */
export interface EnvelopeScanSection {
  completeCount: number;
  absentCount: number;
  partialCount: number;
  partialRows: ApiHashEnvelopeOffendingRow[];
  partialRowsTruncated: boolean;
  activePartialCount: number;
}

export interface ApiHashEnvelopeVerificationReport extends EnvelopeScanSection {
  totalRows: number;
  /**
   * The same counts for the sessionString envelope, which is an independent credential with its
   * own three columns. A deployment can be clean on one envelope and corrupt on the other, so a
   * deploy gate must consult both.
   */
  session: EnvelopeScanSection;
}

interface EnvelopeOffendingRowSource {
  id: string;
  districtId: string;
  status: string;
}

/**
 * Turns a classified row list into the report section shape, applying the shared offender cap.
 * The two envelopes are reported in exactly the same shape, so this is the only place that decides
 * how a section is built.
 */
function buildEnvelopeScanSection<T extends EnvelopeOffendingRowSource>(
  rows: T[],
  stateOf: (row: T) => EncryptedEnvelopeState,
): EnvelopeScanSection {
  const classified = rows.map((row) => ({ row, state: stateOf(row) }));
  const partialRows = classified.filter((entry) => entry.state === 'PARTIAL').map((entry) => entry.row);

  return {
    completeCount: classified.filter((entry) => entry.state === 'COMPLETE').length,
    absentCount: classified.filter((entry) => entry.state === 'ABSENT').length,
    partialCount: partialRows.length,
    partialRows: partialRows
      .slice(0, API_HASH_ENVELOPE_OFFENDER_LIMIT)
      .map((row) => ({ id: row.id, districtId: row.districtId, status: row.status })),
    partialRowsTruncated: partialRows.length > API_HASH_ENVELOPE_OFFENDER_LIMIT,
    activePartialCount: partialRows.filter((row) => row.status === 'ACTIVE').length,
  };
}

/**
 * Read-only preflight scan over every district_telegram_userbot_sessions row.
 *
 * Reports, for BOTH stored credentials, how many rows hold a complete envelope, how many
 * legitimately hold none, and how many are PARTIAL (corrupt). Both are reported because they are
 * independent credentials with independent column triples: a deployment can be clean on one and
 * corrupt on the other, and a gate that only looked at the apiHash envelope would silently pass a
 * corrupt session row. The offending row ids are capped at API_HASH_ENVELOPE_OFFENDER_LIMIT per
 * envelope, with `partialRowsTruncated` saying whether ids were dropped. Performs no writes and
 * changes no schema, so it is safe to run against a live deployment.
 */
export async function verifyApiHashEnvelopes(db: DbOrTx): Promise<ApiHashEnvelopeVerificationReport> {
  const rows = await db
    .select({
      id: districtTelegramUserbotSessions.id,
      districtId: districtTelegramUserbotSessions.districtId,
      status: districtTelegramUserbotSessions.status,
      apiHashEncrypted: districtTelegramUserbotSessions.apiHashEncrypted,
      apiHashIv: districtTelegramUserbotSessions.apiHashIv,
      apiHashTag: districtTelegramUserbotSessions.apiHashTag,
      sessionEncrypted: districtTelegramUserbotSessions.sessionEncrypted,
      sessionIv: districtTelegramUserbotSessions.sessionIv,
      sessionTag: districtTelegramUserbotSessions.sessionTag,
    })
    .from(districtTelegramUserbotSessions);

  return {
    totalRows: rows.length,
    ...buildEnvelopeScanSection(rows, (row) => classifyApiHashEnvelope(row)),
    session: buildEnvelopeScanSection(rows, (row) => classifySessionEnvelope(row)),
  };
}

export interface TelegramRevocationClient {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  logOut?(): Promise<unknown>;
}

export interface RevokeTelegramSessionParams {
  districtId: string;
  sessionString: string;
  apiId: string;
  apiHash?: string | null;
  phoneNumber?: string;
}

export type TelegramSessionRevoker = (
  params: RevokeTelegramSessionParams,
) => Promise<{ revocationPerformed: boolean; revocationSuccess?: boolean }>;

export function isAlreadyRevokedOrInvalidSessionError(err: unknown): boolean {
  return isSessionRevokedSignal(classifyTelegramSignal(err));
}

export async function defaultTelegramSessionRevoker(
  params: RevokeTelegramSessionParams,
): Promise<{ revocationPerformed: boolean; revocationSuccess?: boolean }> {
  const { districtId, sessionString, apiId, apiHash } = params;

  // There is no session to revoke, so this is a benign no-op and NOT a failure: the optional
  // `revocationSuccess` field is deliberately omitted rather than set to true or false. Consumers
  // read it only as `=== false` to classify an audit FAILURE, so omitting it leaves the outcome
  // unclassified (correct for a no-op), while `false` would invent a failure out of a non-event.
  if (!sessionString || sessionString.trim().length === 0) {
    return { revocationPerformed: false };
  }

  let lib: TelegramLibrary<TelegramRevocationClient>;
  try {
    lib = await loadTelegramLibrary<TelegramRevocationClient>(DEFAULT_TELEGRAM_LIBRARY_SPECIFIER);
  } catch (err: unknown) {
    logger.warn(
      { districtId, err },
      'MTProto library not loadable for revocation; proceeding with local disable',
    );
    return { revocationPerformed: false, revocationSuccess: false };
  }

  let stringSession: unknown;
  try {
    stringSession = new lib.StringSession(sessionString);
  } catch (err: unknown) {
    logger.info(
      { districtId, err: err instanceof Error ? err.message : String(err) },
      'Invalid session string encountered during revocation; treating as already revoked',
    );
    return { revocationPerformed: false, revocationSuccess: true };
  }

  let client: TelegramRevocationClient;
  try {
    client = new lib.TelegramClient(
      stringSession,
      Number(apiId),
      apiHash || '',
      {
        connectionRetries: 1,
      },
    );
  } catch (err: unknown) {
    if (isAlreadyRevokedOrInvalidSessionError(err)) {
      return { revocationPerformed: false, revocationSuccess: true };
    }
    throw err;
  }

  try {
    if (typeof client.connect === 'function') {
      await client.connect();
    }

    if (typeof client.logOut === 'function') {
      await client.logOut();
    }
    return { revocationPerformed: true, revocationSuccess: true };
  } catch (err: unknown) {
    if (isAlreadyRevokedOrInvalidSessionError(err)) {
      logger.info(
        { districtId, err: err instanceof Error ? err.message : String(err) },
        'Telegram session already revoked or account gone on server; proceeding with local disable',
      );
      return { revocationPerformed: false, revocationSuccess: true };
    }

    logger.error(
      { districtId, err: err instanceof Error ? err.message : String(err) },
      'Failed server-side Telegram session revocation due to network/server failure',
    );
    throw err;
  }
 finally {
    try {
      if (typeof client.disconnect === 'function') {
        await client.disconnect();
      }
    } catch (disconnectErr: unknown) {
      // Disconnect cleanup failure is non-fatal because the revocation outcome is already
      // decided, but the failure is logged rather than discarded so a leaking client is observable.
      logger.debug(
        { districtId, err: disconnectErr },
        'Failed to disconnect revocation client during cleanup',
      );
    }
  }
}

export interface DisableDistrictUserbotSessionOptions {
  customEncryptionKey?: string;
  revoker?: TelegramSessionRevoker;
}

export type DisableDistrictUserbotSessionActor =
  | SessionActionActor
  | (SessionActionActor & DisableDistrictUserbotSessionOptions);

/**
 * Immediate kill switch: revokes server-side session authorization on Telegram,
 * clears encrypted credentials from the database, and transitions status to DISABLED.
 * Emits USERBOT_SESSION_DISABLED audit record with revocationPerformed and secretsCleared.
 */
export async function disableDistrictUserbotSession(
  db: DbOrTx,
  districtId: string,
  actor?: DisableDistrictUserbotSessionActor | string | null,
  actorRole?: string | null,
  options?: DisableDistrictUserbotSessionOptions,
): Promise<PublicDistrictUserbotSession> {
  const cleanDistrictId = districtId.trim();
  const actorObj = typeof actor === 'object' && actor !== null ? actor : null;
  const resolvedActorId = typeof actor === 'string' ? actor : actorObj?.actorId ?? null;
  const resolvedActorRole = typeof actor === 'string' ? (actorRole ?? null) : actorObj?.actorRole ?? null;
  const resolvedRevoker: TelegramSessionRevoker =
    options?.revoker ?? (actorObj as DisableDistrictUserbotSessionOptions | null)?.revoker ?? defaultTelegramSessionRevoker;
  const resolvedCustomKey =
    options?.customEncryptionKey ?? (actorObj as DisableDistrictUserbotSessionOptions | null)?.customEncryptionKey;

  // 1. Pre-transaction inspection: check existence and terminal state.
  // Revocation completes before the database transaction opens.
  const [existing] = await db
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

  // A corrupt credential envelope is validated before revocation and before the transaction,
  // so a PARTIAL row is never revoked against and never transitioned to DISABLED. Both envelopes
  // are checked here: without the session check a PARTIAL session row would skip server-side
  // revocation, have its secrets nulled, and still be audited as a successful revocation.
  //
  // These asserts cover PARTIAL only. They do NOT make the guard below safe on their own, because
  // an all-whitespace triple classifies as ABSENT and therefore passes both asserts. That is why
  // the revocation guard is a classifier-backed narrowing helper rather than a truthiness test.
  assertApiHashEnvelopeIntact(existing);
  assertSessionEnvelopeIntact(existing);

  // 2. Perform server-side revocation if active/resolvable session credentials exist
  let revocationPerformed = false;
  let revocationSuccess = true;
  const existingSessionEnvelope = narrowSessionEnvelope(existing);

  if (existingSessionEnvelope) {
    if (!existing.sessionKeyVersion || existing.sessionKeyVersion.trim().length === 0) {
      throw new Error(
        `Userbot session row '${existing.id}' (district '${existing.districtId}') has ciphertext but a null or missing sessionKeyVersion`,
      );
    }
    let sessionString: string | null = null;
    try {
      sessionString = decryptToken(
        {
          encryptedToken: existingSessionEnvelope.ciphertext,
          tokenIv: existingSessionEnvelope.iv,
          tokenTag: existingSessionEnvelope.tag,
          tokenKeyVersion: existing.sessionKeyVersion,
        },
        resolvedCustomKey,
      );
    } catch (err: unknown) {
      logger.warn(
        { districtId: cleanDistrictId, err },
        'Failed to decrypt stored userbot session token for revocation; proceeding to clear secrets',
      );
      sessionString = null;
      revocationSuccess = false;
    }

    if (sessionString && sessionString.trim().length > 0) {
      let resolvedRevokerHash: string | null = null;
      const existingApiHashEnvelope = narrowApiHashEnvelope(existing);

      if (existingApiHashEnvelope) {
        try {
          resolvedRevokerHash = decryptToken(
            {
              encryptedToken: existingApiHashEnvelope.ciphertext,
              tokenIv: existingApiHashEnvelope.iv,
              tokenTag: existingApiHashEnvelope.tag,
              tokenKeyVersion: existing.apiHashKeyVersion || 'v1',
            },
            resolvedCustomKey,
          );
        } catch (apiHashDecryptErr: unknown) {
          // A corrupt api-hash envelope must not abort session revocation: the revoker falls back to an
          // unauthenticated wipe, which is still a real server-side revocation. Logged rather than
          // silently swallowed so a persistently undecryptable envelope stays observable.
          // Control flow is unchanged.
          logger.warn(
            { districtId: cleanDistrictId, err: apiHashDecryptErr },
            'Failed to decrypt stored api-hash for session revocation; proceeding without api-hash',
          );
          resolvedRevokerHash = null;
        }
      }

      const outcome = await resolvedRevoker({
        districtId: cleanDistrictId,
        sessionString,
        apiId: existing.apiId,
        apiHash: resolvedRevokerHash,
        phoneNumber: existing.phoneNumber,
      });
      revocationPerformed = outcome.revocationPerformed;
      if (outcome.revocationSuccess !== undefined) {
        revocationSuccess = outcome.revocationSuccess;
      }
    }
  }

  // 3. Database transaction: wipe secrets, transition status to DISABLED, and emit audit event.
  return await db.transaction(async (tx) => {
    const [existingInTx] = await tx
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, cleanDistrictId))
      .limit(1);

    if (!existingInTx) {
      throw new UserbotSessionNotFoundError(cleanDistrictId);
    }

    if (existingInTx.status === 'BANNED') {
      throw new SessionBannedError(
        cleanDistrictId,
        `Userbot session for district ${cleanDistrictId} is BANNED and cannot be disabled.`,
      );
    }

    const [updated] = await tx
      .update(districtTelegramUserbotSessions)
      .set({
        status: 'DISABLED',
        sessionEncrypted: null,
        sessionIv: null,
        sessionTag: null,
        updatePosition: null,
        updatePositionAdvancedAt: null,
        // sessionKeyVersion is intentionally preserved (NOT NULL default 'v1')
        // apiHash and its encrypted envelope are preserved to allow re-authentication
        updatedAt: new Date(),
      })
      .where(eq(districtTelegramUserbotSessions.id, existingInTx.id))
      .returning();

    if (!updated) {
      throw new UserbotSessionNotFoundError(cleanDistrictId);
    }

    await recordAuditEvent(tx, {
      districtId: cleanDistrictId,
      actorId: resolvedActorId,
      actorRole: resolvedActorRole ?? (resolvedActorId ? 'PRODUCT_OWNER' : null),
      action: 'USERBOT_SESSION_DISABLED' satisfies UserbotAuditAction,
      metadata: {
        sessionId: existingInTx.id,
        previousStatus: existingInTx.status,
        newStatus: 'DISABLED',
        revocationPerformed,
        secretsCleared: false,
        revocationSuccess,
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

    // Validated inside the transaction and before the status patch, so a corrupt row is not
    // transitioned out of DISABLED. Both envelopes are checked: grading a district ACTIVE while
    // one of its two stored credentials is undecryptable is exactly the bug class this guards.
    //
    // These asserts reject PARTIAL rows only. They do not by themselves make the ACTIVE/PENDING
    // decision below honest, because an all-whitespace session triple classifies as ABSENT and so
    // passes them; the decision therefore classifies the session envelope itself.
    assertApiHashEnvelopeIntact(existing);
    assertSessionEnvelopeIntact(existing);

    const isFromDisabled = existing.status === 'DISABLED';
    // A district is only graded ACTIVE when a COMPLETE session envelope is stored. A row holding
    // real ciphertext but a null/blank IV or tag cannot be decrypted, so grading it ACTIVE would
    // hand the connection manager a session it can never connect with; it stays PENDING instead.
    const targetStatus: UserbotSessionStatus = isFromDisabled
      ? 'PENDING'
      : classifySessionEnvelope(existing) === 'COMPLETE'
        ? 'ACTIVE'
        : 'PENDING';

    const patch: Partial<typeof districtTelegramUserbotSessions.$inferInsert> = {
      status: targetStatus,
      updatedAt: new Date(),
    };

    if (isFromDisabled) {
      patch.sessionEncrypted = null;
      patch.sessionIv = null;
      patch.sessionTag = null;
    }

    const [updated] = await tx
      .update(districtTelegramUserbotSessions)
      .set(patch)
      .where(eq(districtTelegramUserbotSessions.id, existing.id))
      .returning();

    if (!updated) {
      throw new UserbotSessionNotFoundError(cleanDistrictId);
    }

    await recordAuditEvent(tx, {
      districtId: cleanDistrictId,
      actorId: resolvedActorId,
      actorRole: resolvedActorRole ?? (resolvedActorId ? 'PRODUCT_OWNER' : null),
      action: 'USERBOT_SESSION_ENABLED' satisfies UserbotAuditAction,
      metadata: {
        sessionId: existing.id,
        previousStatus: existing.status,
        newStatus: targetStatus,
      },
    });

    return formatPublicUserbotSession(updated);
  });
}

export interface UpdateUserbotSessionStatusParams {
  status?: UserbotSessionStatus;
  lastSeenAt?: Date | null;
  sessionString?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  customEncryptionKey?: string;
  targetKeyVersion?: string;
}

/**
 * Audit metadata for a status-transition record.
 *
 * `secretsCleared` means ALL stored credential material for the row was cleared - both the
 * sessionString envelope (session_encrypted, session_iv, session_tag) and the apiHash envelope
 * (api_hash_encrypted, api_hash_iv, api_hash_tag). It is false whenever credential material is
 * deliberately preserved: the disable/revoke path wipes only the session envelope and keeps the
 * apiHash envelope so the District can be re-authenticated without re-procuring the Telegram
 * application credentials. It does NOT mean the session row was deleted - the row always survives
 * the transition, carrying a terminal status such as DISABLED or PENDING.
 */
export interface UserbotSessionStatusUpdateAuditMetadata {
  previousStatus: UserbotSessionStatus;
  newStatus: UserbotSessionStatus;
  lastSeenAt?: string | null;
  hasSessionString?: boolean;
  secretsCleared?: boolean;
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
  const targetKeyVersion = updates.targetKeyVersion ?? getActiveKeyVersion();

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
          targetKeyVersion,
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
        metadata.secretsCleared = false;
      }
    }

    await recordAuditEvent(tx, {
      districtId: cleanDistrictId,
      actorId: updates.actorId ?? null,
      actorRole: updates.actorRole ?? null,
      action: 'USERBOT_SESSION_STATUS_UPDATED' satisfies UserbotAuditAction,
      metadata: metadata as unknown as Record<string, unknown>,
    });

    return formatPublicUserbotSession(updated);
  });
}

export interface ReencryptUserbotSessionsOptions {
  targetKeyVersion?: string;
  customKeys?: KeyOverride;
  districtIds?: string[];
}

export interface ReencryptUserbotSessionsResult {
  migratedCount: number;
  remainingCount: number;
  totalCiphertextRows: number;
}

/**
 * Re-encrypts userbot sessions from older key versions to targetKeyVersion.
 *
 * Invariants:
 * - Decrypts under row's existing sessionKeyVersion and re-encrypts under targetKeyVersion.
 * - Idempotent and re-runnable: reports migratedCount and remainingCount.
 * - Does NOT run inside the same transaction that reads the rows, so partial rotations
 *   are restartable rather than all-or-nothing, leaving every stored session decryptable.
 * - A null key version on a row holding ciphertext fails fast, naming the offending row.
 */
export async function reencryptUserbotSessions(
  db: DbOrTx,
  options?: ReencryptUserbotSessionsOptions,
): Promise<ReencryptUserbotSessionsResult> {
  const targetKeyVersion = options?.targetKeyVersion ?? getActiveKeyVersion();
  const customKeys = options?.customKeys;
  const districtIds = options?.districtIds;

  // Assert target key is resolvable before starting migration passes
  resolveKeyForVersion(targetKeyVersion, customKeys);

  // The filter must see ANY row carrying part of either credential envelope, not only a row whose
  // ciphertext column is populated. A row with NULL ciphertext but a present IV or tag is exactly
  // the corrupt state this pass needs to report, and an isNotNull(ciphertext)-only filter made it
  // invisible to the migration: it was neither re-encrypted nor diagnosed.
  const baseWhere = or(
    isNotNull(districtTelegramUserbotSessions.sessionEncrypted),
    isNotNull(districtTelegramUserbotSessions.sessionIv),
    isNotNull(districtTelegramUserbotSessions.sessionTag),
    isNotNull(districtTelegramUserbotSessions.apiHashEncrypted),
    isNotNull(districtTelegramUserbotSessions.apiHashIv),
    isNotNull(districtTelegramUserbotSessions.apiHashTag),
  );
  const rowsWhere =
    districtIds && districtIds.length > 0
      ? and(baseWhere, inArray(districtTelegramUserbotSessions.districtId, districtIds))
      : baseWhere;

  // 1. Fetch all rows that contain ciphertext WITHOUT holding an open transaction for the whole batch
  const rows = await db
    .select({
      id: districtTelegramUserbotSessions.id,
      districtId: districtTelegramUserbotSessions.districtId,
      sessionEncrypted: districtTelegramUserbotSessions.sessionEncrypted,
      sessionIv: districtTelegramUserbotSessions.sessionIv,
      sessionTag: districtTelegramUserbotSessions.sessionTag,
      sessionKeyVersion: districtTelegramUserbotSessions.sessionKeyVersion,
      apiHashEncrypted: districtTelegramUserbotSessions.apiHashEncrypted,
      apiHashIv: districtTelegramUserbotSessions.apiHashIv,
      apiHashTag: districtTelegramUserbotSessions.apiHashTag,
      apiHashKeyVersion: districtTelegramUserbotSessions.apiHashKeyVersion,
    })
    .from(districtTelegramUserbotSessions)
    .where(rowsWhere);

  let migratedCount = 0;

  for (const row of rows) {
    const patch: Partial<typeof districtTelegramUserbotSessions.$inferInsert> = {};
    let rowUpdated = false;

    // Corruption is diagnosed BEFORE the key-version branch. Classifying first is what makes a
    // PARTIAL envelope visible at all: the old guard tested the iv/tag columns only INSIDE the
    // `keyVersion !== target` branch, so a partial row already sitting on the target version was
    // skipped in total silence -- no error, no log, no migration, leaving a row that can never be
    // decrypted. The asserts deliberately ALLOW an ABSENT envelope, so an all-NULL row is still
    // skipped below without error, exactly as before.
    assertApiHashEnvelopeIntact(row);
    assertSessionEnvelopeIntact(row);

    // Handle sessionEncrypted re-encryption
    const sessionEnvelope = narrowSessionEnvelope(row);

    if (sessionEnvelope) {
      if (!row.sessionKeyVersion || row.sessionKeyVersion.trim().length === 0) {
        throw new Error(
          `Userbot session row '${row.id}' (district '${row.districtId}') has ciphertext but a null or missing sessionKeyVersion`,
        );
      }

      if (row.sessionKeyVersion !== targetKeyVersion) {
        const plaintext = decryptToken(
          {
            encryptedToken: sessionEnvelope.ciphertext,
            tokenIv: sessionEnvelope.iv,
            tokenTag: sessionEnvelope.tag,
            tokenKeyVersion: row.sessionKeyVersion,
          },
          customKeys,
        );

        const reencrypted = encryptToken(
          plaintext,
          targetKeyVersion,
          customKeys,
        );

        patch.sessionEncrypted = reencrypted.encryptedToken;
        patch.sessionIv = reencrypted.tokenIv;
        patch.sessionTag = reencrypted.tokenTag;
        patch.sessionKeyVersion = targetKeyVersion;
        rowUpdated = true;
      }
    }

    // Handle apiHashEncrypted re-encryption
    const apiHashEnvelope = narrowApiHashEnvelope(row);

    if (apiHashEnvelope) {
      if (!row.apiHashKeyVersion || row.apiHashKeyVersion.trim().length === 0) {
        throw new Error(
          `Userbot session row '${row.id}' (district '${row.districtId}') has encrypted apiHash but a null or missing apiHashKeyVersion`,
        );
      }

      if (row.apiHashKeyVersion !== targetKeyVersion) {
        const plaintext = decryptToken(
          {
            encryptedToken: apiHashEnvelope.ciphertext,
            tokenIv: apiHashEnvelope.iv,
            tokenTag: apiHashEnvelope.tag,
            tokenKeyVersion: row.apiHashKeyVersion,
          },
          customKeys,
        );

        const reencrypted = encryptToken(
          plaintext,
          targetKeyVersion,
          customKeys,
        );

        patch.apiHashEncrypted = reencrypted.encryptedToken;
        patch.apiHashIv = reencrypted.tokenIv;
        patch.apiHashTag = reencrypted.tokenTag;
        patch.apiHashKeyVersion = targetKeyVersion;
        rowUpdated = true;
      }
    }

    if (rowUpdated) {
      patch.updatedAt = new Date();
      await db
        .update(districtTelegramUserbotSessions)
        .set(patch)
        .where(eq(districtTelegramUserbotSessions.id, row.id));

      migratedCount += 1;
    }
  }

  // Count remaining rows that still reference older versions.
  //
  // Each conjunct tests any column of the envelope rather than only the ciphertext column: a row
  // whose ciphertext is NULL but whose IV or tag is present is an unmigrated corrupt envelope, and
  // an isNotNull(ciphertext)-only test omitted it from the count entirely, letting a rotation report
  // "0 remaining" while such a row sat in the table.
  const baseRemainingWhere = or(
    and(
      or(
        isNotNull(districtTelegramUserbotSessions.sessionEncrypted),
        isNotNull(districtTelegramUserbotSessions.sessionIv),
        isNotNull(districtTelegramUserbotSessions.sessionTag),
      ),
      ne(districtTelegramUserbotSessions.sessionKeyVersion, targetKeyVersion),
    ),
    and(
      or(
        isNotNull(districtTelegramUserbotSessions.apiHashEncrypted),
        isNotNull(districtTelegramUserbotSessions.apiHashIv),
        isNotNull(districtTelegramUserbotSessions.apiHashTag),
      ),
      ne(districtTelegramUserbotSessions.apiHashKeyVersion, targetKeyVersion),
    ),
  );
  const remainingWhere =
    districtIds && districtIds.length > 0
      ? and(baseRemainingWhere, inArray(districtTelegramUserbotSessions.districtId, districtIds))
      : baseRemainingWhere;

  const remainingRows = await db
    .select({ id: districtTelegramUserbotSessions.id })
    .from(districtTelegramUserbotSessions)
    .where(remainingWhere);

  return {
    migratedCount,
    remainingCount: remainingRows.length,
    totalCiphertextRows: rows.length,
  };
}

export interface BackfillEncryptedApiHashOptions {
  targetKeyVersion?: string;
  customKeys?: KeyOverride;
  districtIds?: string[];
}

export interface BackfillEncryptedApiHashResult {
  migratedCount: number;
  skippedCount: number;
  totalRows: number;
}

/**
 * Idempotently backfills encrypted API hash envelope from plaintext api_hash column.
 *
 * Invariants:
 * - Iterates rows where apiHash is present and apiHashEncrypted is null.
 * - An empty or whitespace-only plaintext hash normalizes to null (never encrypted as an empty secret).
 * - A null apiHash remains legal and stays null; no encrypted columns are populated.
 * - Encrypts under targetKeyVersion (defaults to active key version).
 * - Safe against concurrent execution: updates use `WHERE id = row.id AND api_hash_encrypted IS NULL`.
 * - Re-runnable and idempotent: a second run finds 0 unmigrated rows and leaves already-migrated values unchanged.
 */
export async function backfillEncryptedApiHash(
  db: DbOrTx,
  options?: BackfillEncryptedApiHashOptions,
): Promise<BackfillEncryptedApiHashResult> {
  const targetKeyVersion = options?.targetKeyVersion ?? getActiveKeyVersion();
  const customKeys = options?.customKeys;
  const districtIds = options?.districtIds;

  // Assert target key is resolvable before starting backfill
  resolveKeyForVersion(targetKeyVersion, customKeys);

  // Check if plaintext api_hash column exists in the database table
  const columnCheck = await db.execute(sql`
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'district_telegram_userbot_sessions' 
      AND column_name = 'api_hash'
    LIMIT 1;
  `);

  const hasPlaintextColumn = (columnCheck.rows?.length ?? 0) > 0;
  if (!hasPlaintextColumn) {
    // Post-migration state: plaintext column dropped, backfill is completed/no-op
    return {
      migratedCount: 0,
      skippedCount: 0,
      totalRows: 0,
    };
  }

  // Pre-migration state: backfill rows where api_hash is not null and api_hash_encrypted is null
  let rowsQuery = sql`
    SELECT id, district_id, api_hash, api_hash_encrypted
    FROM district_telegram_userbot_sessions
    WHERE api_hash IS NOT NULL AND api_hash_encrypted IS NULL
  `;
  if (districtIds && districtIds.length > 0) {
    rowsQuery = sql`
      SELECT id, district_id, api_hash, api_hash_encrypted
      FROM district_telegram_userbot_sessions
      WHERE api_hash IS NOT NULL AND api_hash_encrypted IS NULL
        AND district_id IN (${sql.join(districtIds.map((id) => sql`${id}`), sql`, `)})
    `;
  }

  const queryResult = await db.execute<{
    id: string;
    district_id: string;
    api_hash: string | null;
    api_hash_encrypted: string | null;
  }>(rowsQuery);
  const rows = queryResult.rows ?? [];

  let migratedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    if (!row.api_hash || row.api_hash.trim().length === 0) {
      // Empty or whitespace-only plaintext hash: normalize to null in DB
      await db.execute(sql`
        UPDATE district_telegram_userbot_sessions
        SET api_hash = NULL,
            api_hash_encrypted = NULL,
            api_hash_iv = NULL,
            api_hash_tag = NULL,
            updated_at = NOW()
        WHERE id = ${row.id} AND api_hash_encrypted IS NULL
      `);
      skippedCount += 1;
      continue;
    }

    const trimmedHash = row.api_hash.trim();
    const encrypted = encryptToken(trimmedHash, targetKeyVersion, customKeys);

    // Concurrency-safe update: only update if api_hash_encrypted is still NULL
    const updateResult = await db.execute(sql`
      UPDATE district_telegram_userbot_sessions
      SET api_hash = ${trimmedHash},
          api_hash_encrypted = ${encrypted.encryptedToken},
          api_hash_iv = ${encrypted.tokenIv},
          api_hash_tag = ${encrypted.tokenTag},
          api_hash_key_version = ${encrypted.tokenKeyVersion},
          updated_at = NOW()
      WHERE id = ${row.id} AND api_hash_encrypted IS NULL
      RETURNING id
    `);

    if ((updateResult.rowCount ?? 0) > 0 || (updateResult.rows?.length ?? 0) > 0) {
      migratedCount += 1;
    } else {
      skippedCount += 1;
    }
  }

  return {
    migratedCount,
    skippedCount,
    totalRows: rows.length,
  };
}

