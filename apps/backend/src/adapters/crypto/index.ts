import { hashPassword, verifyPassword } from './argon2.js';
import { validatePassword } from './password-policy.js';
import { generateTemporaryPassword } from './temporary-password.js';
import { encryptToken, decryptToken, maskBotToken } from './token-cipher.js';

// Re-export only the public API surface — internal implementation details
// (ARGON2_CONFIG, COMMON_PASSWORDS_BLOCKLIST, UNAMBIGUOUS_ALPHABET, getEncryptionKey,
// FALLBACK_DEV_KEY) are intentionally NOT re-exported. They are package-private to
// adapters/crypto/ and must not leak into domain code.
export type { PasswordValidationResult } from './password-policy.js';
export type { EncryptedTokenPayload, DecryptTokenPayload } from './token-cipher.js';

/**
 * Unified Cryptographic Services Facade for Mahalla Ovozi backend.
 *
 * Exposed operations only — no internal key derivation, config constants, or
 * raw alphabet/blocklist primitives on the public surface.
 */
export const cryptoService = {
  passwords: {
    hash: hashPassword,
    verify: verifyPassword,
    validate: validatePassword,
    generateTemporary: generateTemporaryPassword,
  },
  tokens: {
    encrypt: encryptToken,
    decrypt: decryptToken,
    mask: maskBotToken,
  },
};

export type CryptoService = typeof cryptoService;
