import { describe, it, expect } from 'vitest';
import {
  PhoneNumberSchema,
  ApiIdSchema,
  ApiHashSchema,
  CreateUserbotSessionRequestSchema,
} from '../src/userbot-session.js';
import {
  USERBOT_SESSION_AUDIT_ACTIONS,
  UserbotSessionAuditActionSchema,
  USERBOT_AUDIT_ACTIONS,
  UserbotAuditActionSchema,
  ALLOWED_METADATA_SEARCH_KEYS,
} from '../src/audit.js';

describe('Userbot Session Contracts & Boundary Validation', () => {
  describe('PhoneNumberSchema', () => {
    it('accepts valid international format numbers', () => {
      expect(PhoneNumberSchema.parse('+998901234567')).toBe('+998901234567');
      expect(PhoneNumberSchema.parse('+1234567')).toBe('+1234567');
      expect(PhoneNumberSchema.parse('+123456789012345')).toBe('+123456789012345');
    });

    it('rejects numbers missing leading plus', () => {
      expect(() => PhoneNumberSchema.parse('998901234567')).toThrow(/phoneNumber/);
      expect(() => PhoneNumberSchema.parse('123')).toThrow(/phoneNumber/);
    });

    it('rejects numbers with spaces or dashes without normalizing', () => {
      expect(() => PhoneNumberSchema.parse('+998 90 123 45 67')).toThrow(/phoneNumber/);
      expect(() => PhoneNumberSchema.parse('+998-90-1234567')).toThrow(/phoneNumber/);
    });

    it('rejects numbers with non-digit characters', () => {
      expect(() => PhoneNumberSchema.parse('+abcdef')).toThrow(/phoneNumber/);
      expect(() => PhoneNumberSchema.parse('+998(90)1234567')).toThrow(/phoneNumber/);
    });

    it('rejects numbers shorter than 7 digits or longer than 15 digits', () => {
      expect(() => PhoneNumberSchema.parse('+12345')).toThrow(/phoneNumber/);
      expect(() => PhoneNumberSchema.parse('+1234567890123456')).toThrow(/phoneNumber/);
    });
  });

  describe('ApiIdSchema', () => {
    it('accepts positive integer strings and numbers, transforming to string', () => {
      expect(ApiIdSchema.parse('12345678')).toBe('12345678');
      expect(ApiIdSchema.parse(12345678)).toBe('12345678');
      expect(ApiIdSchema.parse(1)).toBe('1');
      expect(ApiIdSchema.parse('1')).toBe('1');
    });

    it('rejects non-numeric API ids', () => {
      expect(() => ApiIdSchema.parse('abc')).toThrow(/apiId/);
      expect(() => ApiIdSchema.parse('')).toThrow(/apiId/);
      expect(() => ApiIdSchema.parse(null)).toThrow(/apiId/);
      expect(() => ApiIdSchema.parse({})).toThrow(/apiId/);
    });

    it('rejects negative and zero API ids', () => {
      expect(() => ApiIdSchema.parse('-5')).toThrow(/apiId/);
      expect(() => ApiIdSchema.parse(-5)).toThrow(/apiId/);
      expect(() => ApiIdSchema.parse('0')).toThrow(/apiId/);
      expect(() => ApiIdSchema.parse(0)).toThrow(/apiId/);
    });

    it('rejects floating point API ids', () => {
      expect(() => ApiIdSchema.parse('12.34')).toThrow(/apiId/);
      expect(() => ApiIdSchema.parse(12.34)).toThrow(/apiId/);
    });

    it('rejects API ids with surrounding whitespace', () => {
      expect(() => ApiIdSchema.parse(' 12345 ')).toThrow(/apiId/);
    });
  });

  describe('ApiHashSchema', () => {
    it('treats whitespace-only string or nullish as absent (undefined)', () => {
      expect(ApiHashSchema.parse('   ')).toBeUndefined();
      expect(ApiHashSchema.parse('')).toBeUndefined();
      expect(ApiHashSchema.parse(undefined)).toBeUndefined();
      expect(ApiHashSchema.parse(null)).toBeUndefined();
    });

    it('accepts non-empty hash matching no expected pattern (non-emptiness check)', () => {
      expect(ApiHashSchema.parse('unusual_hash_pattern_123')).toBe('unusual_hash_pattern_123');
      expect(ApiHashSchema.parse('short')).toBe('short');
      expect(ApiHashSchema.parse('33characters_long_non_standard_hash')).toBe(
        '33characters_long_non_standard_hash',
      );
    });
  });

  describe('CreateUserbotSessionRequestSchema', () => {
    it('accepts valid credentials with numeric apiId and unusual apiHash', () => {
      const parsed = CreateUserbotSessionRequestSchema.parse({
        phoneNumber: '+998901234567',
        apiId: 98765432,
        apiHash: 'valid_unusual_hash',
      });
      expect(parsed).toEqual({
        phoneNumber: '+998901234567',
        apiId: '98765432',
        apiHash: 'valid_unusual_hash',
      });
    });

    it('treats whitespace-only apiHash as absent in request payload', () => {
      const parsed = CreateUserbotSessionRequestSchema.parse({
        phoneNumber: '+998901234567',
        apiId: '12345678',
        apiHash: '   ',
      });
      expect(parsed.apiHash).toBeUndefined();
    });
  });

  describe('USERBOT_SESSION_AUDIT_ACTIONS & UserbotSessionAuditActionSchema', () => {
    it('defines exactly the 8 canonical session lifecycle action names', () => {
      expect(USERBOT_SESSION_AUDIT_ACTIONS).toEqual([
        'USERBOT_SESSION_CREATED',
        'USERBOT_SESSION_ACTIVATED',
        'USERBOT_SESSION_BANNED',
        'USERBOT_SESSION_AUTH_KEY_DUPLICATED',
        'USERBOT_SESSION_DISABLED',
        'USERBOT_SESSION_ENABLED',
        'USERBOT_SESSION_STATUS_UPDATED',
        'USERBOT_SESSION_REVOKED',
      ]);
    });

    it('validates canonical actions and rejects non-canonical action names', () => {
      for (const action of USERBOT_SESSION_AUDIT_ACTIONS) {
        expect(UserbotSessionAuditActionSchema.parse(action)).toBe(action);
      }
      expect(() => UserbotSessionAuditActionSchema.parse('USERBOT_SESSION_DELETED')).toThrow();
      expect(() => UserbotSessionAuditActionSchema.parse('USERBOT_UNKNOWN')).toThrow();
    });
  });

  describe('USERBOT_AUDIT_ACTIONS & UserbotAuditActionSchema (Ticket 21 AC-9)', () => {
    it('defines the 10 userbot audit actions including USERBOT_ABNORMAL_SIGNAL and USERBOT_UNRECOVERABLE_GAP_DETECTED', () => {
      expect(USERBOT_AUDIT_ACTIONS).toEqual([
        ...USERBOT_SESSION_AUDIT_ACTIONS,
        'USERBOT_ABNORMAL_SIGNAL',
        'USERBOT_UNRECOVERABLE_GAP_DETECTED',
      ]);
    });

    it('validates USERBOT_ABNORMAL_SIGNAL and all session actions via UserbotAuditActionSchema', () => {
      expect(UserbotAuditActionSchema.parse('USERBOT_ABNORMAL_SIGNAL')).toBe(
        'USERBOT_ABNORMAL_SIGNAL',
      );
      for (const action of USERBOT_AUDIT_ACTIONS) {
        expect(UserbotAuditActionSchema.parse(action)).toBe(action);
      }
      expect(() => UserbotAuditActionSchema.parse('INVALID_ACTION')).toThrow();
      expect(() => UserbotAuditActionSchema.parse('USERBOT_UNKNOWN')).toThrow();
    });

    it('includes signalType and waitSeconds in ALLOWED_METADATA_SEARCH_KEYS', () => {
      expect(ALLOWED_METADATA_SEARCH_KEYS).toContain('signalType');
      expect(ALLOWED_METADATA_SEARCH_KEYS).toContain('waitSeconds');
    });
  });
});
