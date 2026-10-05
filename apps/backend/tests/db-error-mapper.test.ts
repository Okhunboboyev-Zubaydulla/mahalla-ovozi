import { describe, it, expect } from 'vitest';
import {
  extractPostgresError,
  isPostgresError,
  mapPostgresConstraintError,
  findUniqueViolation,
  isUniqueViolation,
  MAX_ERROR_CAUSE_DEPTH,
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

  describe('findUniqueViolation', () => {
    it('returns null for non-object primitives and null/undefined', () => {
      expect(findUniqueViolation(null)).toBeNull();
      expect(findUniqueViolation(undefined)).toBeNull();
      expect(findUniqueViolation('error string')).toBeNull();
      expect(findUniqueViolation(123)).toBeNull();
      expect(findUniqueViolation(true)).toBeNull();
      expect(findUniqueViolation({})).toBeNull();
      expect(findUniqueViolation(new Error('Generic message'))).toBeNull();
    });

    it('extracts unique violation directly at depth 0', () => {
      const pgErr = {
        code: '23505',
        constraint: 'district_telegram_userbot_sessions_district_id_idx',
        detail: 'Key (district_id)=(dist-123) already exists.',
        table: 'district_telegram_userbot_sessions',
        schema: 'public',
        message: 'duplicate key value violates unique constraint',
      };

      const result = findUniqueViolation(pgErr);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        code: '23505',
        constraint: 'district_telegram_userbot_sessions_district_id_idx',
        detail: 'Key (district_id)=(dist-123) already exists.',
        table: 'district_telegram_userbot_sessions',
        schema: 'public',
        message: 'duplicate key value violates unique constraint',
      });
    });

    it('unwraps nested errors at various depths (1, 2, 3, 5, 7)', () => {
      const leafViolation = {
        code: '23505',
        constraint: 'accepted_evidence_district_chat_msg_idx',
        detail: 'Key already exists',
        table: 'accepted_evidence',
      };

      const wrapAtDepth = (depth: number, inner: unknown): unknown => {
        let cur = inner;
        for (let i = 0; i < depth; i += 1) {
          cur = new Error(`Wrapper layer ${i + 1}`, { cause: cur });
        }
        return cur;
      };

      for (const depth of [1, 2, 3, 5, 7]) {
        const wrapped = wrapAtDepth(depth, leafViolation);
        const result = findUniqueViolation(wrapped);
        expect(result, `Failed to unwrap at depth ${depth}`).not.toBeNull();
        expect(result?.code).toBe('23505');
        expect(result?.constraint).toBe('accepted_evidence_district_chat_msg_idx');
        expect(result?.table).toBe('accepted_evidence');
      }
    });

    it('truncates at MAX_ERROR_CAUSE_DEPTH (depth 8+ returns null)', () => {
      const leafViolation = {
        code: '23505',
        constraint: 'some_unique_idx',
      };

      let atDepth8: unknown = leafViolation;
      for (let i = 0; i < MAX_ERROR_CAUSE_DEPTH; i += 1) {
        atDepth8 = new Error(`Wrapper ${i}`, { cause: atDepth8 });
      }

      // atDepth8 is at depth 8 (index 8 in 0-indexed chain, i.e., 9th error object)
      expect(findUniqueViolation(atDepth8)).toBeNull();
    });

    it('guards against circular reference chains without hanging or overflowing', () => {
      // Self cycle
      const selfCyclic = new Error('self cycle');
      (selfCyclic as unknown as { cause: unknown }).cause = selfCyclic;
      expect(findUniqueViolation(selfCyclic)).toBeNull();

      // Mutual cycle
      const cyclicA = new Error('cyclic A');
      const cyclicB = new Error('cyclic B');
      (cyclicA as unknown as { cause: unknown }).cause = cyclicB;
      (cyclicB as unknown as { cause: unknown }).cause = cyclicA;
      expect(findUniqueViolation(cyclicA)).toBeNull();

      // Cycle with non-matching 23505 error in loop
      const cyclicViolation = { code: '23505', constraint: 'unrelated_idx' };
      const wrapperCycle = new Error('wrapper', { cause: cyclicViolation });
      (cyclicViolation as unknown as { cause: unknown }).cause = wrapperCycle;
      expect(findUniqueViolation(wrapperCycle, 'target_idx')).toBeNull();
    });

    it('matches constraint by exact name or substring', () => {
      const pgErr = {
        code: '23505',
        constraint: 'district_telegram_userbot_sessions_district_id_idx',
      };

      // Exact match
      expect(
        findUniqueViolation(pgErr, 'district_telegram_userbot_sessions_district_id_idx'),
      ).not.toBeNull();

      // Substring match
      expect(findUniqueViolation(pgErr, 'district_id')).not.toBeNull();

      // Mismatch returns null
      expect(findUniqueViolation(pgErr, 'ai_ops_district_op_target_idx')).toBeNull();
    });

    it('handles candidate errors with null or missing constraint', () => {
      const violationNoConstraint = {
        code: '23505',
      };

      // When constraintName requested, cannot attribute so returns null
      expect(findUniqueViolation(violationNoConstraint, 'some_idx')).toBeNull();

      // When no constraintName requested, returns violation with null constraint
      const result = findUniqueViolation(violationNoConstraint);
      expect(result).not.toBeNull();
      expect(result?.code).toBe('23505');
      expect(result?.constraint).toBeNull();
    });

    it('guarantees code and constraint are extracted from the exact same layer', () => {
      // Outer layer has a constraint property but code is not 23505
      // Inner layer has code 23505 and its own constraint
      const innerErr = {
        code: '23505',
        constraint: 'inner_actual_idx',
      };
      const outerErr = new Error('drizzle outer error');
      (outerErr as unknown as { constraint: string; cause: unknown }).constraint =
        'outer_misleading_idx';
      (outerErr as unknown as { cause: unknown }).cause = innerErr;

      // Searching for outer_misleading_idx must fail (return null)
      expect(findUniqueViolation(outerErr, 'outer_misleading_idx')).toBeNull();

      // Searching for inner_actual_idx must succeed
      const matched = findUniqueViolation(outerErr, 'inner_actual_idx');
      expect(matched).not.toBeNull();
      expect(matched?.constraint).toBe('inner_actual_idx');

      // Unconstrained search returns inner layer's constraint, not outer
      const unconstrained = findUniqueViolation(outerErr);
      expect(unconstrained).not.toBeNull();
      expect(unconstrained?.constraint).toBe('inner_actual_idx');
    });

    it('does not reclassify non-23505 database failures', () => {
      const foreignKeyErr = {
        code: '23503',
        constraint: 'district_foreign_key_idx',
      };
      expect(findUniqueViolation(foreignKeyErr)).toBeNull();
      expect(findUniqueViolation(foreignKeyErr, 'district_foreign_key_idx')).toBeNull();

      const wrappedFk = new Error('DB Error', { cause: foreignKeyErr });
      expect(findUniqueViolation(wrappedFk)).toBeNull();
    });
  });

  describe('isUniqueViolation', () => {
    it('returns true when findUniqueViolation finds a matching violation', () => {
      const direct = { code: '23505', constraint: 'my_idx' };
      const nested = new Error('wrap', { cause: direct });

      expect(isUniqueViolation(direct)).toBe(true);
      expect(isUniqueViolation(nested)).toBe(true);
      expect(isUniqueViolation(nested, 'my_idx')).toBe(true);
    });

    it('returns false when no unique violation is found or constraint mismatches', () => {
      const direct = { code: '23505', constraint: 'my_idx' };
      const otherErr = new Error('not a unique violation');

      expect(isUniqueViolation(otherErr)).toBe(false);
      expect(isUniqueViolation(direct, 'different_idx')).toBe(false);
      expect(isUniqueViolation(null)).toBe(false);
    });
  });
});

