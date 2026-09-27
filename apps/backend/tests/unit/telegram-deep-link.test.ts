import { describe, it, expect } from 'vitest';
import { resolveTelegramDeepLink } from '../../src/modules/topics/topic-evidence-service.js';

describe('resolveTelegramDeepLink unit tests', () => {
  describe('Tier 1: Public group with username', () => {
    it('resolves deep link when group username has leading @', () => {
      const link = resolveTelegramDeepLink('@bobur_mahalla', '-1005507761144', '101');
      expect(link).toBe('https://t.me/bobur_mahalla/101');
    });

    it('resolves deep link when group username does not have leading @', () => {
      const link = resolveTelegramDeepLink('bobur_mahalla', '-1005507761144', '101');
      expect(link).toBe('https://t.me/bobur_mahalla/101');
    });

    it('trims whitespace around group username', () => {
      const link = resolveTelegramDeepLink('  @bobur_mahalla  ', '-1005507761144', '101');
      expect(link).toBe('https://t.me/bobur_mahalla/101');
    });
  });

  describe('Tier 2: Private groups and supergroups (t.me/c/)', () => {
    it('resolves deep link for supergroup with -100 prefix', () => {
      const link = resolveTelegramDeepLink(null, '-1005507761144', '146');
      expect(link).toBe('https://t.me/c/5507761144/146');
    });

    it('resolves deep link for basic group with - prefix (Gulbodom production case)', () => {
      const link = resolveTelegramDeepLink(null, '-5507761144', '146');
      expect(link).toBe('https://t.me/c/5507761144/146');
    });

    it('resolves deep link for plain numeric chat ID', () => {
      const link = resolveTelegramDeepLink(null, '5507761144', '146');
      expect(link).toBe('https://t.me/c/5507761144/146');
    });

    it('handles empty group username string by falling back to chatId resolution', () => {
      const link = resolveTelegramDeepLink('   ', '-5507761144', '146');
      expect(link).toBe('https://t.me/c/5507761144/146');
    });
  });

  describe('Tier 3: Graceful fallback to null for malformed or missing identifiers', () => {
    it('returns null when chatId is empty string', () => {
      expect(resolveTelegramDeepLink(null, '', '101')).toBeNull();
    });

    it('returns null when messageId is empty string', () => {
      expect(resolveTelegramDeepLink(null, '-5507761144', '')).toBeNull();
    });

    it('returns null when chatId is non-numeric string', () => {
      expect(resolveTelegramDeepLink(null, 'not_a_valid_id', '101')).toBeNull();
      expect(resolveTelegramDeepLink(null, '-abc', '101')).toBeNull();
    });

    it('returns null when chatId only contains prefix (- or -100)', () => {
      expect(resolveTelegramDeepLink(null, '-', '101')).toBeNull();
      expect(resolveTelegramDeepLink(null, '-100', '101')).toBeNull();
    });
  });
});
