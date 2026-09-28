import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import {
  districts,
  districtTelegramUserbotSessions,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import {
  createDistrictUserbotSession,
  getDecryptedUserbotSession,
  disableDistrictUserbotSession,
  UserbotSessionNotFoundError,
  UserbotSessionDisabledError,
} from '../src/modules/userbot-session/userbot-session-service.js';
import {
  bootstrapUserbotSession,
} from '../src/modules/userbot-session/userbot-bootstrap-service.js';
import * as auditService from '../src/modules/audit/audit-service.js';
import {
  UserbotAuthClientPort,
  SendCodeResult,
  SignInParams,
  SignInResult,
  SignInWithPasswordParams,
  PhoneNumberBannedError,
  InvalidPhoneCodeError,
} from '../src/modules/userbot-session/userbot-auth-port.js';
import { DistrictNotFoundError } from '../src/modules/districts/districts-service.js';

class MockUserbotAuthClient implements UserbotAuthClientPort {
  sendCodeCalls: Array<{ phoneNumber: string; apiId: string; apiHash: string }> = [];
  signInCalls: Array<SignInParams> = [];
  signInWithPasswordCalls: Array<SignInWithPasswordParams> = [];

  sendCodeResult: SendCodeResult = { phoneCodeHash: 'mock_code_hash_123', isCodeViaApp: false };
  sendCodeError: Error | null = null;

  signInResult: SignInResult = { sessionString: '1BJWNg...mockSessionString...' };
  signInError: Error | null = null;

  signInWithPasswordResult: { sessionString: string } = {
    sessionString: '1BJWNg...mock2FASessionString...',
  };
  signInWithPasswordError: Error | null = null;

  async sendCode(phoneNumber: string, apiId: string, apiHash: string): Promise<SendCodeResult> {
    this.sendCodeCalls.push({ phoneNumber, apiId, apiHash });
    if (this.sendCodeError) {
      throw this.sendCodeError;
    }
    return this.sendCodeResult;
  }

  async signIn(params: SignInParams): Promise<SignInResult> {
    this.signInCalls.push(params);
    if (this.signInError) {
      throw this.signInError;
    }
    return this.signInResult;
  }

  async signInWithPassword(params: SignInWithPasswordParams): Promise<{ sessionString: string }> {
    this.signInWithPasswordCalls.push(params);
    if (this.signInWithPasswordError) {
      throw this.signInWithPasswordError;
    }
    return this.signInWithPasswordResult;
  }
}

describe('District Userbot Session Bootstrap CLI & Domain Service (Ticket 05)', () => {
  let pool: pg.Pool;
  let db: DbClient;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createTestDistrict(namePrefix: string): Promise<string> {
    const districtId = `dist_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: districtId,
      name: `${namePrefix}_${crypto.randomUUID().slice(0, 8)}`,
      region: 'Tashkent',
      status: 'ACTIVE',
    });
    return districtId;
  }

  it('Test 1: Successful login flow transitions session in DB to ACTIVE, persists encrypted secret, and writes audit record', async () => {
    const districtId = await createTestDistrict('BootstrapSuccess');
    const phoneNumber = '+998901234567';
    const apiId = '20401010';
    const apiHash = 'mock_api_hash_abc123';
    const expectedSessionString = '1BJWNg...gramjsValidSessionString123456789...';

    // 1. Pre-condition: Userbot session created with status PENDING and no session string
    const pendingSession = await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber,
      apiId,
      apiHash,
    });
    expect(pendingSession.status).toBe('PENDING');
    expect(pendingSession.hasSession).toBe(false);

    // 2. Setup mock auth client
    const mockAuth = new MockUserbotAuthClient();
    mockAuth.sendCodeResult = { phoneCodeHash: 'phone_code_hash_xyz_1' };
    mockAuth.signInResult = { sessionString: expectedSessionString };

    let phoneCodeRequested = false;

    // 3. Execute bootstrapUserbotSession
    const result = await bootstrapUserbotSession(db, {
      districtId,
      getPhoneCode: async () => {
        phoneCodeRequested = true;
        return '54321';
      },
      authClient: mockAuth,
      actorId: 'admin_tester_po',
    });

    // 4. Assert external outcome
    expect(phoneCodeRequested).toBe(true);
    expect(result.status).toBe('ACTIVE');
    expect(result.hasSession).toBe(true);
    expect(result.districtId).toBe(districtId);
    expect(result.phoneNumber).toBe(phoneNumber);

    // 5. Assert MTProto calls
    expect(mockAuth.sendCodeCalls).toHaveLength(1);
    expect(mockAuth.sendCodeCalls[0]).toEqual({
      phoneNumber,
      apiId,
      apiHash,
    });
    expect(mockAuth.signInCalls).toHaveLength(1);
    expect(mockAuth.signInCalls[0]).toEqual({
      phoneNumber,
      phoneCodeHash: 'phone_code_hash_xyz_1',
      phoneCode: '54321',
    });

    // 6. Verify session string is encrypted in DB and decryptable via getDecryptedUserbotSession
    const decrypted = await getDecryptedUserbotSession(db, districtId);
    expect(decrypted).not.toBeNull();
    expect(decrypted?.status).toBe('ACTIVE');
    expect(decrypted?.sessionString).toBe(expectedSessionString);

    // Verify raw DB columns have non-null encryption IV, Tag, and cipher
    const [rawRow] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);
    expect(rawRow).toBeDefined();
    expect(rawRow?.status).toBe('ACTIVE');
    expect(rawRow?.sessionEncrypted).toBeTruthy();
    expect(rawRow?.sessionIv).toBeTruthy();
    expect(rawRow?.sessionTag).toBeTruthy();
    expect(rawRow?.sessionKeyVersion).toBe('v1');
    expect(rawRow?.lastSeenAt).toBeInstanceOf(Date);

    // 7. Verify audit event was written
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.districtId, districtId),
          eq(auditEvents.action, 'USERBOT_SESSION_ACTIVATED'),
        ),
      )
      .limit(1);

    expect(audit).toBeDefined();
    expect(audit?.actorId).toBe('admin_tester_po');
    expect(audit?.actorRole).toBe('PRODUCT_OWNER');
    expect(audit?.metadata).toMatchObject({
      sessionId: rawRow?.id,
      status: 'ACTIVE',
    });
  });

  it('Test 2: Successful login flow with 2FA password requirement', async () => {
    const districtId = await createTestDistrict('Bootstrap2FA');
    const phoneNumber = '+998902223344';
    const apiId = '30502020';
    const apiHash = 'mock_api_hash_2fa';
    const expected2FASession = '1BJWNg...sessionWithTwoFactorAuthPass123...';
    const expectedPassword = 'super_secure_2fa_password_xyz!';

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber,
      apiId,
      apiHash,
    });

    const mockAuth = new MockUserbotAuthClient();
    mockAuth.sendCodeResult = { phoneCodeHash: 'phone_code_hash_2fa' };
    mockAuth.signInResult = { requiresPassword: true };
    mockAuth.signInWithPasswordResult = { sessionString: expected2FASession };

    let passwordRequested = false;

    const result = await bootstrapUserbotSession(db, {
      districtId,
      getPhoneCode: async () => '99887',
      getPassword: async () => {
        passwordRequested = true;
        return expectedPassword;
      },
      authClient: mockAuth,
      actorId: 'admin_2fa_user',
    });

    expect(passwordRequested).toBe(true);
    expect(result.status).toBe('ACTIVE');
    expect(result.hasSession).toBe(true);

    expect(mockAuth.signInWithPasswordCalls).toHaveLength(1);
    expect(mockAuth.signInWithPasswordCalls[0]).toEqual({
      password: expectedPassword,
    });

    const decrypted = await getDecryptedUserbotSession(db, districtId);
    expect(decrypted?.status).toBe('ACTIVE');
    expect(decrypted?.sessionString).toBe(expected2FASession);
  });

  it('Test 3: Failed login (PHONE_CODE_INVALID) throws clear error and leaves status as PENDING', async () => {
    const districtId = await createTestDistrict('BootstrapInvalidCode');
    const phoneNumber = '+998903334455';
    const apiId = '40603030';
    const apiHash = 'mock_api_hash_invalid_code';

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber,
      apiId,
      apiHash,
    });

    const mockAuth = new MockUserbotAuthClient();
    mockAuth.sendCodeResult = { phoneCodeHash: 'code_hash_fail' };
    mockAuth.signInError = new InvalidPhoneCodeError('PHONE_CODE_INVALID: Entered confirmation code is wrong');

    await expect(
      bootstrapUserbotSession(db, {
        districtId,
        getPhoneCode: async () => '00000',
        authClient: mockAuth,
      }),
    ).rejects.toThrow(InvalidPhoneCodeError);

    // Verify session in DB remains PENDING and unencrypted
    const [row] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    expect(row).toBeDefined();
    expect(row?.status).toBe('PENDING');
    expect(row?.sessionEncrypted).toBeNull();

    // Verify no activation audit record was generated
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.districtId, districtId),
          eq(auditEvents.action, 'USERBOT_SESSION_ACTIVATED'),
        ),
      )
      .limit(1);
    expect(audit).toBeUndefined();
  });

  it('Test 4: Banned phone (PHONE_NUMBER_BANNED) surfaces clear error and leaves status as PENDING (unchanged)', async () => {
    const districtId = await createTestDistrict('BootstrapBanned');
    const phoneNumber = '+998904445566';
    const apiId = '50704040';
    const apiHash = 'mock_api_hash_banned';

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber,
      apiId,
      apiHash,
    });

    const mockAuth = new MockUserbotAuthClient();
    mockAuth.sendCodeError = new PhoneNumberBannedError(phoneNumber);

    await expect(
      bootstrapUserbotSession(db, {
        districtId,
        getPhoneCode: async () => '12345',
        authClient: mockAuth,
      }),
    ).rejects.toThrow(PhoneNumberBannedError);

    // Verify session remains PENDING (status unchanged)
    const [row] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    expect(row?.status).toBe('PENDING');
    expect(row?.sessionEncrypted).toBeNull();
  });

  it('Test 5: Missing district session throws DistrictNotFoundError or UserbotSessionNotFoundError', async () => {
    const mockAuth = new MockUserbotAuthClient();

    // 5a. Non-existent district -> DistrictNotFoundError
    const nonExistentDistrictId = `dist_${crypto.randomUUID()}`;
    await expect(
      bootstrapUserbotSession(db, {
        districtId: nonExistentDistrictId,
        getPhoneCode: async () => '12345',
        authClient: mockAuth,
      }),
    ).rejects.toThrow(DistrictNotFoundError);

    // 5b. Existing district with no userbot session -> UserbotSessionNotFoundError
    const validDistrictId = await createTestDistrict('NoSessionDist');
    await expect(
      bootstrapUserbotSession(db, {
        districtId: validDistrictId,
        getPhoneCode: async () => '12345',
        authClient: mockAuth,
      }),
    ).rejects.toThrow(UserbotSessionNotFoundError);
  });

  it('Test 6: Bootstrap CLI re-run on a DISABLED session is refused and leaves session status unchanged as DISABLED in DB', async () => {
    const districtId = await createTestDistrict('BootstrapDisabled');
    const phoneNumber = '+998905557788';
    const apiId = '60805050';
    const apiHash = 'mock_api_hash_disabled';

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber,
      apiId,
      apiHash,
    });

    // Disable the session
    await disableDistrictUserbotSession(db, districtId);

    const sessionBefore = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    expect(sessionBefore[0]?.status).toBe('DISABLED');

    const mockAuth = new MockUserbotAuthClient();

    // Re-run bootstrap CLI on DISABLED session
    await expect(
      bootstrapUserbotSession(db, {
        districtId,
        getPhoneCode: async () => '12345',
        authClient: mockAuth,
      }),
    ).rejects.toThrow(UserbotSessionDisabledError);

    // Verify session remains DISABLED and no MTProto calls were made
    const [row] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    expect(row?.status).toBe('DISABLED');
    expect(row?.sessionEncrypted).toBeNull();
    expect(mockAuth.sendCodeCalls).toHaveLength(0);
  });

  it('Test 7: Forced audit failure during bootstrapDistrictUserbotSession triggers atomic transaction rollback, leaving session status as PENDING', async () => {
    const districtId = await createTestDistrict('BootstrapAuditRollback');
    const phoneNumber = '+998906668899';
    const apiId = '70906060';
    const apiHash = 'mock_api_hash_audit_fail';

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber,
      apiId,
      apiHash,
    });

    const mockAuth = new MockUserbotAuthClient();
    mockAuth.sendCodeResult = { phoneCodeHash: 'code_hash_rollback' };
    mockAuth.signInResult = { sessionString: 'valid_session_string_rollback' };

    // Force audit failure by spying on recordAuditEvent
    const auditSpy = vi.spyOn(auditService, 'recordAuditEvent').mockImplementationOnce(async () => {
      throw new Error('Forced audit database write failure');
    });

    try {
      await expect(
        bootstrapUserbotSession(db, {
          districtId,
          getPhoneCode: async () => '12345',
          authClient: mockAuth,
        }),
      ).rejects.toThrow('Forced audit database write failure');

      // Verify transaction rolled back: session remains PENDING in DB, not ACTIVE
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(row).toBeDefined();
      expect(row?.status).toBe('PENDING');
      expect(row?.sessionEncrypted).toBeNull();
    } finally {
      auditSpy.mockRestore();
    }
  });
});

