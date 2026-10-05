import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  encryptToken,
  decryptToken,
  maskBotToken,
  getEncryptionKey,
  getActiveKeyVersion,
  resolveKeyForVersion,
  assertEncryptionKeyConfigured,
  MissingEncryptionKeyError,
  UnresolvableKeyVersionError,
  InvalidKeyLengthError,
} from '../src/adapters/crypto/token-cipher.js';
import { buildHttpServer } from '../src/entrypoints/http.js';
import { startWorker } from '../src/entrypoints/worker.js';
import { startUserbotService } from '../src/entrypoints/userbot.js';

describe('Cryptographic Token Cipher (AES-256-GCM)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
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

    it('throws descriptive InvalidKeyLengthError when key does not resolve to 32 bytes', () => {
      expect(() => getEncryptionKey('short_key')).toThrow(InvalidKeyLengthError);
      expect(() => getEncryptionKey('short_key')).toThrow(
        /Invalid overrideKey length: must resolve to 32 bytes \(256 bits\)/,
      );
      expect(() => getEncryptionKey('a'.repeat(60))).toThrow(InvalidKeyLengthError);
    });

    it('throws MissingEncryptionKeyError naming ENCRYPTION_KEY in every environment when unset', () => {
      delete process.env.ENCRYPTION_KEY;

      for (const envName of ['test', 'development', 'staging', 'production', undefined]) {
        if (envName === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = envName;
        }

        expect(() => getEncryptionKey()).toThrow(MissingEncryptionKeyError);
        expect(() => getEncryptionKey()).toThrow(/ENCRYPTION_KEY must be configured/);
        expect(() => getEncryptionKey()).toThrow(/missing environment variable: ENCRYPTION_KEY/);
      }
    });

    it('has no fallback key literal and returns key strictly from environment', () => {
      process.env.ENCRYPTION_KEY = 'valid_env_key_exactly_32_bytes!!';
      const keyBuffer = getEncryptionKey();
      expect(keyBuffer.toString('utf8')).toBe('valid_env_key_exactly_32_bytes!!');
    });
  });

  describe('Active Key Version and Version Resolution', () => {
    it('defaults active key version to v1 when unset', () => {
      delete process.env.ENCRYPTION_KEY_VERSION;
      expect(getActiveKeyVersion()).toBe('v1');
    });

    it('respects ENCRYPTION_KEY_VERSION environment variable', () => {
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      expect(getActiveKeyVersion()).toBe('v2');
    });

    it('resolves key for active version from ENCRYPTION_KEY', () => {
      process.env.ENCRYPTION_KEY = 'active_key_bytes_32_length_ok123';
      delete process.env.ENCRYPTION_KEY_VERSION; // active is v1

      const resolved = resolveKeyForVersion('v1');
      expect(resolved.toString('utf8')).toBe('active_key_bytes_32_length_ok123');
    });

    it('resolves historical key from ENCRYPTION_KEY_<VERSION> during dual-key window', () => {
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY_V2 = 'key_version_2_32_bytes_length!!!';
      process.env.ENCRYPTION_KEY_V1 = 'key_version_1_32_bytes_length!!!';

      const v1Key = resolveKeyForVersion('v1');
      const v2Key = resolveKeyForVersion('v2');

      expect(v1Key.toString('utf8')).toBe('key_version_1_32_bytes_length!!!');
      expect(v2Key.toString('utf8')).toBe('key_version_2_32_bytes_length!!!');
    });

    it('throws UnresolvableKeyVersionError when key version is unknown / not configured', () => {
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY = 'key_version_2_32_bytes_length!!!';
      delete process.env.ENCRYPTION_KEY_V1;

      expect(() => resolveKeyForVersion('v1')).toThrow(UnresolvableKeyVersionError);
      expect(() => resolveKeyForVersion('v1')).toThrow(
        /Unresolvable encryption key version 'v1': no encryption key configured/,
      );
      // Ensures it NEVER silently falls back to active key
      expect(() => resolveKeyForVersion('v1')).toThrow(/expected ENCRYPTION_KEY_V1/);
    });

    it('throws UnresolvableKeyVersionError when key version is missing or null', () => {
      expect(() => resolveKeyForVersion(null)).toThrow(UnresolvableKeyVersionError);
      expect(() => resolveKeyForVersion(undefined)).toThrow(UnresolvableKeyVersionError);
      expect(() => resolveKeyForVersion('')).toThrow(UnresolvableKeyVersionError);
      expect(() => resolveKeyForVersion('   ')).toThrow(UnresolvableKeyVersionError);
    });

    it('supports custom key dictionary override', () => {
      const keys = {
        v1: 'custom_v1_key_32_bytes_length!!!',
        v2: 'custom_v2_key_32_bytes_length!!!',
      };

      const resolvedV1 = resolveKeyForVersion('v1', keys);
      const resolvedV2 = resolveKeyForVersion('v2', keys);

      expect(resolvedV1.toString('utf8')).toBe(keys.v1);
      expect(resolvedV2.toString('utf8')).toBe(keys.v2);
    });
  });

  describe('Encryption and Decryption Roundtrip with Key Versioning', () => {
    const sampleToken = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567';

    it('successfully encrypts with active version and records it in tokenKeyVersion', () => {
      process.env.ENCRYPTION_KEY = 'test_encryption_key_32_bytes_ok!';
      delete process.env.ENCRYPTION_KEY_VERSION; // active is v1

      const payload = encryptToken(sampleToken);

      expect(payload).toHaveProperty('encryptedToken');
      expect(payload).toHaveProperty('tokenIv');
      expect(payload).toHaveProperty('tokenTag');
      expect(payload.tokenKeyVersion).toBe('v1');
      expect(payload.tokenMasked).toBe('123456789:••••••••••••');

      const decrypted = decryptToken(payload);
      expect(decrypted).toBe(sampleToken);
    });

    it('encrypts with explicit active version when rotated to v2', () => {
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY_V2 = 'active_v2_key_32_bytes_length!!!';

      const payload = encryptToken(sampleToken);
      expect(payload.tokenKeyVersion).toBe('v2');

      const decrypted = decryptToken(payload);
      expect(decrypted).toBe(sampleToken);
    });

    it('decrypts older v1 payload when dual keys (v1 and v2) are configured', () => {
      // 1. Encrypt with v1
      process.env.ENCRYPTION_KEY_VERSION = 'v1';
      process.env.ENCRYPTION_KEY = 'key_version_1_32_bytes_length!!!';
      const v1Payload = encryptToken(sampleToken);
      expect(v1Payload.tokenKeyVersion).toBe('v1');

      // 2. Rotate to v2 and configure both keys
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY = 'key_version_2_32_bytes_length!!!';
      process.env.ENCRYPTION_KEY_V1 = 'key_version_1_32_bytes_length!!!';

      // 3. New writes use v2
      const v2Payload = encryptToken('new_payload_sample_text_123');
      expect(v2Payload.tokenKeyVersion).toBe('v2');

      // 4. Old v1 payload and new v2 payload both decrypt correctly from same runtime
      expect(decryptToken(v1Payload)).toBe(sampleToken);
      expect(decryptToken(v2Payload)).toBe('new_payload_sample_text_123');
    });

    it('throws UnresolvableKeyVersionError when decrypting payload with unconfigured version', () => {
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY = 'key_version_2_32_bytes_length!!!';
      delete process.env.ENCRYPTION_KEY_V1;

      const payload = {
        encryptedToken: 'abcdef123456',
        tokenIv: 'abcdef1234567890abcdef12',
        tokenTag: 'abcdef1234567890abcdef1234567890',
        tokenKeyVersion: 'v1',
      };

      expect(() => decryptToken(payload)).toThrow(UnresolvableKeyVersionError);
      expect(() => decryptToken(payload)).toThrow(/Unresolvable encryption key version 'v1'/);
    });

    it('throws UnresolvableKeyVersionError when decrypting payload with missing or null version', () => {
      process.env.ENCRYPTION_KEY = 'active_key_bytes_32_length_ok123';

      const payloadNoVersion = {
        encryptedToken: 'abcdef123456',
        tokenIv: 'abcdef1234567890abcdef12',
        tokenTag: 'abcdef1234567890abcdef1234567890',
        tokenKeyVersion: null as unknown as string,
      };

      expect(() => decryptToken(payloadNoVersion)).toThrow(UnresolvableKeyVersionError);
      expect(() => decryptToken(payloadNoVersion)).toThrow(/key version is missing or null/);
    });

    it('uses a unique random IV for each encryption pass', () => {
      process.env.ENCRYPTION_KEY = 'test_encryption_key_32_bytes_ok!';
      const payload1 = encryptToken(sampleToken);
      const payload2 = encryptToken(sampleToken);

      expect(payload1.tokenIv).not.toBe(payload2.tokenIv);
      expect(payload1.encryptedToken).not.toBe(payload2.encryptedToken);

      expect(decryptToken(payload1)).toBe(sampleToken);
      expect(decryptToken(payload2)).toBe(sampleToken);
    });
  });

  describe('Tampering and Authentication Tag Integrity', () => {
    const sampleToken = '987654321:XYZabc123_SecureTelegramBotToken';
    const validKey = 'valid_test_key_32_bytes_length!!';

    beforeEach(() => {
      process.env.ENCRYPTION_KEY = validKey;
    });

    it('throws error when ciphertext is tampered with', () => {
      const payload = encryptToken(sampleToken);
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

  describe('Runtime Startup Fail-Fast Invariant', () => {
    it('assertEncryptionKeyConfigured succeeds when active key is configured', () => {
      process.env.ENCRYPTION_KEY = 'test_encryption_key_32_bytes_ok!';
      expect(() => assertEncryptionKeyConfigured()).not.toThrow();
    });

    it('assertEncryptionKeyConfigured fails in every environment name when ENCRYPTION_KEY is unset', () => {
      delete process.env.ENCRYPTION_KEY;

      for (const envName of ['production', 'staging', 'development', 'test', undefined]) {
        if (envName === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = envName;
        }

        expect(() => assertEncryptionKeyConfigured()).toThrow(MissingEncryptionKeyError);
        expect(() => assertEncryptionKeyConfigured()).toThrow(
          /missing environment variable: ENCRYPTION_KEY/,
        );
      }
    });

    it('HTTP server runtime fails to start when ENCRYPTION_KEY is missing in any environment', async () => {
      delete process.env.ENCRYPTION_KEY;
      process.env.NODE_ENV = 'development';

      await expect(buildHttpServer()).rejects.toThrow(MissingEncryptionKeyError);
      await expect(buildHttpServer()).rejects.toThrow(/missing environment variable: ENCRYPTION_KEY/);
    });

    it('Worker runtime fails to start when ENCRYPTION_KEY is missing in any environment', async () => {
      delete process.env.ENCRYPTION_KEY;
      process.env.NODE_ENV = 'test';

      await expect(startWorker()).rejects.toThrow(MissingEncryptionKeyError);
      await expect(startWorker()).rejects.toThrow(/missing environment variable: ENCRYPTION_KEY/);
    });

    it('Userbot service runtime fails to start when ENCRYPTION_KEY is missing in any environment', async () => {
      delete process.env.ENCRYPTION_KEY;
      process.env.NODE_ENV = 'production';

      await expect(startUserbotService()).rejects.toThrow(MissingEncryptionKeyError);
      await expect(startUserbotService()).rejects.toThrow(/missing environment variable: ENCRYPTION_KEY/);
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
