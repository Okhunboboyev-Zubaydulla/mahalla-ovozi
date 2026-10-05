/**
 * MTProto Telegram Typed Signal Classifier (Ticket 24).
 * Encapsulates all raw string matching, regex inspection, and RPC error classifications
 * from Telegram/MTProto libraries.
 *
 * INVARIANT: Raw string matching on Telegram error messages MUST remain strictly inside
 * this adapter module. Callers outside this directory must only branch on typed categories.
 */

import {
  ClassifiedUserbotSignal,
  UserbotSignalCategory,
  UserbotSignalError,
  UserbotAccountBannedSignal,
  UserbotAuthKeyDuplicatedSignal,
  UserbotAccountDeletedSignal,
  UserbotSessionRevokedSignal,
  UserbotFloodWaitSignal,
  UserbotPeerFloodSignal,
  UserbotAccountRestrictionSignal,
  UserbotUnrecoverableGapSignal,
  UserbotTransientDisconnectSignal,
  UserbotUnclassifiedSignal,
} from '../../modules/userbot/userbot-client-port.js';

export { UserbotSignalError };

export type {
  ClassifiedUserbotSignal,
  UserbotSignalCategory,
  UserbotAccountBannedSignal,
  UserbotAuthKeyDuplicatedSignal,
  UserbotAccountDeletedSignal,
  UserbotSessionRevokedSignal,
  UserbotFloodWaitSignal,
  UserbotPeerFloodSignal,
  UserbotAccountRestrictionSignal,
  UserbotUnrecoverableGapSignal,
  UserbotTransientDisconnectSignal,
  UserbotUnclassifiedSignal,
};

/**
 * Type guard checking if a value is already a ClassifiedUserbotSignal.
 */
export function isClassifiedUserbotSignal(val: unknown): val is ClassifiedUserbotSignal {
  return (
    typeof val === 'object' &&
    val !== null &&
    'category' in val &&
    typeof (val as { category: unknown }).category === 'string' &&
    'reason' in val &&
    typeof (val as { reason: unknown }).reason === 'string'
  );
}

/**
 * Extracts wait seconds from a flood wait error if present.
 */
