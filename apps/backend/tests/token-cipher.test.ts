import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  encryptToken,
  decryptToken,
  maskBotToken,
  getEncryptionKey,
  FALLBACK_DEV_KEY,
} from '../src/adapters/crypto/token-cipher.js';

describe('Cryptographic Token Cipher (AES-256-GCM)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Key Normalization and Derivation (getEncryptionKey)', () => {
    it('normalizes 64-character hex encryption key correctly into 32 bytes', () => {
      const rawBytes = crypto.randomBytes(32);
      const hexKey = rawBytes.toString('hex');
      const keyBuffer = getEncryptionKey(hexKey);
      expect(keyBuffer.length).toBe(32);
      expect(keyBuffer.equals(rawBytes)).toBe(true);
    });

    it('normalizes 44-character base64 encryption key correctly into 32 bytes', () => {
      const rawBytes = crypto.randomBytes(32);
      const base64Key = rawBytes.toString('base64');
      const keyBuffer = getEncryptionKey(base64Key);
      expect(keyBuffer.length).toBe(32);
      expect(keyBuffer.equals(rawBytes)).toBe(true);
    });

    it('normalizes exact 32-byte UTF-8 string into 32 bytes', () => {
      const stringKey = '12345678901234567890123456789012'; // exactly 32 chars
      const keyBuffer = getEncryptionKey(stringKey);
      expect(keyBuffer.length).toBe(32);
      expect(keyBuffer.toString('utf8')).toBe(stringKey);
    });

    it('throws descriptive error when key does not resolve to 32 bytes', () => {
      expect(() => getEncryptionKey('short_key')).toThrow(
        /Invalid ENCRYPTION_KEY length: must resolve to 32 bytes \(256 bits\)/,
      );
      expect(() => getEncryptionKey('a'.repeat(60))).toThrow(
        /Invalid ENCRYPTION_KEY length: must resolve to 32 bytes \(256 bits\)/,
      );
    });

    it('falls back to dev key in non-production when ENCRYPTION_KEY is unset', () => {
      delete process.env.ENCRYPTION_KEY;
      process.env.NODE_ENV = 'test';
      const keyBuffer = getEncryptionKey();
      expect(keyBuffer.length).toBe(32);
      expect(keyBuffer.toString('utf8')).toBe(FALLBACK_DEV_KEY);
    });

    it('throws error in production when ENCRYPTION_KEY is unset', () => {
      delete process.env.ENCRYPTION_KEY;
      process.env.NODE_ENV = 'production';
      expect(() => getEncryptionKey()).toThrow(
        /ENCRYPTION_KEY must be configured in production/,
      );
    });
  });

  describe('Encryption and Decryption Roundtrip', () => {
    const sampleToken = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567';

    it('successfully encrypts and decrypts a Telegram token', () => {
      const payload = encryptToken(sampleToken);

      expect(payload).toHaveProperty('encryptedToken');
      expect(payload).toHaveProperty('tokenIv');
      expect(payload).toHaveProperty('tokenTag');
      expect(payload.tokenKeyVersion).toBe('v1');
      expect(payload.tokenMasked).toBe('123456789:••••••••••••');

      // IV is 12 bytes -> 24 hex characters
      expect(payload.tokenIv.length).toBe(24);
      // Tag is 16 bytes -> 32 hex characters
      expect(payload.tokenTag.length).toBe(32);

      const decrypted = decryptToken(payload);
      expect(decrypted).toBe(sampleToken);
    });

    it('uses a unique random IV for each encryption pass', () => {
      const payload1 = encryptToken(sampleToken);
      const payload2 = encryptToken(sampleToken);

      expect(payload1.tokenIv).not.toBe(payload2.tokenIv);
      expect(payload1.encryptedToken).not.toBe(payload2.encryptedToken);

      expect(decryptToken(payload1)).toBe(sampleToken);
      expect(decryptToken(payload2)).toBe(sampleToken);
    });

    it('supports custom keyVersion and custom key override', () => {
      const customKey = crypto.randomBytes(32).toString('hex');
      const payload = encryptToken(sampleToken, 'v2', customKey);

      expect(payload.tokenKeyVersion).toBe('v2');
      const decrypted = decryptToken(payload, customKey);
      expect(decrypted).toBe(sampleToken);
    });
  });

  describe('Tampering and Authentication Tag Integrity', () => {
    const sampleToken = '987654321:XYZabc123_SecureTelegramBotToken';

    it('throws error when ciphertext is tampered with', () => {
      const payload = encryptToken(sampleToken);
      // Flip the last character of the hex ciphertext
      const tamperedHex =
        payload.encryptedToken.slice(0, -1) +
        (payload.encryptedToken.endsWith('a') ? 'b' : 'a');

      expect(() =>
        decryptToken({
          ...payload,
          encryptedToken: tamperedHex,
        }),
      ).toThrow();
    });

    it('throws error when authentication tag is tampered with', () => {
      const payload = encryptToken(sampleToken);
      // Flip the last character of the hex tag
      const tamperedTag =
        payload.tokenTag.slice(0, -1) +
        (payload.tokenTag.endsWith('0') ? '1' : '0');

      expect(() =>
        decryptToken({
          ...payload,
          tokenTag: tamperedTag,
        }),
      ).toThrow();
    });

    it('throws error when IV is tampered with', () => {
      const payload = encryptToken(sampleToken);
      const tamperedIv =
        payload.tokenIv.slice(0, -1) +
        (payload.tokenIv.endsWith('f') ? '0' : 'f');

      expect(() =>
        decryptToken({
          ...payload,
          tokenIv: tamperedIv,
        }),
      ).toThrow();
    });

    it('throws error when decrypted with wrong key', () => {
      const key1 = crypto.randomBytes(32).toString('hex');
      const key2 = crypto.randomBytes(32).toString('hex');
      const payload = encryptToken(sampleToken, 'v1', key1);

      expect(() => decryptToken(payload, key2)).toThrow();
    });
  });

  describe('Token Masking (maskBotToken)', () => {
    it('masks standard Telegram token preserving bot ID prefix', () => {
      expect(maskBotToken('123456789:ABCdefGHIjklMNOpqrSTUvwxYZ')).toBe(
        '123456789:••••••••••••',
      );
      expect(maskBotToken('5821948210:AAHk-9428jfkdsjlfsd')).toBe(
        '5821948210:••••••••••••',
      );
    });

    it('masks token with 6 to 16 digit bot ID', () => {
      expect(maskBotToken('123456:secretTokenPart')).toBe('123456:••••••••••••');
      expect(maskBotToken('1234567890123456:secretTokenPart')).toBe(
        '1234567890123456:••••••••••••',
      );
    });

    it('returns safe fallback for malformed or non-matching tokens without throwing', () => {
      expect(maskBotToken('plain_secret_string_without_bot_id')).toBe(
        '••••••••••••',
      );
      expect(maskBotToken('123:short_bot_id')).toBe('••••••••••••');
      expect(maskBotToken('12345678901234567:too_long_bot_id')).toBe(
        '••••••••••••',
      );
      expect(maskBotToken('')).toBe('••••••••••••');
      expect(maskBotToken(null as unknown as string)).toBe('••••••••••••');
      expect(maskBotToken(undefined as unknown as string)).toBe('••••••••••••');
    });
  });
});
