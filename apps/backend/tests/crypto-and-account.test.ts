import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validatePassword } from '../src/adapters/crypto/password-policy.js';
import { hashPassword, verifyPassword } from '../src/adapters/crypto/argon2.js';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import { createOrResetProductOwner } from '../src/modules/auth/account-service.js';
import { accounts, sessions, auditEvents } from '../src/adapters/db/schema/index.js';
import { eq } from 'drizzle-orm';
import pg from 'pg';

describe('Password Policy, Argon2id & Product Owner Account Management', () => {
  let pool: pg.Pool;
  let db: DbClient;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Password Policy Validator', () => {
    it('validates a strong 15+ character password', () => {
      const result = validatePassword('Mahalla-Ovozi-Secure-Pass-2026!');
      expect(result.isValid).toBe(true);
    });

    it('validates complex Unicode and Uzbek Cyrillic passwords', () => {
      const result = validatePassword('МаҳаллаОвозиХавфсизПарол2026!');
      expect(result.isValid).toBe(true);
    });

    it('rejects passwords shorter than 15 Unicode code points', () => {
      const result = validatePassword('ShortPass123!');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('TOO_SHORT');
    });

    it('rejects passwords longer than 128 characters', () => {
      const longPass = 'A'.repeat(129);
      const result = validatePassword(longPass);
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('TOO_LONG');
    });

    it('rejects common/compromised passwords offline without network calls', () => {
      const result = validatePassword('correcthorsebatterystaple');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('COMMON_PASSWORD');
    });

    it('does not silently trim whitespace characters', () => {
      // 13 visible chars + 2 leading spaces = 15 chars
      const passWithSpaces = '  1234567890abc';
      const result = validatePassword(passWithSpaces);
      expect(result.isValid).toBe(true);
    });
  });

  describe('Argon2id Hasher & Verifier', () => {
    it('hashes and correctly verifies passwords with Argon2id parameters', async () => {
      const rawPassword = 'Unique-Test-Password-2026-Xyz!';
      const hash = await hashPassword(rawPassword);

      expect(hash).toContain('$argon2id$');
      expect(hash).toContain('m=65536,t=3,p=1');

      const isMatch = await verifyPassword(hash, rawPassword);
      expect(isMatch).toBe(true);

      const isWrongMatch = await verifyPassword(hash, 'Wrong-Password-Attempt-123!');
      expect(isWrongMatch).toBe(false);
    });
  });

  describe('Product Owner Account Management Service', () => {
    const testUsername = `po_test_${Date.now()}`;
    const initialPassword = 'Initial-Secure-Password-12345!';
    const newPassword = 'Reset-Secure-Password-67890!';

    it('creates a new Product Owner account with Argon2id hash and audit trail', async () => {
      const result = await createOrResetProductOwner(db, {
        username: testUsername,
        password: initialPassword,
      });

      expect(result.isNew).toBe(true);
      expect(result.username).toBe(testUsername);
      expect(result.credentialVersion).toBe(1);

      // Verify database record
      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.username, testUsername))
        .limit(1);

      expect(account).toBeDefined();
      expect(account?.role).toBe('PRODUCT_OWNER');
      expect(account?.credentialVersion).toBe(1);
      expect(await verifyPassword(account!.passwordHash, initialPassword)).toBe(true);

      // Verify privacy-safe audit event
      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actorId, account!.id))
        .limit(1);

      expect(audit).toBeDefined();
      expect(audit?.action).toBe('ACCOUNT_PO_CREATED');
      expect(audit?.metadata).not.toHaveProperty('password');
      expect(audit?.metadata).not.toHaveProperty('passwordHash');
    });

    it('resets password, increments credential_version, and revokes active sessions', async () => {
      const [accountBefore] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.username, testUsername))
        .limit(1);

      // Create a dummy active session
      const sessionId = `sess_${Date.now()}`;
      await db.insert(sessions).values({
        id: sessionId,
        accountId: accountBefore!.id,
        tokenHash: `dummy_token_hash_${Date.now()}`,
        credentialVersion: accountBefore!.credentialVersion,
        expiresAt: new Date(Date.now() + 3600000),
      });

      // Perform reset
      const resetResult = await createOrResetProductOwner(db, {
        username: testUsername,
        password: newPassword,
      });

      expect(resetResult.isNew).toBe(false);
      expect(resetResult.credentialVersion).toBe(2);

      // Verify updated account
      const [accountAfter] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.username, testUsername))
        .limit(1);

      expect(accountAfter?.credentialVersion).toBe(2);
      expect(await verifyPassword(accountAfter!.passwordHash, newPassword)).toBe(true);
      expect(await verifyPassword(accountAfter!.passwordHash, initialPassword)).toBe(false);

      // Verify old session was revoked
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);

      expect(session?.revokedAt).not.toBeNull();
    });
  });
});
