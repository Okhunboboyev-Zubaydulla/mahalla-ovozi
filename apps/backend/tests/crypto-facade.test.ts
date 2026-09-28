import { describe, it, expect } from 'vitest';
import { cryptoService } from '../src/adapters/crypto/index.js';
import { checkDbHealth } from '../src/adapters/db/client.js';

describe('Crypto Facade & Database Health (Layer 1 Phase 1.2)', () => {
  it('hashes and verifies passwords via cryptoService.passwords', async () => {
    const raw = 'Correct-Horse-Battery-Staple-2026!';
    const hash = await cryptoService.passwords.hash(raw);
    expect(hash).toContain('$argon2id$');

    const isValid = await cryptoService.passwords.verify(hash, raw);
    expect(isValid).toBe(true);

    const isInvalid = await cryptoService.passwords.verify(hash, 'wrong-password-here!');
    expect(isInvalid).toBe(false);
  });

  it('validates password policy and blocks weak/short passwords', () => {
    const short = cryptoService.passwords.validate('short123');
    expect(short.isValid).toBe(false);
    expect(short.error).toBe('TOO_SHORT');

    const common = cryptoService.passwords.validate('password12345678');
    expect(common.isValid).toBe(false);
    expect(common.error).toBe('COMMON_PASSWORD');

    const strong = cryptoService.passwords.validate('ValidSecurePassword2026!');
    expect(strong.isValid).toBe(true);
  });

  it('generates high-entropy unambiguous temporary passwords', () => {
    const tempPass = cryptoService.passwords.generateTemporary(18);
    expect(tempPass).toHaveLength(18);
    expect(cryptoService.passwords.validate(tempPass).isValid).toBe(true);
  });

  it('encrypts, decrypts, and masks bot tokens via cryptoService.tokens (AD-9)', () => {
    const rawToken = '1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ';
    const encrypted = cryptoService.tokens.encrypt(rawToken);

    expect(encrypted.tokenMasked).toBe('1234567890:••••••••••••');
    expect(encrypted.tokenKeyVersion).toBe('v1');
    expect(encrypted.encryptedToken).toBeDefined();

    const decrypted = cryptoService.tokens.decrypt(encrypted);
    expect(decrypted).toBe(rawToken);
  });

  it('returns graceful health check failure on broken pool without throwing unhandled exceptions', async () => {
    const mockBrokenPool = {
      query: async () => {
        throw new Error('Connection refused: 5432');
      },
    } as any;

    const health = await checkDbHealth(mockBrokenPool, 500);
    expect(health.isHealthy).toBe(false);
    expect(health.error).toContain('Connection refused');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
