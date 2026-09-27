import { describe, it, expect, afterEach } from 'vitest';
import { resolveDatabaseUrl, maskDatabaseUrl } from '../../src/adapters/db/client.js';
import {
  resolveTargetDatabaseName,
  assertCleanTargetAllowed,
} from '../../src/cli/clean-test-data.js';

describe('resolveDatabaseUrl (L2-P01-01)', () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
  });

  it('throws when neither an argument nor DATABASE_URL is present', () => {
    delete process.env.DATABASE_URL;
    expect(() => resolveDatabaseUrl()).toThrow(/No database target/);
  });

  it('does NOT fall back to the development database', () => {
    delete process.env.DATABASE_URL;
    // The old behaviour returned a hardcoded DSN for mahalla_ovozi. It must now throw instead.
    let message = '';
    try {
      resolveDatabaseUrl();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('Refusing to open a connection to an implicit database');
    expect(message).not.toContain('mahalla_dev_password');
  });


  it('prefers the explicit argument over DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@h:5432/from_env';
    expect(resolveDatabaseUrl('postgresql://u:p@h:5432/from_arg')).toContain('from_arg');
  });

  it('uses DATABASE_URL when no argument is given', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@h:5432/from_env';
    expect(resolveDatabaseUrl()).toContain('from_env');
  });
});


describe('clean-test-data target guard (L2-P01-02)', () => {
  it('extracts the database name from a connection string', () => {
    expect(resolveTargetDatabaseName('postgresql://u:p@h:5432/mahalla_ovozi_test')).toBe('mahalla_ovozi_test');
    expect(resolveTargetDatabaseName('postgresql://u:p@h:5432/mahalla_ovozi?sslmode=require')).toBe('mahalla_ovozi');
  });

  it('refuses a production-looking database even with confirmation', () => {
    expect(() =>
      assertCleanTargetAllowed('postgresql://u:p@h:5432/mahalla_ovozi_prod', true),
    ).toThrow(/looks like production/);
  });

  it('refuses ANY database without explicit confirmation', () => {
    expect(() =>
      assertCleanTargetAllowed('postgresql://u:p@h:5432/mahalla_ovozi_dev', false),
    ).toThrow(/without confirmation/);
  });

  it('allows a confirmed non-production target', () => {
    expect(() =>
      assertCleanTargetAllowed('postgresql://u:p@h:5432/mahalla_ovozi_dev', true),
    ).not.toThrow();
  });

  it('masks the password so the target can be printed safely', () => {
    const masked = maskDatabaseUrl('postgresql://mahalla_user:mahalla_dev_password@localhost:5433/mahalla_ovozi');
    expect(masked).not.toContain('mahalla_dev_password');
    expect(masked).toContain('mahalla_user:***@');
  });
});

