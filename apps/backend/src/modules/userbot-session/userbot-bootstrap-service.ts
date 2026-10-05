import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../adapters/db/client.js';
import {
  districts,
  districtTelegramUserbotSessions,
} from '../../adapters/db/schema/index.js';
import { encryptToken, decryptToken, getActiveKeyVersion } from '../../adapters/crypto/token-cipher.js';
import { recordAuditEvent } from '../audit/audit-service.js';
import { DistrictNotFoundError } from '../districts/districts-service.js';
import {
  formatPublicUserbotSession,
  PublicDistrictUserbotSession,
  UserbotSessionNotFoundError,
  UserbotSessionDisabledError,
  SessionBannedError,
} from './userbot-session-service.js';
import {
  PhoneNumberSchema,
  ApiIdSchema,
  ApiHashSchema,
} from '@mahalla-ovozi/api-contracts';
import {
  UserbotAuthClientPort,
  UserbotAuthError,
  InvalidPhoneCodeError,
  Invalid2FAPasswordError,
  UserbotCredentialValidationError,
} from './userbot-auth-port.js';
import { createDefaultUserbotAuthClient } from '../../adapters/telegram/userbot-auth-client.js';
import { logger } from '../../utils/logger.js';

export interface BootstrapUserbotSessionParams {
  districtId: string;
  getPhoneCode: () => Promise<string>;
  getPassword?: () => Promise<string>;
  authClient?: UserbotAuthClientPort;
  actorId?: string;
  actorRole?: string;
  apiHash?: string;
  customEncryptionKey?: string;
  keyVersion?: string;
}

/**
 * Executes the interactive MTProto phone-code login bootstrap flow for a District userbot session.
 * - Authoritatively validates District and Session existence.
 * - Refuses to set ACTIVE when the session is DISABLED (kill switched) or BANNED.
 * - Dispatches sendCode and signIn through the MTProto auth adapter port.
 * - On success: encrypts session string via AES-256-GCM, transitions status to ACTIVE, and emits USERBOT_SESSION_ACTIVATED audit event in a single atomic transaction.
 * - On failure or ban: logs descriptive failure, preserves original session status unchanged without updating to ACTIVE, and rethrows.
 */
