import crypto from 'node:crypto';

export interface EncryptedTokenPayload {
  encryptedToken: string;
  tokenIv: string;
  tokenTag: string;
  tokenKeyVersion: string;
  tokenMasked: string;
}

export interface DecryptTokenPayload {
  encryptedToken: string;
  tokenIv: string;
  tokenTag: string;
}

export const FALLBACK_DEV_KEY = 'dev_encryption_key_32_bytes_len!';

/**
 * Derives and normalizes a 32-byte AES-256-GCM encryption key from environment variable or override.
 * Supports:
 * - 64-character Hex string (32 bytes)
 * - 44-character Base64 string (32 bytes)
 * - Exact 32-byte UTF-8 string
 */
export function getEncryptionKey(overrideKey?: string): Buffer {
  const rawKey = (overrideKey ?? process.env.ENCRYPTION_KEY)?.trim();

  if (!rawKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY must be configured in production');
    }
    return Buffer.from(FALLBACK_DEV_KEY, 'utf8');
  }

  let buffer: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    buffer = Buffer.from(rawKey, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=$/.test(rawKey) || (rawKey.length === 44 && rawKey.endsWith('='))) {
    buffer = Buffer.from(rawKey, 'base64');
  } else {
    buffer = Buffer.from(rawKey, 'utf8');
  }

  if (buffer.length !== 32) {
    throw new Error(
      `Invalid ENCRYPTION_KEY length: must resolve to 32 bytes (256 bits), received ${buffer.length} bytes`,
    );
  }

  return buffer;
}

/**
 * Safely masks a Telegram Bot Token by keeping the public bot ID prefix
 * while hiding all secret characters. If malformed, returns a safe uniform mask.
 * E.g. "123456789:ABCdefGHIjklMNO" -> "123456789:••••••••••••"
 */
export function maskBotToken(token: string): string {
  if (!token || typeof token !== 'string') {
    return '••••••••••••';
  }
  const match = /^(\d{6,16}):.+$/.exec(token.trim());
  if (match && match[1]) {
    return `${match[1]}:••••••••••••`;
  }
  return '••••••••••••';
}

/**
 * Encrypts a plaintext Telegram Bot Token using AES-256-GCM with a random 12-byte IV.
 * Extracts the 16-byte authentication tag strictly after finalizing the cipher stream.
 */
export function encryptToken(
  token: string,
  keyVersion: string = 'v1',
  customKey?: string,
): EncryptedTokenPayload {
  const key = getEncryptionKey(customKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    encryptedToken: encrypted.toString('hex'),
    tokenIv: iv.toString('hex'),
    tokenTag: tag.toString('hex'),
    tokenKeyVersion: keyVersion,
    tokenMasked: maskBotToken(token),
  };
}

/**
 * Decrypts an authenticated ciphertext payload using AES-256-GCM.
 * Validates integrity via GCM authentication tag before returning plaintext.
 */
export function decryptToken(
  payload: DecryptTokenPayload,
  customKey?: string,
): string {
  const key = getEncryptionKey(customKey);
  const iv = Buffer.from(payload.tokenIv, 'hex');
  const tag = Buffer.from(payload.tokenTag, 'hex');
  const ciphertext = Buffer.from(payload.encryptedToken, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
