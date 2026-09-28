import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDbPool, createDbClient, DbClient } from '../src/adapters/db/client.js';
import {
  districts,
  districtTelegramUserbotSessions,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import {
  createDistrictUserbotSession,
  getDistrictUserbotSession,
  getDecryptedUserbotSession,
  disableDistrictUserbotSession,
  enableDistrictUserbotSession,
  updateUserbotSessionStatus,
  ConflictError,
  SessionBannedError,
  UserbotSessionNotFoundError,
} from '../src/modules/userbot-session/index.js';
import { DistrictNotFoundError } from '../src/modules/districts/districts-service.js';

describe('District Userbot Session Record & Kill Switch Integration Tests (Ticket 04)', () => {
  let pool: pg.Pool;
  let db: DbClient;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  // Helper to create a test district
  async function createTestDistrict(namePrefix: string = 'UserbotTestDist'): Promise<string> {
    const districtId = `dist_${crypto.randomUUID()}`;
    await db.insert(districts).values({
      id: districtId,
      name: `${namePrefix}_${crypto.randomUUID().slice(0, 8)}`,
      region: 'Tashkent',
      status: 'ACTIVE',
    });
    return districtId;
  }

  it('Test 1: District can have at most one session; second create fails with ConflictError', async () => {
    const districtId = await createTestDistrict('UniqueSession');

    // 1st create succeeds
    const session1 = await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998901112233',
      apiId: '12345678',
      apiHash: 'hash_abc_123',
      actorId: 'po_admin_1',
      actorRole: 'PRODUCT_OWNER',
    });
    expect(session1).toBeDefined();
    expect(session1.districtId).toBe(districtId);
    expect(session1.phoneNumber).toBe('+998901112233');

    // 2nd create for the same district fails with ConflictError
    await expect(
      createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998909998877',
        apiId: '87654321',
        apiHash: 'hash_xyz_789',
        actorId: 'po_admin_1',
        actorRole: 'PRODUCT_OWNER',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('Test 2: Initial status is PENDING, transitions to ACTIVE, DISABLED, and back to ACTIVE', async () => {
    const districtId = await createTestDistrict('StatusTransitions');
    const rawSession = '1BJWNg...dummyTelegramSessionString...';

    // 1. Initial creation with session string -> status is PENDING
    const created = await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998902223344',
      apiId: '22334455',
      sessionString: rawSession,
    });
    expect(created.status).toBe('PENDING');

    // 2. Worker/watchdog verifies session -> status transitions to ACTIVE
    const activated = await updateUserbotSessionStatus(db, districtId, {
      status: 'ACTIVE',
      lastSeenAt: new Date(),
    });
    expect(activated.status).toBe('ACTIVE');
    expect(activated.lastSeenAt).toBeInstanceOf(Date);

    // 3. Kill switch triggered -> transitions to DISABLED immediately
    const disabled = await disableDistrictUserbotSession(db, districtId);
    expect(disabled.status).toBe('DISABLED');

    // 4. Re-enabled -> transitions back to ACTIVE (since session string is present)
    const reEnabled = await enableDistrictUserbotSession(db, districtId);
    expect(reEnabled.status).toBe('ACTIVE');
  });

  it('Test 3: Encrypted session storage never leaks clear session in getDistrictUserbotSession, but decrypts accurately in getDecryptedUserbotSession', async () => {
    const districtId = await createTestDistrict('CryptoRoundTrip');
    const secretSessionString = '1ApW_Telegram_Strictly_Secret_Session_Key_String_987654321!';

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998903334455',
      apiId: '33445566',
      apiHash: 'test_hash_3344',
      sessionString: secretSessionString,
    });

    // Verify public view does not leak encrypted or plaintext secrets
    const publicSession = await getDistrictUserbotSession(db, districtId);
    expect(publicSession).toBeDefined();
    expect(publicSession!.districtId).toBe(districtId);
    expect(publicSession!.hasSession).toBe(true);
    expect((publicSession as any).sessionEncrypted).toBeUndefined();
    expect((publicSession as any).sessionIv).toBeUndefined();
    expect((publicSession as any).sessionTag).toBeUndefined();
    expect((publicSession as any).sessionKeyVersion).toBeUndefined();
    expect((publicSession as any).sessionString).toBeUndefined();
    expect((publicSession as any).apiHash).toBeUndefined();

    // Verify raw DB row stores ciphertext, not plaintext
    const [rawRow] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    expect(rawRow).toBeDefined();
    expect(rawRow!.sessionEncrypted).not.toBe(secretSessionString);
    expect(rawRow!.sessionIv).toBeDefined();
    expect(rawRow!.sessionTag).toBeDefined();
    expect(rawRow!.sessionKeyVersion).toBe('v1');

    // Verify internal decryptor recovers exact plaintext
    const decrypted = await getDecryptedUserbotSession(db, districtId);
    expect(decrypted).toBeDefined();
    expect(decrypted!.sessionString).toBe(secretSessionString);
    expect(decrypted!.phoneNumber).toBe('+998903334455');
    expect(decrypted!.apiId).toBe('33445566');
    expect(decrypted!.apiHash).toBe('test_hash_3344');
  });

  it('Test 4: Disabling takes effect immediately (kill switch)', async () => {
    const districtId = await createTestDistrict('KillSwitch');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998904445566',
      apiId: '44556677',
      sessionString: 'session_kill_switch_test',
    });

    // Activate session
    await updateUserbotSessionStatus(db, districtId, { status: 'ACTIVE' });

    const beforeDisable = await getDistrictUserbotSession(db, districtId);
    expect(beforeDisable?.status).toBe('ACTIVE');

    // Trigger immediate kill switch
    const disabled = await disableDistrictUserbotSession(db, districtId, {
      actorId: 'admin_security_ops',
      actorRole: 'PRODUCT_OWNER',
    });
    expect(disabled.status).toBe('DISABLED');

    // Direct DB verification
    const [dbRow] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    expect(dbRow).toBeDefined();
    expect(dbRow!.status).toBe('DISABLED');

    // Verification through getDistrictUserbotSession
    const afterDisable = await getDistrictUserbotSession(db, districtId);
    expect(afterDisable?.status).toBe('DISABLED');
  });

  it('Test 5: Re-enabling a BANNED session is rejected', async () => {
    const districtId = await createTestDistrict('BannedRejection');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998905556677',
      apiId: '55667788',
      sessionString: 'session_banned_test',
    });

    // Worker detects Telegram 401 / ban and sets status to BANNED
    await updateUserbotSessionStatus(db, districtId, { status: 'BANNED' });

    const bannedSession = await getDistrictUserbotSession(db, districtId);
    expect(bannedSession?.status).toBe('BANNED');

    // Attempting to re-enable must be rejected
    await expect(
      enableDistrictUserbotSession(db, districtId, {
        actorId: 'po_user',
        actorRole: 'PRODUCT_OWNER',
      }),
    ).rejects.toThrow(SessionBannedError);

    // Verify status remains BANNED
    const sessionStillBanned = await getDistrictUserbotSession(db, districtId);
    expect(sessionStillBanned?.status).toBe('BANNED');
  });

  it('Test 6: Audit records are written for create, disable, and enable actions', async () => {
    const districtId = await createTestDistrict('AuditTracking');
    const actorId = `actor_${crypto.randomUUID()}`;
    const actorRole = 'PRODUCT_OWNER';

    // 1. Create session -> emits USERBOT_SESSION_CREATED
    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998906667788',
      apiId: '66778899',
      sessionString: 'test_audit_session_data',
      actorId,
      actorRole,
    });

    const createAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.districtId, districtId));

    const createEvent = createAudits.find((e) => e.action === 'USERBOT_SESSION_CREATED');
    expect(createEvent).toBeDefined();
    expect(createEvent!.actorId).toBe(actorId);
    expect(createEvent!.actorRole).toBe(actorRole);
    expect(createEvent!.metadata).toMatchObject({
      phoneNumber: '+998906667788',
      hasSession: true,
    });

    // 2. Disable session -> emits USERBOT_SESSION_DISABLED
    await disableDistrictUserbotSession(db, districtId, {
      actorId,
      actorRole,
    });

    const disableAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.districtId, districtId));

    const disableEvent = disableAudits.find((e) => e.action === 'USERBOT_SESSION_DISABLED');
    expect(disableEvent).toBeDefined();
    expect(disableEvent!.actorId).toBe(actorId);
    expect(disableEvent!.actorRole).toBe(actorRole);
    expect(disableEvent!.metadata).toMatchObject({
      previousStatus: 'PENDING',
    });

    // 3. Enable session -> emits USERBOT_SESSION_ENABLED
    await enableDistrictUserbotSession(db, districtId, {
      actorId,
      actorRole,
    });

    const enableAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.districtId, districtId));

    const enableEvent = enableAudits.find((e) => e.action === 'USERBOT_SESSION_ENABLED');
    expect(enableEvent).toBeDefined();
    expect(enableEvent!.actorId).toBe(actorId);
    expect(enableEvent!.actorRole).toBe(actorRole);
    expect(enableEvent!.metadata).toMatchObject({
      previousStatus: 'DISABLED',
      newStatus: 'ACTIVE',
    });
  });

  it('disableDistrictUserbotSession on a BANNED session is refused and subsequent enableDistrictUserbotSession is also refused (BANNED -> disable -> enable stays BANNED)', async () => {
    const districtId = await createTestDistrict('BannedRefusal');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998905556699',
      apiId: '55667799',
      sessionString: 'session_banned_cycle_test',
    });

    // Worker sets status to BANNED
    await updateUserbotSessionStatus(db, districtId, { status: 'BANNED' });

    const bannedSession = await getDistrictUserbotSession(db, districtId);
    expect(bannedSession?.status).toBe('BANNED');

    // 1. disableDistrictUserbotSession on BANNED is refused
    await expect(
      disableDistrictUserbotSession(db, districtId, {
        actorId: 'po_user',
        actorRole: 'PRODUCT_OWNER',
      }),
    ).rejects.toThrow(SessionBannedError);

    // Status remains BANNED
    const sessionAfterDisable = await getDistrictUserbotSession(db, districtId);
    expect(sessionAfterDisable?.status).toBe('BANNED');

    // 2. Subsequent enableDistrictUserbotSession is also refused
    await expect(
      enableDistrictUserbotSession(db, districtId, {
        actorId: 'po_user',
        actorRole: 'PRODUCT_OWNER',
      }),
    ).rejects.toThrow(SessionBannedError);

    // Status stays BANNED
    const sessionAfterEnable = await getDistrictUserbotSession(db, districtId);
    expect(sessionAfterEnable?.status).toBe('BANNED');
  });

  it('updateUserbotSessionStatus writes a USERBOT_SESSION_STATUS_UPDATED audit record with mutation metadata verified in auditEvents', async () => {
    const districtId = await createTestDistrict('AuditStatusUpdate');
    const actorId = `actor_${crypto.randomUUID()}`;
    const actorRole = 'PRODUCT_OWNER';
    const testDate = new Date('2026-09-19T12:30:00.000Z');

    // Initial session (PENDING)
    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998901239988',
      apiId: '99887766',
    });

    // Update session status, lastSeenAt, and sessionString
    await updateUserbotSessionStatus(db, districtId, {
      status: 'ACTIVE',
      lastSeenAt: testDate,
      sessionString: 'valid_session_string_123',
      actorId,
      actorRole,
    });

    const statusAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.districtId, districtId));

    const statusEvent = statusAudits.find((e) => e.action === 'USERBOT_SESSION_STATUS_UPDATED');
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.actorId).toBe(actorId);
    expect(statusEvent!.actorRole).toBe(actorRole);
    expect(statusEvent!.metadata).toMatchObject({
      previousStatus: 'PENDING',
      newStatus: 'ACTIVE',
      lastSeenAt: testDate.toISOString(),
      hasSessionString: true,
    });

    // Clear session string to verify secretsCleared metadata
    await updateUserbotSessionStatus(db, districtId, {
      sessionString: '',
      actorId,
      actorRole,
    });

    const updatedAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.districtId, districtId));

    const clearEvent = updatedAudits
      .filter((e) => e.action === 'USERBOT_SESSION_STATUS_UPDATED')
      .pop();

    expect(clearEvent).toBeDefined();
    expect(clearEvent!.metadata).toMatchObject({
      previousStatus: 'ACTIVE',
      newStatus: 'ACTIVE',
      hasSessionString: false,
      secretsCleared: true,
    });
  });

  describe('Edge cases and Schema Constraints', () => {
    it('rejects session creation if district does not exist with DistrictNotFoundError', async () => {
      const nonExistentDistrictId = `dist_nonexistent_${crypto.randomUUID()}`;

      await expect(
        createDistrictUserbotSession(db, {
          districtId: nonExistentDistrictId,
          phoneNumber: '+998901234567',
          apiId: '99999',
        }),
      ).rejects.toThrow(DistrictNotFoundError);
    });

    it('enables session to PENDING when session string has not been provisioned yet', async () => {
      const districtId = await createTestDistrict('NoSessionString');

      // Create session without session string
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998907778899',
        apiId: '77889900',
      });

      // Disable it
      await disableDistrictUserbotSession(db, districtId);

      // Re-enabling without session secret restores to PENDING, not ACTIVE
      const reEnabled = await enableDistrictUserbotSession(db, districtId);
      expect(reEnabled.status).toBe('PENDING');
      expect(reEnabled.hasSession).toBe(false);
    });

    it('cascades deletion of userbot session when district is deleted', async () => {
      const districtId = await createTestDistrict('CascadeDistrict');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998908889900',
        apiId: '88990011',
      });

      // Delete district
      await db.delete(districts).where(eq(districts.id, districtId));

      // Userbot session must be cascade deleted
      const session = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      expect(session).toHaveLength(0);
    });

    it('throws UserbotSessionNotFoundError when disabling or enabling non-existent session', async () => {
      const districtId = await createTestDistrict('NoSessionExists');

      await expect(
        disableDistrictUserbotSession(db, districtId),
      ).rejects.toThrow(UserbotSessionNotFoundError);

      await expect(
        enableDistrictUserbotSession(db, districtId),
      ).rejects.toThrow(UserbotSessionNotFoundError);

      await expect(
        updateUserbotSessionStatus(db, districtId, { status: 'ACTIVE' }),
      ).rejects.toThrow(UserbotSessionNotFoundError);
    });
  });
});