function extractWaitSeconds(err: unknown, message: string, upper: string): number | null {
  if (
    typeof err === 'object' &&
    err !== null &&
    'seconds' in err &&
    typeof (err as { seconds: unknown }).seconds === 'number'
  ) {
    return (err as { seconds: number }).seconds;
  }

  const match = upper.match(/FLOOD_WAIT_(\d+)/i) || message.match(/wait of (\d+) seconds/i);
  if (match && match[1]) {
    const parsed = parseInt(match[1], 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * Classifies an arbitrary Telegram or network error into a typed ClassifiedUserbotSignal.
 */
export function classifyTelegramSignal(err: unknown): ClassifiedUserbotSignal {
  if (err instanceof UserbotSignalError) {
    return err.signal;
  }

  if (isClassifiedUserbotSignal(err)) {
    return err;
  }

  if (!err) {
    return {
      category: 'UNCLASSIFIED',
      reason: 'Unknown error (null or undefined)',
      error: new Error('Unknown error'),
    };
  }

  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === 'string'
        ? (err as { message: string }).message
        : typeof (err as { reason?: unknown })?.reason === 'string'
          ? (err as { reason: string }).reason
          : String(err);

  const code =
    typeof (err as { code?: unknown })?.code === 'string' ||
    typeof (err as { code?: unknown })?.code === 'number'
      ? String((err as { code: unknown }).code)
      : '';

  const className =
    typeof (err as { className?: unknown })?.className === 'string'
      ? (err as { className: string }).className
      : err instanceof Error && err.constructor?.name
        ? err.constructor.name
        : '';

  const originalError = err instanceof Error ? err : new Error(message || 'Unknown error');
  const upper = `${message} ${code} ${className}`.toUpperCase();

  // 1. ACCOUNT_BANNED
  if (
    upper.includes('PHONE_NUMBER_BANNED') ||
    upper.includes('PHONENUMBERBANNED') ||
    upper.includes('USER_BANNED') ||
    upper.includes('USERBANNED') ||
    code === 'PHONE_NUMBER_BANNED' ||
    code === 'USER_BANNED'
  ) {
    return {
      category: 'ACCOUNT_BANNED',
      reason: message || 'PHONE_NUMBER_BANNED',
      error: originalError,
    };
  }

  // 2. AUTH_KEY_DUPLICATED
  if (
    upper.includes('AUTH_KEY_DUPLICATED') ||
    upper.includes('AUTHKEYDUPLICATED') ||
    code === 'AUTH_KEY_DUPLICATED'
  ) {
    return {
      category: 'AUTH_KEY_DUPLICATED',
      reason: message || 'AUTH_KEY_DUPLICATED',
      error: originalError,
    };
  }

  // 3. ACCOUNT_DELETED
  if (
    upper.includes('USER_DEACTIVATED') ||
    upper.includes('USERDEACTIVATED') ||
    upper.includes('ACCOUNT_DELETED') ||
    upper.includes('ACCOUNTDELETED') ||
    upper.includes('USER_DEACTIVATED_BAN')
  ) {
    return {
      category: 'ACCOUNT_DELETED',
      reason: message || 'USER_DEACTIVATED',
      error: originalError,
    };
  }

  // 4. SESSION_REVOKED
  if (
    upper.includes('SESSION_REVOKED') ||
    upper.includes('SESSIONREVOKED') ||
    upper.includes('AUTH_KEY_UNREGISTERED') ||
    upper.includes('AUTHKEYUNREGISTERED') ||
    upper.includes('AUTH_KEY_INVALID') ||
    upper.includes('AUTHKEYINVALID') ||
    upper.includes('SESSION_EXPIRED') ||
    upper.includes('SESSIONEXPIRED') ||
    upper.includes('SESSION_PASSWORD_NEEDED') ||
    upper.includes('SESSIONPASSWORDNEEDED') ||
    upper.includes('NOT A VALID STRING') ||
    upper.includes('NO MORE DATA LEFT TO READ') ||
    upper.includes('INVALID_SESSION') ||
    upper.includes('EMPTY_SESSION')
  ) {
    return {
      category: 'SESSION_REVOKED',
      reason: message || 'SESSION_REVOKED',
      error: originalError,
    };
  }

  // 5. FLOOD_WAIT
  const waitSeconds = extractWaitSeconds(err, message, upper);
  if (waitSeconds !== null || upper.includes('FLOOD_WAIT') || upper.includes('FLOODWAIT')) {
    return {
      category: 'FLOOD_WAIT',
      reason: message || `FLOOD_WAIT_${waitSeconds ?? 60}`,
      waitSeconds: waitSeconds ?? 60,
      error: originalError,
    };
  }

  // 6. PEER_FLOOD
  if (upper.includes('PEER_FLOOD') || upper.includes('PEERFLOOD')) {
    return {
      category: 'PEER_FLOOD',
      reason: message || 'PEER_FLOOD',
      error: originalError,
    };
  }

  // 7. ACCOUNT_RESTRICTION
  if (
    upper.includes('USER_RESTRICTED') ||
    upper.includes('USERRESTRICTED') ||
    upper.includes('ACCOUNT_RESTRICTED') ||
    upper.includes('ACCOUNTRESTRICTED') ||
    upper.includes('CHAT_WRITE_FORBIDDEN') ||
    upper.includes('CHATWRITEFORBIDDEN') ||
    upper.includes('CHAT_ADMIN_REQUIRED') ||
    upper.includes('CHATADMINREQUIRED')
  ) {
    return {
      category: 'ACCOUNT_RESTRICTION',
      reason: message || 'ACCOUNT_RESTRICTION',
      error: originalError,
    };
  }

  // 8. UNRECOVERABLE_GAP
  if (
    upper.includes('UPDATECHANNELTOOLONG') ||
    upper.includes('UPDATESTOOLONG') ||
    upper.includes('DIFFERENCE_TOO_LONG') ||
    upper.includes('DIFFERENCETOOLONG') ||
    upper.includes('PERSISTENT_TIMESTAMP_INVALID') ||
    upper.includes('PERSISTENT_TIMESTAMP_OUT_OF_SYNC') ||
    upper.includes('PTS_OUT_OF_BOUNDS') ||
    upper.includes('UNRECOVERABLE_GAP') ||
    upper.includes('UPDATE GAP') ||
    upper.includes('UPDATE_GAP')
  ) {
    const lastKnownPosition =
      typeof (err as { lastKnownPosition?: unknown })?.lastKnownPosition === 'string'
        ? (err as { lastKnownPosition: string }).lastKnownPosition
        : null;

    return {
      category: 'UNRECOVERABLE_GAP',
      reason: message || 'UNRECOVERABLE_GAP',
      lastKnownPosition,
      error: originalError,
    };
  }

  // 9. TRANSIENT_DISCONNECT
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNABORTED' ||
    upper.includes('ECONNRESET') ||
    upper.includes('ETIMEDOUT') ||
    upper.includes('ECONNREFUSED') ||
    upper.includes('EPIPE') ||
    upper.includes('ENOTFOUND') ||
    upper.includes('EHOSTUNREACH') ||
    upper.includes('EAI_AGAIN') ||
    upper.includes('CONNECTION RESET BY PEER') ||
    upper.includes('NETWORK_MIGRATE') ||
    upper.includes('NETWORKMIGRATE') ||
    upper.includes('CONNECTION_LOST') ||
    upper.includes('CONNECTIONLOST') ||
    upper.includes('SOCKET_CLOSED') ||
    upper.includes('SOCKET CLOSED') ||
    upper.includes('CONNECTION CLOSED') ||
    upper.includes('CONNECTION_CLOSED') ||
    upper.includes('CONNECTIONCLOSED') ||
    upper.includes('DISCONNECTED') ||
    upper.includes('TIMEOUT') ||
    upper.includes('PING_TIMEOUT') ||
    upper.includes('BROKEN PIPE') ||
    upper.includes('HANG_UP') ||
    upper.includes('HANGUP')
  ) {
    return {
      category: 'TRANSIENT_DISCONNECT',
      reason: message || 'TRANSIENT_DISCONNECT',
      error: originalError,
    };
  }

  // 10. UNCLASSIFIED
  return {
    category: 'UNCLASSIFIED',
    reason: message || 'UNCLASSIFIED',
    error: originalError,
  };
}

/**
 * Wraps any Telegram or network error into a UserbotSignalError.
 */
export function toUserbotSignalError(err: unknown): UserbotSignalError {
  if (err instanceof UserbotSignalError) {
    return err;
  }
  const signal = classifyTelegramSignal(err);
  return new UserbotSignalError(signal);
}

/**
 * Returns true if the signal or error represents permanent session revocation or account gone on Telegram's servers.
 */
export function isSessionRevokedSignal(signalOrErr: ClassifiedUserbotSignal | unknown): boolean {
  if (!signalOrErr) return false;
  const signal = isClassifiedUserbotSignal(signalOrErr)
    ? signalOrErr
    : classifyTelegramSignal(signalOrErr);
  return (
    signal.category === 'SESSION_REVOKED' ||
    signal.category === 'AUTH_KEY_DUPLICATED' ||
    signal.category === 'ACCOUNT_DELETED'
  );
}

/**
 * Returns true if the signal or error represents a transient MTProto connection drop or socket teardown.
 */
export function isTransientDisconnectSignal(signalOrErr: ClassifiedUserbotSignal | unknown): boolean {
  if (!signalOrErr) return false;
  const signal = isClassifiedUserbotSignal(signalOrErr)
    ? signalOrErr
    : classifyTelegramSignal(signalOrErr);
  return signal.category === 'TRANSIENT_DISCONNECT';
}
