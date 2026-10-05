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
  tokenKeyVersion: string;
}

export type KeyOverride = string | Record<string, string>;

export const DEFAULT_KEY_VERSION = 'v1';

export class MissingEncryptionKeyError extends Error {
  constructor(message: string = 'ENCRYPTION_KEY must be configured (missing environment variable: ENCRYPTION_KEY)') {
    super(message);
    this.name = 'MissingEncryptionKeyError';
  }
}

export class UnresolvableKeyVersionError extends Error {
  constructor(version: string, details?: string) {
    const extra = details ? ` (${details})` : '';
    super(`Unresolvable encryption key version '${version}': no encryption key configured${extra}`);
    this.name = 'UnresolvableKeyVersionError';
  }
}

export class InvalidKeyLengthError extends Error {
  constructor(length: number, envVar: string = 'ENCRYPTION_KEY') {
    super(`Invalid ${envVar} length: must resolve to 32 bytes (256 bits), received ${length} bytes`);
    this.name = 'InvalidKeyLengthError';
  }
}

/**
 * Returns the currently active encryption key version.
 * Can be overridden via ENCRYPTION_KEY_VERSION environment variable.
 */
export function getActiveKeyVersion(): string {
  const envVersion = process.env.ENCRYPTION_KEY_VERSION?.trim();
  return envVersion && envVersion.length > 0 ? envVersion : DEFAULT_KEY_VERSION;
}

/**
 * Normalizes a raw key string into a 32-byte Buffer.
 * Supports:
 * - 64-character Hex string (32 bytes)
 * - 44-character Base64 string (32 bytes)
 * - Exact 32-byte UTF-8 string
 */
export function normalizeKey(rawKey: string, envVarName: string = 'ENCRYPTION_KEY'): Buffer {
  const trimmed = rawKey.trim();
  let buffer: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    buffer = Buffer.from(trimmed, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed) || (trimmed.length === 44 && trimmed.endsWith('='))) {
    buffer = Buffer.from(trimmed, 'base64');
  } else {
    buffer = Buffer.from(trimmed, 'utf8');
  }

  if (buffer.length !== 32) {
    throw new InvalidKeyLengthError(buffer.length, envVarName);
  }

  return buffer;
}

/**
 * Derives and normalizes a 32-byte AES-256-GCM encryption key from environment variable or override.
 * Unconditionally throws MissingEncryptionKeyError if ENCRYPTION_KEY is unset in ANY environment.
 */
export function getEncryptionKey(overrideKey?: string): Buffer {
  if (overrideKey && overrideKey.trim().length > 0) {
    return normalizeKey(overrideKey, 'overrideKey');
  }

  const rawKey = process.env.ENCRYPTION_KEY?.trim();
  if (!rawKey) {
    throw new MissingEncryptionKeyError(
      'ENCRYPTION_KEY must be configured (missing environment variable: ENCRYPTION_KEY)',
    );
  }

  return normalizeKey(rawKey, 'ENCRYPTION_KEY');
}

/**
 * Resolves a 32-byte key for a specific key version string.
 * Dispatches on:
 * 1. Explicit keyOverride string or Record<string, string> dictionary.
 * 2. Version-specific environment variable ENCRYPTION_KEY_<VERSION> (e.g. ENCRYPTION_KEY_V1).
 * 3. Base ENCRYPTION_KEY environment variable if the requested version matches getActiveKeyVersion().
 * Throws explicit UnresolvableKeyVersionError or MissingEncryptionKeyError if no key is configured.
 */
export function resolveKeyForVersion(
  version: string | null | undefined,
  keyOverride?: KeyOverride,
): Buffer {
  if (!version || typeof version !== 'string' || version.trim().length === 0) {
    throw new UnresolvableKeyVersionError(
      String(version),
      'key version is missing or null: decryption requires an explicit key version',
    );
  }

  const cleanVersion = version.trim();

  // If a single string override was supplied, use it
  if (typeof keyOverride === 'string' && keyOverride.trim().length > 0) {
    return normalizeKey(keyOverride, 'customKey');
  }

  // If a dictionary of key overrides was supplied
  if (keyOverride && typeof keyOverride === 'object') {
    const override = keyOverride[cleanVersion];
    if (override) {
      return normalizeKey(override, `customKey[${cleanVersion}]`);
    }
  }

  // 1. Check version-specific env var: ENCRYPTION_KEY_<VERSION> (e.g. ENCRYPTION_KEY_V1, ENCRYPTION_KEY_V2)
  const envVarName = `ENCRYPTION_KEY_${cleanVersion.toUpperCase()}`;
  const versionSpecificKey = process.env[envVarName]?.trim();
  if (versionSpecificKey) {
    return normalizeKey(versionSpecificKey, envVarName);
  }

  // 2. Check if cleanVersion is the active key version
  const activeVersion = getActiveKeyVersion();
  if (cleanVersion === activeVersion) {
    const rawKey = process.env.ENCRYPTION_KEY?.trim();
    if (rawKey) {
      return normalizeKey(rawKey, 'ENCRYPTION_KEY');
    }
    throw new MissingEncryptionKeyError(
      `ENCRYPTION_KEY must be configured for active key version '${cleanVersion}' (missing environment variable: ENCRYPTION_KEY)`,
    );
  }

  // 3. Neither version-specific env var nor active ENCRYPTION_KEY matches
  throw new UnresolvableKeyVersionError(
    cleanVersion,
    `expected ${envVarName} or active ENCRYPTION_KEY for version '${activeVersion}'`,
  );
}

/**
 * Asserts that the active encryption key is configured and valid at runtime boot time.
 * Throws MissingEncryptionKeyError or InvalidKeyLengthError immediately if unresolvable.
 */
export function assertEncryptionKeyConfigured(): void {
  const activeVersion = getActiveKeyVersion();
  try {
    resolveKeyForVersion(activeVersion);
  } catch (err: unknown) {
    if (
      err instanceof MissingEncryptionKeyError ||
      err instanceof UnresolvableKeyVersionError ||
      err instanceof InvalidKeyLengthError
    ) {
      throw err;
    }
    throw new MissingEncryptionKeyError(
      `Failed to resolve encryption key for active version '${activeVersion}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
 * Encrypts a plaintext Telegram Bot Token or session string using AES-256-GCM with a random 12-byte IV.
 * Uses the specified keyVersion or the active key version, and records it in the payload.
 * Extracts the 16-byte authentication tag strictly after finalizing the cipher stream.
 */
export function encryptToken(
  token: string,
  keyVersion?: string,
  customKeyOrMap?: KeyOverride,
): EncryptedTokenPayload {
  const version = keyVersion ? keyVersion.trim() : getActiveKeyVersion();
  const key = resolveKeyForVersion(version, customKeyOrMap);
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
    tokenKeyVersion: version,
    tokenMasked: maskBotToken(token),
  };
}

/**
 * Decrypts an authenticated ciphertext payload using AES-256-GCM.
 * Key version on the payload is load-bearing: resolves the specific key matching tokenKeyVersion.
 * Validates integrity via GCM authentication tag before returning plaintext.
 */
export function decryptToken(
  payload: DecryptTokenPayload,
  customKeyOrMap?: KeyOverride,
): string {
  if (!payload || !payload.encryptedToken || !payload.tokenIv || !payload.tokenTag) {
    throw new Error('Invalid decrypt payload: encryptedToken, tokenIv, and tokenTag are required');
  }

  const key = resolveKeyForVersion(payload.tokenKeyVersion, customKeyOrMap);
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
