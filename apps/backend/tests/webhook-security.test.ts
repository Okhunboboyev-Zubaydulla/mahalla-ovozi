import { describe, it, expect } from 'vitest';
import {
  deriveWebhookSecret,
  verifyTelegramSecretToken,
  sanitizeDriverError,
} from '../src/modules/telegram-intake/webhook-security.js';

describe('Telegram Webhook Security Utilities', () => {
  const botId = '123456789';

  it('generates consistent HMAC-SHA256 secret for a given botId', () => {
    const secret1 = deriveWebhookSecret(botId);
    const secret2 = deriveWebhookSecret(botId);
    expect(secret1).toBe(secret2);
    expect(typeof secret1).toBe('string');
    expect(secret1.length).toBe(64); // hex-encoded sha256
  });

  it('generates different secrets for different botIds', () => {
    const secret1 = deriveWebhookSecret('111111');
    const secret2 = deriveWebhookSecret('222222');
    expect(secret1).not.toBe(secret2);
  });

  it('validates matching secret token string successfully', () => {
    const secret = deriveWebhookSecret(botId);
    const isValid = verifyTelegramSecretToken(secret, secret);
    expect(isValid).toBe(true);
  });

  it('validates matching secret token passed in an array (Fastify header behavior)', () => {
    const secret = deriveWebhookSecret(botId);
    const isValid = verifyTelegramSecretToken([secret], secret);
    expect(isValid).toBe(true);
  });

  it('rejects tampered or mismatched secret token without throwing', () => {
    const secret = deriveWebhookSecret(botId);
    const invalidSecret = secret.slice(0, -2) + 'aa';
    const isValid = verifyTelegramSecretToken(invalidSecret, secret);
    expect(isValid).toBe(false);
  });

  it('rejects completely different length token without RangeError', () => {
    const secret = deriveWebhookSecret(botId);
    const shortToken = 'short';
    const longToken = secret + 'extra-long-padding-bytes';

    expect(() => verifyTelegramSecretToken(shortToken, secret)).not.toThrow();
    expect(verifyTelegramSecretToken(shortToken, secret)).toBe(false);
    expect(verifyTelegramSecretToken(longToken, secret)).toBe(false);
  });

  it('rejects missing or undefined headers safely', () => {
    const secret = deriveWebhookSecret(botId);
    expect(verifyTelegramSecretToken(undefined, secret)).toBe(false);
    expect(verifyTelegramSecretToken('', secret)).toBe(false);
    expect(verifyTelegramSecretToken([], secret)).toBe(false);
  });

  it('safely handles non-string or undefined botId and expectedSecret', () => {
    expect(deriveWebhookSecret(undefined as any)).toBe('');
    expect(deriveWebhookSecret(null as any)).toBe('');
    expect(deriveWebhookSecret('' as any)).toBe('');
    expect(verifyTelegramSecretToken('some-token', undefined as any)).toBe(false);
    expect(verifyTelegramSecretToken('some-token', null as any)).toBe(false);
    expect(verifyTelegramSecretToken('some-token', '' as any)).toBe(false);
  });

  it('sanitizes sensitive driver errors and strips SQL VALUES and bot tokens (AD-11)', () => {
    const rawSqlError = new Error(
      "error: insert into telegram_intakes VALUES ('intake_1', 'sensitive citizen text') failed",
    );
    const sanitizedSql = sanitizeDriverError(rawSqlError);
    expect(sanitizedSql.errorName).toBe('Error');
    expect(sanitizedSql.errorMessage).not.toContain('sensitive citizen text');
    expect(sanitizedSql.errorMessage).toContain('VALUES (...)');

    const rawTokenError = new Error(
      'FetchError: request to https://api.telegram.org/bot123456789:ABCdefGHIjklMNO_secret/getWebhookInfo failed',
    );
    const sanitizedToken = sanitizeDriverError(rawTokenError);
    expect(sanitizedToken.errorMessage).not.toContain('ABCdefGHIjklMNO_secret');
    expect(sanitizedToken.errorMessage).toContain('bot[REDACTED]/getWebhookInfo');

    const nonError = sanitizeDriverError('plain string error');
    expect(nonError.errorName).toBe('UnknownError');
    expect(nonError.errorMessage).toBe('Internal persistence error');
  });
});