export async function bootstrapUserbotSession(
  db: DbOrTx,
  params: BootstrapUserbotSessionParams,
): Promise<PublicDistrictUserbotSession> {
  const districtId = params.districtId.trim();
  if (!districtId) {
    throw new UserbotAuthError('District ID is required for session bootstrap.');
  }

  // 1. Verify District exists
  const [district] = await db
    .select({ id: districts.id })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  // 2. Verify District Userbot Session exists
  const [session] = await db
    .select()
    .from(districtTelegramUserbotSessions)
    .where(eq(districtTelegramUserbotSessions.districtId, districtId))
    .limit(1);

  if (!session) {
    throw new UserbotSessionNotFoundError(districtId);
  }

  // Refuse if session is DISABLED via kill switch or BANNED
  if (session.status === 'DISABLED') {
    throw new UserbotSessionDisabledError(districtId);
  }

  if (session.status === 'BANNED') {
    throw new SessionBannedError(districtId);
  }

  // 3. Resolve API credentials (decrypt from envelope if present, or fallback to params)
  let rawApiHash: string | null = null;
  if (session.apiHashEncrypted && session.apiHashIv && session.apiHashTag) {
    if (!session.apiHashKeyVersion || session.apiHashKeyVersion.trim().length === 0) {
      throw new Error(
        `Userbot session row '${session.id}' (district '${session.districtId}') has encrypted apiHash but a null or missing apiHashKeyVersion`,
      );
    }
    rawApiHash = decryptToken(
      {
        encryptedToken: session.apiHashEncrypted,
        tokenIv: session.apiHashIv,
        tokenTag: session.apiHashTag,
        tokenKeyVersion: session.apiHashKeyVersion,
      },
      params.customEncryptionKey,
    );
  } else if (params.apiHash !== undefined && params.apiHash !== null) {
    rawApiHash = params.apiHash;
  }

  // 4. Validate credentials identically before any protocol handshake is attempted:
  const phoneValidation = PhoneNumberSchema.safeParse(session.phoneNumber);
  if (!phoneValidation.success) {
    throw new UserbotCredentialValidationError(
      'phoneNumber',
      phoneValidation.error.issues[0]?.message || 'Invalid phoneNumber in session.',
    );
  }

  const apiIdValidation = ApiIdSchema.safeParse(session.apiId);
  if (!apiIdValidation.success) {
    throw new UserbotCredentialValidationError(
      'apiId',
      apiIdValidation.error.issues[0]?.message || 'Invalid apiId in session.',
    );
  }

  const hashValidation = ApiHashSchema.safeParse(rawApiHash);
  if (!hashValidation.success || !hashValidation.data) {
    throw new UserbotCredentialValidationError(
      'apiHash',
      `API Hash is required for userbot session bootstrap of district ${districtId} and cannot be empty or whitespace-only.`,
    );
  }

  const validatedPhoneNumber = phoneValidation.data;
  const validatedApiId = apiIdValidation.data;
  const validatedApiHash = hashValidation.data;

  const authClient = params.authClient !== undefined ? params.authClient : createDefaultUserbotAuthClient();

  try {
    // 5. Send confirmation code to Telegram account
    const sendCodeResult = await authClient.sendCode(
      validatedPhoneNumber,
      validatedApiId,
      validatedApiHash,
    );

    // 6. Prompt for the phone verification code
    const phoneCode = await params.getPhoneCode();
    if (!phoneCode || phoneCode.trim().length === 0) {
      throw new InvalidPhoneCodeError('Phone confirmation code cannot be empty.');
    }

    // 7. Sign in with the received code
    const signInResult = await authClient.signIn({
      phoneNumber: validatedPhoneNumber,
      phoneCodeHash: sendCodeResult.phoneCodeHash,
      phoneCode: phoneCode.trim(),
    });

    let sessionString: string;

    if ('requiresPassword' in signInResult) {
      if (!params.getPassword) {
        throw new UserbotAuthError(
          'Two-factor authentication (2FA) is required for this account, but no password callback was provided.',
        );
      }
      const password = await params.getPassword();
      if (!password || password.length === 0) {
        throw new Invalid2FAPasswordError('Two-factor authentication password cannot be empty.');
      }
      const passwordResult = await authClient.signInWithPassword({ password });
      sessionString = passwordResult.sessionString;
    } else {
      sessionString = signInResult.sessionString;
    }

    // 8. Encrypt session string and API hash using AES-256-GCM
    const targetKeyVersion = params.keyVersion ?? getActiveKeyVersion();
    const encrypted = encryptToken(
      sessionString.trim(),
      targetKeyVersion,
      params.customEncryptionKey,
    );
    const encApiHash = encryptToken(
      validatedApiHash,
      targetKeyVersion,
      params.customEncryptionKey,
    );

    // 8. Persist encrypted credentials and transition status to ACTIVE atomically with audit event
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.id, session.id))
        .limit(1);

      if (!current) {
        throw new UserbotSessionNotFoundError(districtId);
      }

      if (current.status === 'DISABLED') {
        throw new UserbotSessionDisabledError(districtId);
      }

      if (current.status === 'BANNED') {
        throw new SessionBannedError(districtId);
      }

      const [updatedRow] = await tx
        .update(districtTelegramUserbotSessions)
        .set({
          status: 'ACTIVE',
          sessionEncrypted: encrypted.encryptedToken,
          sessionIv: encrypted.tokenIv,
          sessionTag: encrypted.tokenTag,
          sessionKeyVersion: encrypted.tokenKeyVersion,
          apiHashEncrypted: encApiHash.encryptedToken,
          apiHashIv: encApiHash.tokenIv,
          apiHashTag: encApiHash.tokenTag,
          apiHashKeyVersion: encApiHash.tokenKeyVersion,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(districtTelegramUserbotSessions.id, session.id))
        .returning();

      if (!updatedRow) {
        throw new Error(`Failed to update userbot session for district ${districtId}.`);
      }

      // 9. Emit audit event for session activation
      await recordAuditEvent(tx, {
        districtId,
        actorId: params.actorId || null,
        actorRole: params.actorRole ?? 'PRODUCT_OWNER',
        action: 'USERBOT_SESSION_ACTIVATED',
        metadata: {
          sessionId: session.id,
          status: 'ACTIVE',
          previousStatus: current.status,
          newStatus: 'ACTIVE',
        },
      });

      return updatedRow;
    });

    return formatPublicUserbotSession(updated);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { districtId, sessionId: session.id, err: errorMsg },
      'Bootstrap failed for district',
    );
    // Re-throw without altering database status to ACTIVE
    throw err;
  }
}
