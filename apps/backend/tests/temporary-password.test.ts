import { describe, it, expect } from 'vitest';
import {
  generateTemporaryPassword,
  DEFAULT_TEMPORARY_PASSWORD_LENGTH,
  UNAMBIGUOUS_ALPHABET,
  UPPERCASE_CHARS,
  LOWERCASE_CHARS,
  DIGIT_CHARS,
  SYMBOL_CHARS,
} from '../src/adapters/crypto/temporary-password.js';
import { validatePassword } from '../src/adapters/crypto/password-policy.js';

describe('Temporary Password Generator (CSPRNG & Unambiguous Alphabet)', () => {
  it('generates an 18-character password when requested', () => {
    const password = generateTemporaryPassword(DEFAULT_TEMPORARY_PASSWORD_LENGTH);
    expect(password).toHaveLength(18);
  });

  it('supports custom lengths >= 15 and <= 128', () => {
    const p15 = generateTemporaryPassword(15);
    const p24 = generateTemporaryPassword(24);
    const p64 = generateTemporaryPassword(64);

    expect(p15).toHaveLength(15);
    expect(p24).toHaveLength(24);
    expect(p64).toHaveLength(64);
  });

  it('throws an error for lengths < 15, > 128, or non-integers', () => {
    expect(() => generateTemporaryPassword(14)).toThrow('Password length must be between 15 and 128 characters.');
    expect(() => generateTemporaryPassword(0)).toThrow('Password length must be between 15 and 128 characters.');
    expect(() => generateTemporaryPassword(129)).toThrow('Password length must be between 15 and 128 characters.');
    expect(() => generateTemporaryPassword(NaN)).toThrow('Password length must be between 15 and 128 characters.');
    expect(() => generateTemporaryPassword(18.5)).toThrow('Password length must be between 15 and 128 characters.');
  });

  it('contains exactly 64 characters in the unambiguous alphabet without homoglyphs', () => {
    expect(UNAMBIGUOUS_ALPHABET).toHaveLength(64);
    // Ensure all characters in the alphabet are unique
    const uniqueChars = new Set(UNAMBIGUOUS_ALPHABET);
    expect(uniqueChars.size).toBe(64);

    // Verify homoglyphs 0, O, 1, l, I, i, o are strictly excluded
    const forbiddenHomoglyphs = ['0', 'O', '1', 'l', 'I', 'i', 'o'];
    for (const char of forbiddenHomoglyphs) {
      expect(UNAMBIGUOUS_ALPHABET.includes(char)).toBe(false);
    }
  });

  it('guarantees representation of all 4 character classes in every generated password', () => {
    for (let i = 0; i < 50; i++) {
      const password = generateTemporaryPassword(18);

      const hasUpper = [...password].some((c) => UPPERCASE_CHARS.includes(c));
      const hasLower = [...password].some((c) => LOWERCASE_CHARS.includes(c));
      const hasDigit = [...password].some((c) => DIGIT_CHARS.includes(c));
      const hasSymbol = [...password].some((c) => SYMBOL_CHARS.includes(c));

      expect(hasUpper).toBe(true);
      expect(hasLower).toBe(true);
      expect(hasDigit).toBe(true);
      expect(hasSymbol).toBe(true);
    }
  });

  it('never contains ambiguous homoglyphs in generated passwords', () => {
    const forbiddenHomoglyphs = ['0', 'O', '1', 'l', 'I', 'i', 'o'];
    for (let i = 0; i < 50; i++) {
      const password = generateTemporaryPassword(18);
      for (const char of forbiddenHomoglyphs) {
        expect(password.includes(char)).toBe(false);
      }
    }
  });

  it('passes validatePassword from password-policy for every generated password', () => {
    for (let i = 0; i < 50; i++) {
      const password = generateTemporaryPassword(18);
      const validation = validatePassword(password);
      expect(validation.isValid).toBe(true);
    }
  });

  it('produces unique random passwords on repeated generations', () => {
    const passwords = new Set<string>();
    const count = 100;
    for (let i = 0; i < count; i++) {
      passwords.add(generateTemporaryPassword(18));
    }
    expect(passwords.size).toBe(count);
  });
});
