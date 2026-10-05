import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyTelegramSignal,
  toUserbotSignalError,
  isSessionRevokedSignal,
  isTransientDisconnectSignal,
  isClassifiedUserbotSignal,
  UserbotSignalError,
} from '../src/adapters/telegram/telegram-signal-classifier.js';
import type {
  ClassifiedUserbotSignal,
  UserbotFloodWaitSignal,
  UserbotUnrecoverableGapSignal,
} from '../src/modules/userbot/userbot-client-port.js';

describe('Userbot Signal Classification (Ticket 24)', () => {
  describe('All 10 signal categories classification', () => {
    it('classifies ACCOUNT_BANNED for phone number banned errors', () => {
      const err1 = new Error('PHONE_NUMBER_BANNED: The phone number is banned');
      const sig1 = classifyTelegramSignal(err1);
      expect(sig1.category).toBe('ACCOUNT_BANNED');
      expect(sig1.error).toBe(err1);

      const err2 = { code: 'PHONE_NUMBER_BANNED', message: 'RPCError 400' };
      const sig2 = classifyTelegramSignal(err2);
      expect(sig2.category).toBe('ACCOUNT_BANNED');

      const err3 = new Error('USER_BANNED');
      const sig3 = classifyTelegramSignal(err3);
      expect(sig3.category).toBe('ACCOUNT_BANNED');

      const err4 = { className: 'PhoneNumberBannedError', message: 'Banned' };
      const sig4 = classifyTelegramSignal(err4);
      expect(sig4.category).toBe('ACCOUNT_BANNED');
    });

    it('classifies AUTH_KEY_DUPLICATED when key is used elsewhere', () => {
      const err1 = new Error('AUTH_KEY_DUPLICATED: The authorization key has been used elsewhere');
      const sig1 = classifyTelegramSignal(err1);
      expect(sig1.category).toBe('AUTH_KEY_DUPLICATED');
      expect(sig1.error).toBe(err1);

      const err2 = { code: 'AUTH_KEY_DUPLICATED', message: 'RPCError 406' };
      const sig2 = classifyTelegramSignal(err2);
      expect(sig2.category).toBe('AUTH_KEY_DUPLICATED');

      const err3 = { className: 'AuthKeyDuplicatedError', message: 'Duplicated key' };
      const sig3 = classifyTelegramSignal(err3);
      expect(sig3.category).toBe('AUTH_KEY_DUPLICATED');
    });

    it('classifies ACCOUNT_DELETED for deactivated user errors', () => {
      const err1 = new Error('USER_DEACTIVATED: The user has been deleted/deactivated');
      const sig1 = classifyTelegramSignal(err1);
      expect(sig1.category).toBe('ACCOUNT_DELETED');

      const err2 = new Error('USER_DEACTIVATED_BAN');
      const sig2 = classifyTelegramSignal(err2);
      expect(sig2.category).toBe('ACCOUNT_DELETED');

      const err3 = new Error('ACCOUNT_DELETED');
      const sig3 = classifyTelegramSignal(err3);
      expect(sig3.category).toBe('ACCOUNT_DELETED');
    });

    it('classifies SESSION_REVOKED for unregistered key or expired session', () => {
      const revokedCases = [
        new Error('AUTH_KEY_UNREGISTERED'),
        new Error('AUTH_KEY_INVALID'),
        new Error('SESSION_REVOKED'),
        new Error('SESSION_EXPIRED'),
        new Error('SESSION_PASSWORD_NEEDED'),
        new Error('Not a valid string'),
        new Error('No more data left to read'),
        new Error('INVALID_SESSION'),
        new Error('EMPTY_SESSION'),
      ];

      for (const err of revokedCases) {
        const sig = classifyTelegramSignal(err);
        expect(sig.category).toBe('SESSION_REVOKED');
      }
    });

    it('classifies FLOOD_WAIT and extracts waitSeconds correctly', () => {
      const err1 = new Error('FLOOD_WAIT_15: A wait of 15 seconds is required');
      const sig1 = classifyTelegramSignal(err1) as UserbotFloodWaitSignal;
      expect(sig1.category).toBe('FLOOD_WAIT');
      expect(sig1.waitSeconds).toBe(15);

      const err2 = new Error('A wait of 42 seconds is required (caused by ResolveUsername)');
      const sig2 = classifyTelegramSignal(err2) as UserbotFloodWaitSignal;
      expect(sig2.category).toBe('FLOOD_WAIT');
      expect(sig2.waitSeconds).toBe(42);

      const err3 = { message: 'FloodWaitError', seconds: 120 };
      const sig3 = classifyTelegramSignal(err3) as UserbotFloodWaitSignal;
      expect(sig3.category).toBe('FLOOD_WAIT');
      expect(sig3.waitSeconds).toBe(120);

      const err4 = new Error('FLOOD_WAIT');
      const sig4 = classifyTelegramSignal(err4) as UserbotFloodWaitSignal;
      expect(sig4.category).toBe('FLOOD_WAIT');
      expect(sig4.waitSeconds).toBe(60); // Default fallback
    });

    it('classifies PEER_FLOOD for peer flood rate limits', () => {
      const err1 = new Error('PEER_FLOOD: Too many requests to this peer');
      const sig1 = classifyTelegramSignal(err1);
      expect(sig1.category).toBe('PEER_FLOOD');

      const err2 = { className: 'PeerFloodError', message: 'Peer flood error' };
      const sig2 = classifyTelegramSignal(err2);
      expect(sig2.category).toBe('PEER_FLOOD');
    });

    it('classifies ACCOUNT_RESTRICTION for permissions and restriction errors', () => {
      const restrictionCases = [
        new Error('USER_RESTRICTED'),
        new Error('ACCOUNT_RESTRICTED'),
        new Error('CHAT_WRITE_FORBIDDEN'),
        new Error('CHAT_ADMIN_REQUIRED'),
      ];

      for (const err of restrictionCases) {
        const sig = classifyTelegramSignal(err);
        expect(sig.category).toBe('ACCOUNT_RESTRICTION');
      }
    });

    it('classifies UNRECOVERABLE_GAP for update stream gaps', () => {
      const gapCases = [
        new Error('UPDATECHANNELTOOLONG'),
        new Error('UPDATESTOOLONG'),
        new Error('DIFFERENCE_TOO_LONG'),
        new Error('differenceTooLong'),
        new Error('PERSISTENT_TIMESTAMP_INVALID'),
        new Error('PERSISTENT_TIMESTAMP_OUT_OF_SYNC'),
        new Error('PTS_OUT_OF_BOUNDS'),
        new Error('UNRECOVERABLE_GAP'),
        new Error('update gap occurred'),
      ];

      for (const err of gapCases) {
        const sig = classifyTelegramSignal(err);
        expect(sig.category).toBe('UNRECOVERABLE_GAP');
      }

      // Passes lastKnownPosition through when present on error
      const gapWithPos = {
        message: 'UPDATECHANNELTOOLONG',
        lastKnownPosition: '{"pts":1234,"date":1700000000}',
      };
      const sigWithPos = classifyTelegramSignal(gapWithPos) as UserbotUnrecoverableGapSignal;
      expect(sigWithPos.category).toBe('UNRECOVERABLE_GAP');
      expect(sigWithPos.lastKnownPosition).toBe('{"pts":1234,"date":1700000000}');
    });

    it('classifies TRANSIENT_DISCONNECT for network drops and socket teardowns', () => {
      const transientCases = [
        { code: 'ECONNRESET', message: 'read ECONNRESET' },
        { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' },
        { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
        { code: 'EPIPE', message: 'write EPIPE' },
        { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' },
        { code: 'EHOSTUNREACH', message: 'connect EHOSTUNREACH' },
        { code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN' },
        new Error('Connection closed'),
        new Error('Connection reset by peer'),
        new Error('Socket closed'),
        new Error('NETWORK_MIGRATE_2'),
        new Error('CONNECTION_LOST'),
        new Error('Ping timeout'),
        new Error('Broken pipe'),
        new Error('Hangup'),
      ];

      for (const err of transientCases) {
        const sig = classifyTelegramSignal(err);
        expect(sig.category).toBe('TRANSIENT_DISCONNECT');
      }
    });

    it('classifies UNCLASSIFIED for unknown errors, null, and undefined', () => {
      const sigNull = classifyTelegramSignal(null);
      expect(sigNull.category).toBe('UNCLASSIFIED');

      const sigUndef = classifyTelegramSignal(undefined);
      expect(sigUndef.category).toBe('UNCLASSIFIED');

      const sigUnknown = classifyTelegramSignal(new Error('Some completely unrelated application exception'));
      expect(sigUnknown.category).toBe('UNCLASSIFIED');
    });
  });

  describe('Separation of transient drops from permanent revocation', () => {
    it('isSessionRevokedSignal returns true ONLY for permanent revocation/loss categories', () => {
      expect(isSessionRevokedSignal(new Error('SESSION_REVOKED'))).toBe(true);
      expect(isSessionRevokedSignal(new Error('AUTH_KEY_UNREGISTERED'))).toBe(true);
      expect(isSessionRevokedSignal(new Error('AUTH_KEY_DUPLICATED'))).toBe(true);
      expect(isSessionRevokedSignal(new Error('USER_DEACTIVATED'))).toBe(true);
      expect(isSessionRevokedSignal(new Error('ACCOUNT_DELETED'))).toBe(true);

      // Transient disconnects MUST NOT be treated as session revocation
      expect(isSessionRevokedSignal({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe(false);
      expect(isSessionRevokedSignal(new Error('Connection closed'))).toBe(false);
      expect(isSessionRevokedSignal(new Error('Socket closed'))).toBe(false);
      expect(isSessionRevokedSignal(new Error('FLOOD_WAIT_15'))).toBe(false);
      expect(isSessionRevokedSignal(new Error('PEER_FLOOD'))).toBe(false);
      expect(isSessionRevokedSignal(new Error('UPDATECHANNELTOOLONG'))).toBe(false);
      expect(isSessionRevokedSignal(new Error('Unknown error'))).toBe(false);
      expect(isSessionRevokedSignal(null)).toBe(false);
    });

    it('isTransientDisconnectSignal returns true ONLY for transient drops', () => {
      expect(isTransientDisconnectSignal({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe(true);
      expect(isTransientDisconnectSignal({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' })).toBe(true);
      expect(isTransientDisconnectSignal(new Error('Connection closed'))).toBe(true);
      expect(isTransientDisconnectSignal(new Error('Socket closed'))).toBe(true);
      expect(isTransientDisconnectSignal(new Error('NETWORK_MIGRATE'))).toBe(true);

      // Revocations, bans, flood waits MUST NOT be transient disconnects
      expect(isTransientDisconnectSignal(new Error('PHONE_NUMBER_BANNED'))).toBe(false);
      expect(isTransientDisconnectSignal(new Error('SESSION_REVOKED'))).toBe(false);
      expect(isTransientDisconnectSignal(new Error('AUTH_KEY_DUPLICATED'))).toBe(false);
      expect(isTransientDisconnectSignal(new Error('FLOOD_WAIT_15'))).toBe(false);
      expect(isTransientDisconnectSignal(null)).toBe(false);
    });
  });

  describe('Typed signal helpers and idempotency', () => {
    it('isClassifiedUserbotSignal correctly detects typed signal objects', () => {
      const signal: ClassifiedUserbotSignal = {
        category: 'ACCOUNT_BANNED',
        reason: 'Banned',
      };
      expect(isClassifiedUserbotSignal(signal)).toBe(true);
      expect(isClassifiedUserbotSignal(new Error('Banned'))).toBe(false);
      expect(isClassifiedUserbotSignal(null)).toBe(false);
      expect(isClassifiedUserbotSignal({})).toBe(false);
    });

    it('classifyTelegramSignal is idempotent when passed an already-classified signal or UserbotSignalError', () => {
      const originalSignal: ClassifiedUserbotSignal = {
        category: 'ACCOUNT_BANNED',
        reason: 'Banned',
      };
      const result1 = classifyTelegramSignal(originalSignal);
      expect(result1).toBe(originalSignal);

      const signalErr = new UserbotSignalError(originalSignal);
      const result2 = classifyTelegramSignal(signalErr);
      expect(result2).toBe(originalSignal);
    });

    it('toUserbotSignalError wraps errors cleanly into UserbotSignalError', () => {
      const err = new Error('PHONE_NUMBER_BANNED');
      const wrapped = toUserbotSignalError(err);
      expect(wrapped).toBeInstanceOf(UserbotSignalError);
      expect(wrapped.category).toBe('ACCOUNT_BANNED');
      expect(wrapped.signal.category).toBe('ACCOUNT_BANNED');
      expect(wrapped.signal.error).toBe(err);

      // Idempotency: re-wrapping returns the exact same instance
      expect(toUserbotSignalError(wrapped)).toBe(wrapped);
    });
  });

  describe('Static analysis: Encapsulation Invariant', () => {
    it('asserts zero raw Telegram error string matching in userbot-connection-manager.ts', () => {
      const filePath = path.resolve(__dirname, '../src/modules/userbot/userbot-connection-manager.ts');
      const content = fs.readFileSync(filePath, 'utf-8');

      // Check for raw regex or string matching on error properties
      const forbiddenPatterns = [
        /err(or)?\.message\.includes/i,
        /err(or)?\.code\s*===/i,
        /PHONE_NUMBER_BANNED.*\.test/i,
        /AUTH_KEY_DUPLICATED.*\.test/i,
        /USER_DEACTIVATED.*\.test/i,
        /FLOOD_WAIT_.*\.test/i,
        /\.match\(\/.*FLOOD_WAIT/i,
        /\.match\(\/.*UPDATECHANNELTOOLONG/i,
      ];

      for (const pattern of forbiddenPatterns) {
        expect(content).not.toMatch(pattern);
      }
    });

    it('asserts zero raw Telegram error string matching in userbot-session-service.ts', () => {
      const filePath = path.resolve(__dirname, '../src/modules/userbot-session/userbot-session-service.ts');
      const content = fs.readFileSync(filePath, 'utf-8');

      const forbiddenPatterns = [
        /err(or)?\.message\.includes/i,
        /err(or)?\.code\s*===/i,
        /AUTH_KEY_UNREGISTERED/i,
        /SESSION_REVOKED/i,
        /USER_DEACTIVATED/i,
        /PHONE_NUMBER_BANNED/i,
      ];

      for (const pattern of forbiddenPatterns) {
        expect(content).not.toMatch(pattern);
      }
    });
  });
});
