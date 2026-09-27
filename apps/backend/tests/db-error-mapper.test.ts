import { describe, it, expect } from 'vitest';
import {
  extractPostgresError,
  isPostgresError,
  mapPostgresConstraintError,
} from '../src/adapters/db/client.js';

describe('Database Error Mapper Adapter (apps/backend/src/adapters/db/client.ts)', () => {
  describe('extractPostgresError', () => {
    it('returns null for non-error primitives and empty objects', () => {
      expect(extractPostgresError(null)).toBeNull();
      expect(extractPostgresError(undefined)).toBeNull();
      expect(extractPostgresError('error string')).toBeNull();
      expect(extractPostgresError(42)).toBeNull();
      expect(extractPostgresError({})).toBeNull();
      expect(extractPostgresError(new Error('Generic message'))).toBeNull();
    });

    it('extracts properties from a direct node-postgres error object', () => {
      const pgErr = {
        code: '23505',
        constraint: 'districts_name_lower_idx',
        detail: 'Key (lower(name))=(olmazor) already exists.',
        table: 'districts',
        message: 'duplicate key value violates unique constraint "districts_name_lower_idx"',
      };

      const extracted = extractPostgresError(pgErr);
      expect(extracted).not.toBeNull();
      expect(extracted?.code).toBe('23505');
      expect(extracted?.constraint).toBe('districts_name_lower_idx');
      expect(extracted?.detail).toContain('olmazor');
      expect(extracted?.table).toBe('districts');
    });

    it('unwraps nested error from Drizzle Error.cause', () => {
      const rootPgErr = {
        code: '23505',
        constraint: 'district_telegram_groups_chat_id_idx',
        detail: 'Key (telegram_chat_id)=(-100123456) already exists.',
      };
      const drizzleErr = new Error('Failed query: insert into ...');
      (drizzleErr as unknown as { cause: unknown }).cause = rootPgErr;

      const extracted = extractPostgresError(drizzleErr);
      expect(extracted).not.toBeNull();
      expect(extracted?.code).toBe('23505');
      expect(extracted?.constraint).toBe('district_telegram_groups_chat_id_idx');
    });
  });

  describe('isPostgresError', () => {
    it('returns true when error is a postgres error matching expected code', () => {
      const pgErr = { code: '23505', constraint: 'some_idx' };
      expect(isPostgresError(pgErr)).toBe(true);
      expect(isPostgresError(pgErr, '23505')).toBe(true);
      expect(isPostgresError(pgErr, '23503')).toBe(false);
    });

    it('returns false for generic JavaScript errors', () => {
      expect(isPostgresError(new Error('fail'))).toBe(false);
      expect(isPostgresError(null)).toBe(false);
    });
  });

  describe('mapPostgresConstraintError', () => {
    class CustomDuplicateError extends Error {
      readonly code = 'CUSTOM_DUPLICATE';
    }
    class CustomChatExistsError extends Error {
      readonly code = 'CHAT_EXISTS';
    }

    it('throws mapped error when constraint name matches exactly or partially', () => {
      const pgErr = {
        code: '23505',
        constraint: 'districts_name_lower_idx',
        detail: 'Key (lower(name))=(yunusobod) already exists.',
      };

      expect(() => {
        mapPostgresConstraintError(pgErr, {
          districts_name_lower_idx: () => new CustomDuplicateError('Duplicate name'),
          other_idx: () => new CustomChatExistsError('Other'),
        });
      }).toThrowError(CustomDuplicateError);
    });

    it('throws mapped error when matching via detail substring', () => {
      const pgErr = {
        code: '23505',
        detail: 'Key (telegram_chat_id)=(-100999) already exists.',
      };

      expect(() => {
        mapPostgresConstraintError(pgErr, {
          telegram_chat_id: () => new CustomChatExistsError('Chat ID taken'),
        });
      }).toThrowError(CustomChatExistsError);
    });

    it('falls back to defaultError when constraint does not match registered map', () => {
      class FallbackError extends Error {}
      const pgErr = {
        code: '23505',
        constraint: 'unknown_index',
      };

      expect(() => {
        mapPostgresConstraintError(
          pgErr,
          { specific_index: () => new CustomDuplicateError() },
          () => new FallbackError('Fallback occurred'),
        );
      }).toThrowError(FallbackError);
    });

    it('does not throw when error is not a postgres error', () => {
      expect(() => {
        mapPostgresConstraintError(new Error('Plain error'), {
          some_idx: () => new CustomDuplicateError(),
        });
      }).not.toThrow();
    });
  });
});
