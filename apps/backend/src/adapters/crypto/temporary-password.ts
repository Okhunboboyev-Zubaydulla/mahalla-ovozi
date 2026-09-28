import crypto from 'node:crypto';
import { validatePassword } from './password-policy.js';

export const UPPERCASE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 24 chars (excludes 'I', 'O')
export const LOWERCASE_CHARS = 'abcdefghjkmnpqrstuvwxyz'; // 23 chars (excludes 'i', 'l', 'o')
export const DIGIT_CHARS = '23456789';                   // 8 chars (excludes '0', '1')
export const SYMBOL_CHARS = '!#$%&*+?@';                  // 9 safe symbols
export const UNAMBIGUOUS_ALPHABET = `${UPPERCASE_CHARS}${LOWERCASE_CHARS}${DIGIT_CHARS}${SYMBOL_CHARS}`; // 64 chars total

export const DEFAULT_TEMPORARY_PASSWORD_LENGTH = 18;
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 128;

function getRandomChar(charset: string): string {
  const index = crypto.randomInt(0, charset.length);
  return charset.charAt(index);
}

/**
 * Shuffles an array in-place using the Fisher-Yates algorithm
 * with CSPRNG random integer generation.
 */
function shuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const temp = array[i]!;
    array[i] = array[j]!;
    array[j] = temp;
  }
  return array;
}

/**
 * Generates a cryptographically secure, high-entropy temporary password
 * from a 64-character unambiguous alphabet (zero visual homoglyphs 0/O, 1/l/I, i/o).
 *
 * Guarantees representation of all 4 character classes (uppercase, lowercase, digits, symbols)
 * and verifies output against the password policy and common password blocklist.
 *
 * @param length Desired password length (default: 18, min: 15, max: 128)
 * @returns Cryptographically secure plaintext temporary password
 */
export function generateTemporaryPassword(length: number): string {
  if (typeof length !== 'number' || !Number.isInteger(length) || length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password length must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`);
  }

  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const passwordChars: string[] = [
      getRandomChar(UPPERCASE_CHARS),
      getRandomChar(LOWERCASE_CHARS),
      getRandomChar(DIGIT_CHARS),
      getRandomChar(SYMBOL_CHARS),
    ];

    const remainingCount = length - passwordChars.length;
    for (let i = 0; i < remainingCount; i++) {
      passwordChars.push(getRandomChar(UNAMBIGUOUS_ALPHABET));
    }

    shuffleArray(passwordChars);
    const password = passwordChars.join('');

    const validation = validatePassword(password);
    if (validation.isValid) {
      return password;
    }
  }

  throw new Error('Failed to generate a valid temporary password satisfying the security policy.');
}
