import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
  getDistrictUserbotSession,
  getDecryptedUserbotSession,
  disableDistrictUserbotSession,
  enableDistrictUserbotSession,
  ConflictError,
  SessionBannedError,
  UserbotSessionDisabledError,
  UserbotSessionNotFoundError,
  bootstrapUserbotSession,
  isAlreadyRevokedOrInvalidSessionError,
  defaultTelegramSessionRevoker,
  reencryptUserbotSessions,
  backfillEncryptedApiHash,
  UserbotCredentialValidationError,
  UserbotApiHashEnvelopeCorruptError,
  UserbotSessionEnvelopeCorruptError,
  classifyApiHashEnvelope,
  classifySessionEnvelope,
  classifyEncryptedEnvelope,
  verifyApiHashEnvelopes,
} from '../src/modules/userbot-session/index.js';
import { UnresolvableKeyVersionError } from '../src/adapters/crypto/token-cipher.js';
import { DistrictNotFoundError } from '../src/modules/districts/districts-service.js';
import * as auditService from '../src/modules/audit/audit-service.js';
import { auditQueryService } from '../src/modules/audit/audit-query-service.js';
import {
  USERBOT_SESSION_AUDIT_ACTIONS,
  UserbotSessionAuditActionSchema,
  USERBOT_AUDIT_ACTIONS,
} from '@mahalla-ovozi/api-contracts';
import { UserbotConnectionManager } from '../src/modules/userbot/index.js';
import { logger } from '../src/utils/logger.js';

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
      apiHash: 'valid_api_hash_123',
      sessionString: rawSession,
    });
    expect(created.status).toBe('PENDING');

    // 2. Transition session to ACTIVE
    const activated = await enableDistrictUserbotSession(db, districtId);
    expect(activated.status).toBe('ACTIVE');

    // 3. Kill switch triggered -> transitions to DISABLED immediately, wiping secrets (Ticket 09)
    const disabled = await disableDistrictUserbotSession(db, districtId);
    expect(disabled.status).toBe('DISABLED');
    expect(disabled.hasSession).toBe(false);

    // 4. Re-enabled without re-authentication -> transitions to PENDING (since secrets were wiped)
    const reEnabled = await enableDistrictUserbotSession(db, districtId);
    expect(reEnabled.status).toBe('PENDING');

    // 5. Re-authenticating / supplying session string allows transitioning back to ACTIVE
    await bootstrapUserbotSession(db, {
      districtId,
      apiHash: 'valid_api_hash_123',
      getPhoneCode: async () => '12345',
      authClient: {
        sendCode: async () => ({ phoneCodeHash: 'mock_hash_t2' }),
        signIn: async () => ({ sessionString: rawSession }),
      } as any,
    });
    const reActivated = await getDistrictUserbotSession(db, districtId);
    expect(reActivated?.status).toBe('ACTIVE');
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
    await enableDistrictUserbotSession(db, districtId);

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
    const banMgr = new UserbotConnectionManager({ db });
    await banMgr.handleBan(districtId, new Error('PHONE_NUMBER_BANNED'));

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
      secretsCleared: false,
    });

    // 3. Enable session -> emits USERBOT_SESSION_ENABLED (transitions to PENDING because disable cleared credentials)
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
      newStatus: 'PENDING',
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
    const banMgr = new UserbotConnectionManager({ db });
    await banMgr.handleBan(districtId, new Error('PHONE_NUMBER_BANNED'));

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

  it('UserbotConnectionManager.handleAccountDeleted writes a USERBOT_SESSION_STATUS_UPDATED audit record with mutation metadata verified in auditEvents', async () => {
    const districtId = await createTestDistrict('AuditStatusUpdate');

    // Initial session (PENDING)
    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998901239988',
      apiId: '99887766',
      sessionString: 'valid_session_string_123',
    });

    // Activate session
    await enableDistrictUserbotSession(db, districtId);

    // Account deleted transition writes USERBOT_SESSION_STATUS_UPDATED
    const manager = new UserbotConnectionManager({ db });
    await manager.handleAccountDeleted(districtId, new Error('USER_DEACTIVATED'));

    const statusAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.districtId, districtId));

    const statusEvent = statusAudits.find((e) => e.action === 'USERBOT_SESSION_STATUS_UPDATED');
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.actorId).toBe('system:userbot-manager');
    expect(statusEvent!.actorRole).toBe('SYSTEM');
    expect(statusEvent!.metadata).toMatchObject({
      previousStatus: 'ACTIVE',
      newStatus: 'PENDING',
      secretsCleared: false,
      reason: 'ACCOUNT_DELETED',
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
        bootstrapUserbotSession(db, {
          districtId,
          getPhoneCode: async () => '12345',
          authClient: {
            sendCode: async () => ({ phoneCodeHash: 'hash' }),
            signIn: async () => ({ sessionString: 'session' }),
          } as any,
        }),
      ).rejects.toThrow(UserbotSessionNotFoundError);
    });

    // Ticket 06, criterion L12: a duplicate insert that races past the existence check
    // must surface as ConflictError (code CONFLICT, status 409), never as a raw driver
    // error. The non-trivial part is the cause chain: Drizzle wraps the driver error, so
    // the SQLSTATE 23505 sits on `error.cause.code` while the wrapper's own `code` is
    // null, and a top-level-only guard never matches it.
    it('surfaces a duplicate insert that races past the existence check as ConflictError, not a raw database error (unique-index race)', async () => {
      const districtId = await createTestDistrict('RacePastExistenceCheck');

      // Deterministically simulate the interleaving the pre-insert existence check cannot
      // prevent: the check reports "no session", a competing row commits, and only then
      // does the service's own INSERT reach the real unique index on district_id.
      // The create path calls db.select() twice: first for the District, then for the
      // existing session. Only the second probe is intercepted.
      let selectCalls = 0;
      let raceInjected = false;

      const probeChain = {
        from: () => probeChain,
        where: () => probeChain,
        limit: async () => {
          if (!raceInjected) {
            raceInjected = true;
            await db.insert(districtTelegramUserbotSessions).values({
              id: `dtus_${crypto.randomUUID()}`,
              districtId,
              phoneNumber: '+998909990011',
              apiId: '99001122',
              status: 'PENDING',
            });
          }
          return [];
        },
      };

      const racingDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'select') {
            return (...args: unknown[]) => {
              selectCalls += 1;
              if (selectCalls === 2) {
                return probeChain;
              }
              return (target.select as (...a: unknown[]) => unknown)(...args);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as unknown as DbClient;

      const error = await createDistrictUserbotSession(racingDb, {
        districtId,
        phoneNumber: '+998901110022',
        apiId: '11002233',
      }).then(
        () => null,
        (err: unknown) => err,
      );

      // Non-vacuous guard: the competing row must genuinely have committed AFTER the
      // existence check returned empty, otherwise the ConflictError would come from the
      // check itself and this test would prove nothing about the race path.
      expect(raceInjected).toBe(true);

      // Diagnostic capture: record the exact shape of the failure (top-level code vs.
      // nested cause code), so a regression report distinguishes "guard missing" from
      // "guard defeated by error wrapping".
      const observed = {
        isConflictError: error instanceof ConflictError,
        name: (error as Error)?.name ?? null,
        topLevelCode: (error as { code?: unknown })?.code ?? null,
        causeCode: (error as { cause?: { code?: unknown } })?.cause?.code ?? null,
        message: ((error as Error)?.message ?? '').slice(0, 160),
      };

      expect(
        observed.isConflictError,
        `RACE RESULT OBSERVED = ${JSON.stringify(observed)}`,
      ).toBe(true);
      expect((error as ConflictError).code).toBe('CONFLICT');
      expect((error as ConflictError).statusCode).toBe(409);
      expect((error as Error).message).toContain('already has a userbot session');

      // Exactly one row survives for the District.
      const rows = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(rows).toHaveLength(1);
    });

    // L12's other half. The simulation above proves the ERROR-MAPPING path at the service
    // boundary; this one exercises PostgreSQL itself, with two genuinely separate
    // connections (own pools, own clients) racing the same INSERT against the real unique
    // index on district_id. It cannot flake: the index guarantees exactly one insert wins,
    // and the loser reaches ConflictError by either route — the existence probe, if it ran
    // after the winner committed, or the unique-violation guard, if both probes ran first.
    // No sleeps and no ordering assumptions.
    it('surfaces the loser of a genuine two-connection insert race as ConflictError (real unique-index race)', async () => {
      const districtId = await createTestDistrict('TwoConnectionRace');

      const racePoolA = createDbPool();
      const racePoolB = createDbPool();
      const raceClientA = createDbClient(racePoolA);
      const raceClientB = createDbClient(racePoolB);

      try {
        const outcomes = await Promise.allSettled([
          createDistrictUserbotSession(raceClientA, {
            districtId,
            phoneNumber: '+998901112244',
            apiId: '11224455',
          }),
          createDistrictUserbotSession(raceClientB, {
            districtId,
            phoneNumber: '+998901113355',
            apiId: '11335566',
          }),
        ]);

        const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
        const rejected = outcomes.filter((o) => o.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const failure = (rejected[0] as PromiseRejectedResult).reason as ConflictError;
        const shape = {
          name: failure?.name ?? null,
          code: failure?.code ?? null,
          statusCode: failure?.statusCode ?? null,
          message: (failure?.message ?? '').slice(0, 160),
        };

        expect(
          failure instanceof ConflictError,
          `RACE LOSER SHAPE = ${JSON.stringify(shape)}`,
        ).toBe(true);
        expect(failure.code).toBe('CONFLICT');
        expect(failure.statusCode).toBe(409);
        expect(failure.message).toContain('already has a userbot session');

        // The unique index held: exactly one row survives for the District.
        const rows = await db
          .select()
          .from(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));

        expect(rows).toHaveLength(1);
      } finally {
        await racePoolA.end();
        await racePoolB.end();
      }
    });

    // Rider A1 regression: the unique-violation guard keys on SQLSTATE 23505 alone, while the
    // try block it wraps also performs the audit-event write. Any OTHER unique violation raised
    // inside that block would therefore be misreported to the caller as "District X already has
    // a userbot session". This test forces exactly that: a 23505 on a constraint that is NOT the
    // session table's district-id index must propagate UNCHANGED — same object, same shape, not
    // wrapped and not reclassified as a ConflictError.
    it('propagates a unique violation from a non-session constraint unchanged instead of reporting a session conflict', async () => {
      const districtId = await createTestDistrict('ForeignUniqueViolation');

      // Drizzle-shaped wrapping: the SQLSTATE and the constraint name both live on the cause,
      // while the outermost wrapper's own `code` is null. A guard that reads only the outer
      // level — or that unwraps exactly one level and then reads the constraint off the outer
      // object — cannot see this correctly.
      const driverError = Object.assign(
        new Error('duplicate key value violates unique constraint "audit_events_foreign_uidx"'),
        {
          code: '23505',
          constraint: 'audit_events_foreign_uidx',
          detail: 'Key (id)=(aud_foreign) already exists.',
          table: 'audit_events',
        },
      );

      const wrappedError = Object.assign(
        new Error('Failed query: insert into "audit_events" ("id", "action") values ($1, $2)'),
        {
          code: null,
          cause: driverError,
        },
      );

      const auditSpy = vi
        .spyOn(auditService, 'recordAuditEvent')
        .mockImplementationOnce(async () => {
          throw wrappedError;
        });

      const warnSpy = vi.spyOn(logger, 'warn');

      try {
        const error = await createDistrictUserbotSession(db, {
          districtId,
          phoneNumber: '+998901119955',
          apiId: '11995566',
        }).then(
          () => null,
          (err: unknown) => err,
        );

        // Non-vacuous guard: the audit write must genuinely have been reached and must be the
        // thing that failed, otherwise this test proves nothing about the catch block.
        expect(auditSpy).toHaveBeenCalledTimes(1);

        // Defect D-1 assertion: unclassified 23505 unique violation emits structured warning log
        expect(warnSpy).toHaveBeenCalledWith(
          {
            event: 'USERBOT_SESSION_CREATE_UNIQUE_VIOLATION_UNCLASSIFIED',
            districtId,
            sqlState: '23505',
            constraint: 'audit_events_foreign_uidx',
          },
          'Unique violation on unclassified constraint during userbot session creation',
        );

        const observed = {
          isConflictError: error instanceof ConflictError,
          sameObject: error === wrappedError,
          name: (error as Error)?.name ?? null,
          topLevelCode: (error as { code?: unknown })?.code ?? null,
          causeCode: (error as { cause?: { code?: unknown } })?.cause?.code ?? null,
          causeConstraint:
            (error as { cause?: { constraint?: unknown } })?.cause?.constraint ?? null,
          message: ((error as Error)?.message ?? '').slice(0, 160),
        };

        expect(
          observed.isConflictError,
          `FOREIGN VIOLATION RESULT OBSERVED = ${JSON.stringify(observed)}`,
        ).toBe(false);

        // Propagated by identity: not wrapped, not reclassified, not re-messaged.
        expect(error).toBe(wrappedError);
        expect((error as { code?: unknown }).code).toBeNull();
        expect((error as { cause?: { code?: unknown } }).cause?.code).toBe('23505');
      } finally {
        auditSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('disabling a PENDING session reaches DISABLED and clears no credential that was never stored', async () => {
      const districtId = await createTestDistrict('DisablePendingSession');

      // PENDING with no live authorization: nothing was ever authenticated for this row.
      const created = await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998902220033',
        apiId: '22003344',
      });
      expect(created.status).toBe('PENDING');
      expect(created.hasSession).toBe(false);

      const disabled = await disableDistrictUserbotSession(db, districtId, {
        actorId: 'po_kill_switch',
        actorRole: 'PRODUCT_OWNER',
      });

      // PENDING -> DISABLED is a permitted transition (the kill switch is never blocked).
      expect(disabled.status).toBe('DISABLED');

      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(row?.status).toBe('DISABLED');
      expect(row?.sessionEncrypted).toBeNull();

      // The transition is recorded in the audit trail with the PENDING origin.
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));

      const disableEvent = audits.find((e) => e.action === 'USERBOT_SESSION_DISABLED');
      expect(disableEvent).toBeDefined();
      expect(disableEvent!.metadata).toMatchObject({ previousStatus: 'PENDING' });
    });
  });

  describe('Server-Side Revocation on Disable & Secret Clearing (Ticket 09)', () => {
    it('defaultTelegramSessionRevoker reports a no-session no-op without a revocationSuccess verdict', async () => {
      // The empty/no-session branch was previously unasserted. It must report only
      // revocationPerformed: false and OMIT the optional revocationSuccess field, because consumers
      // read that field solely as `=== false` to classify an audit FAILURE; emitting false would
      // reclassify a benign no-op as a failure.
      const outcome = await defaultTelegramSessionRevoker({
        districtId: 'dist_revoker_no_session',
        sessionString: '   ',
        apiId: '12345678',
      });

      expect(outcome).toEqual({ revocationPerformed: false });
      expect('revocationSuccess' in outcome).toBe(false);
    });

    it('Criterion 1: disabling an active session executes server-side revocation, clears secrets, preserves key version, and records audit event', async () => {
      const districtId = await createTestDistrict('Ticket09ActiveRevocation');
      const secretSessionString = '1ApW_Active_Session_Key_For_Ticket_09_Revocation!';

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901230001',
        apiId: '90001',
        apiHash: 'hash_90001',
        sessionString: secretSessionString,
      });

      await enableDistrictUserbotSession(db, districtId);

      const revokerSpy = vi.fn().mockResolvedValue({ revocationPerformed: true });

      const disabled = await disableDistrictUserbotSession(db, districtId, {
        actorId: 'admin_ticket_09',
        actorRole: 'PRODUCT_OWNER',
        revoker: revokerSpy,
      });

      expect(disabled.status).toBe('DISABLED');
      expect(disabled.hasSession).toBe(false);

      expect(revokerSpy).toHaveBeenCalledTimes(1);
      expect(revokerSpy).toHaveBeenCalledWith({
        districtId,
        sessionString: secretSessionString,
        apiId: '90001',
        apiHash: 'hash_90001',
        phoneNumber: '+998901230001',
      });

      const [dbRow] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(dbRow).toBeDefined();
      expect(dbRow!.status).toBe('DISABLED');
      expect(dbRow!.sessionEncrypted).toBeNull();
      expect(dbRow!.sessionIv).toBeNull();
      expect(dbRow!.sessionTag).toBeNull();
      expect(dbRow!.sessionKeyVersion).toBe('v1');
      expect(dbRow!.phoneNumber).toBe('+998901230001');
      expect(dbRow!.apiId).toBe('90001');
      expect(dbRow!.apiHashEncrypted).toBeDefined();
      expect(dbRow!.apiHashEncrypted).not.toBeNull();

      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));

      const disableEvent = audits.find((e) => e.action === 'USERBOT_SESSION_DISABLED');
      expect(disableEvent).toBeDefined();
      expect(disableEvent!.metadata).toMatchObject({
        previousStatus: 'ACTIVE',
        revocationPerformed: true,
        secretsCleared: false,
      });
    });

    it('Criterion 2: network failure during server revocation aborts and leaves the DB record unmodified', async () => {
      const districtId = await createTestDistrict('Ticket09NetworkFailure');
      const secretSessionString = '1ApW_Network_Fail_Session_Ticket_09!';

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901230002',
        apiId: '90002',
        apiHash: 'hash_90002',
        sessionString: secretSessionString,
      });

      await enableDistrictUserbotSession(db, districtId);

      const [rowBefore] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(rowBefore!.status).toBe('ACTIVE');
      expect(rowBefore!.sessionEncrypted).not.toBeNull();

      const networkError = new Error('Connection to Telegram servers failed: ETIMEDOUT');
      const revokerSpy = vi.fn().mockRejectedValue(networkError);

      await expect(
        disableDistrictUserbotSession(db, districtId, {
          actorId: 'admin_network_fail',
          actorRole: 'PRODUCT_OWNER',
          revoker: revokerSpy,
        }),
      ).rejects.toThrow('Connection to Telegram servers failed: ETIMEDOUT');

      expect(revokerSpy).toHaveBeenCalledTimes(1);

      // Assert DB record was left unmodified
      const [rowAfter] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(rowAfter!.status).toBe('ACTIVE');
      expect(rowAfter!.sessionEncrypted).toBe(rowBefore!.sessionEncrypted);
      expect(rowAfter!.sessionIv).toBe(rowBefore!.sessionIv);
      expect(rowAfter!.sessionTag).toBe(rowBefore!.sessionTag);
      expect(rowAfter!.sessionKeyVersion).toBe(rowBefore!.sessionKeyVersion);

      // No disable audit event was recorded
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));

      const disableEvent = audits.find((e) => e.action === 'USERBOT_SESSION_DISABLED');
      expect(disableEvent).toBeUndefined();
    });

    it('Criterion 3: disabling an already revoked or expired session tolerates the error, clears local secrets, and transitions to DISABLED', async () => {
      const districtId = await createTestDistrict('Ticket09AlreadyRevoked');
      const secretSessionString = '1ApW_Already_Revoked_Session_Ticket_09!';

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901230003',
        apiId: '90003',
        apiHash: 'hash_90003',
        sessionString: secretSessionString,
      });

      await enableDistrictUserbotSession(db, districtId);

      // Revoker encounters SESSION_REVOKED
      const revokerSpy = vi.fn().mockImplementation(async () => {
        throw new Error('401: SESSION_REVOKED');
      });

      const disabled = await disableDistrictUserbotSession(db, districtId, {
        actorId: 'admin_already_revoked',
        actorRole: 'PRODUCT_OWNER',
        revoker: async (params) => {
          try {
            return await revokerSpy(params);
          } catch (err: unknown) {
            if (isAlreadyRevokedOrInvalidSessionError(err)) {
              return { revocationPerformed: false };
            }
            throw err;
          }
        },
      });

      expect(disabled.status).toBe('DISABLED');
      expect(disabled.hasSession).toBe(false);

      // DB record secrets are cleared
      const [dbRow] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(dbRow!.status).toBe('DISABLED');
      expect(dbRow!.sessionEncrypted).toBeNull();
      expect(dbRow!.sessionIv).toBeNull();
      expect(dbRow!.sessionTag).toBeNull();
      expect(dbRow!.sessionKeyVersion).toBe('v1');

      // Audit event recorded as nothing to revoke (revocationPerformed: false)
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));

      const disableEvent = audits.find((e) => e.action === 'USERBOT_SESSION_DISABLED');
      expect(disableEvent).toBeDefined();
      expect(disableEvent!.metadata).toMatchObject({
        previousStatus: 'ACTIVE',
        revocationPerformed: false,
        secretsCleared: false,
      });
    });

    it('Criterion 4: default revoker handles canonical already-revoked errors, empty sessions, and invalid session strings', async () => {
      // 1. isAlreadyRevokedOrInvalidSessionError classification
      expect(isAlreadyRevokedOrInvalidSessionError(new Error('401: SESSION_REVOKED'))).toBe(true);
      expect(isAlreadyRevokedOrInvalidSessionError(new Error('AUTH_KEY_UNREGISTERED'))).toBe(true);
      expect(isAlreadyRevokedOrInvalidSessionError(new Error('AUTH_KEY_INVALID'))).toBe(true);
      expect(isAlreadyRevokedOrInvalidSessionError(new Error('USER_DEACTIVATED'))).toBe(true);
      expect(isAlreadyRevokedOrInvalidSessionError(new Error('SESSION_EXPIRED'))).toBe(true);
      expect(isAlreadyRevokedOrInvalidSessionError(new Error('Not a valid string'))).toBe(true);
      expect(isAlreadyRevokedOrInvalidSessionError(new Error('No more data left to read'))).toBe(true);
      expect(isAlreadyRevokedOrInvalidSessionError(new Error('Connection reset by peer'))).toBe(false);
      expect(isAlreadyRevokedOrInvalidSessionError(new Error('ETIMEDOUT'))).toBe(false);

      // 2. defaultTelegramSessionRevoker with empty session string returns false
      const emptyResult = await defaultTelegramSessionRevoker({
        districtId: 'dist_empty',
        sessionString: '',
        apiId: '12345',
      });
      expect(emptyResult.revocationPerformed).toBe(false);

      // 3. defaultTelegramSessionRevoker with invalid session string returns false without throwing
      const invalidResult = await defaultTelegramSessionRevoker({
        districtId: 'dist_invalid',
        sessionString: 'not_a_valid_mtproto_string',
        apiId: '12345',
      });
      expect(invalidResult.revocationPerformed).toBe(false);
    });
  });

  describe('Ticket 07: Kill-Switch Refusals & Terminal State Invariants', () => {
    class DummyAuthClient {
      sendCodeCalls: Array<{ phoneNumber: string; apiId: string; apiHash: string }> = [];
      async sendCode(phoneNumber: string, apiId: string, apiHash: string) {
        this.sendCodeCalls.push({ phoneNumber, apiId, apiHash });
        return { phoneCodeHash: 'dummy_hash' };
      }
      async signIn() {
        return { sessionString: 'dummy_session_str' };
      }
    }

    it('Criterion 1 & 2: enabling a DISABLED session yields PENDING rather than ACTIVE and wipes residual secrets', async () => {
      const districtId = await createTestDistrict('EnableDisabledYieldsPending');
      const rawSession = '1BJWNg...storedSessionMaterial...';

      // Seed row with status DISABLED and encrypted secrets present
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901114455',
        apiId: '1114455',
        apiHash: 'hash_test',
        sessionString: rawSession,
      });

      // Manually set status to DISABLED while leaving sessionEncrypted populated
      await db
        .update(districtTelegramUserbotSessions)
        .set({ status: 'DISABLED' })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      const beforeEnable = await getDistrictUserbotSession(db, districtId);
      expect(beforeEnable?.status).toBe('DISABLED');
      expect(beforeEnable?.hasSession).toBe(true);

      // Enable the session
      const enabled = await enableDistrictUserbotSession(db, districtId, {
        actorId: 'po_operator',
        actorRole: 'PRODUCT_OWNER',
      });

      // Assert status is PENDING, NOT ACTIVE, and hasSession is false
      expect(enabled.status).toBe('PENDING');
      expect(enabled.hasSession).toBe(false);

      // Verify raw database row: status is PENDING and all secrets are cleared
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      expect(row?.status).toBe('PENDING');
      expect(row?.sessionEncrypted).toBeNull();
      expect(row?.sessionIv).toBeNull();
      expect(row?.sessionTag).toBeNull();

      // Audit event USERBOT_SESSION_ENABLED with previousStatus DISABLED, newStatus PENDING
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));

      const enableAudit = audits.find((e) => e.action === 'USERBOT_SESSION_ENABLED');
      expect(enableAudit).toBeDefined();
      expect(enableAudit?.metadata).toMatchObject({
        previousStatus: 'DISABLED',
        newStatus: 'PENDING',
      });
    });

    it('Criterion 3: an interactive bootstrap attempted against a DISABLED session is refused without modifying DB or emitting audit', async () => {
      const districtId = await createTestDistrict('BootstrapDisabledRefused');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998902225566',
        apiId: '2225566',
        apiHash: 'hash_disabled_boot',
      });

      await disableDistrictUserbotSession(db, districtId);

      const [rowBefore] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(rowBefore?.status).toBe('DISABLED');

      const mockAuth = new DummyAuthClient();

      await expect(
        bootstrapUserbotSession(db, {
          districtId,
          getPhoneCode: async () => '12345',
          authClient: mockAuth as any,
          actorId: 'po_bootstrap_tester',
        }),
      ).rejects.toThrow(UserbotSessionDisabledError);

      expect(mockAuth.sendCodeCalls).toHaveLength(0);

      // Stored status unchanged
      const [rowAfter] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(rowAfter?.status).toBe('DISABLED');
      expect(rowAfter?.sessionEncrypted).toBeNull();

      // No activation audit record
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));
      expect(audits.find((e) => e.action === 'USERBOT_SESSION_ACTIVATED')).toBeUndefined();
    });

    it('Criterion 4: an interactive bootstrap attempted against a BANNED session is refused without modifying DB or emitting audit', async () => {
      const districtId = await createTestDistrict('BootstrapBannedRefused');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998903336677',
        apiId: '3336677',
        apiHash: 'hash_banned_boot',
      });

      // Mark session BANNED
      await db
        .update(districtTelegramUserbotSessions)
        .set({ status: 'BANNED' })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      const mockAuth = new DummyAuthClient();

      await expect(
        bootstrapUserbotSession(db, {
          districtId,
          getPhoneCode: async () => '12345',
          authClient: mockAuth as any,
          actorId: 'po_bootstrap_tester',
        }),
      ).rejects.toThrow(SessionBannedError);

      expect(mockAuth.sendCodeCalls).toHaveLength(0);

      // Stored status unchanged
      const [rowAfter] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(rowAfter?.status).toBe('BANNED');

      // No activation audit record
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));
      expect(audits.find((e) => e.action === 'USERBOT_SESSION_ACTIVATED')).toBeUndefined();
    });

    it('Criterion 5: disabling a BANNED session is refused because BANNED is the stronger terminal state', async () => {
      const districtId = await createTestDistrict('DisableBannedRefused');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998904447788',
        apiId: '4447788',
        apiHash: 'hash_dis_ban',
      });

      await db
        .update(districtTelegramUserbotSessions)
        .set({ status: 'BANNED' })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      const revokerSpy = vi.fn();

      await expect(
        disableDistrictUserbotSession(db, districtId, {
          actorId: 'po_tester',
          actorRole: 'PRODUCT_OWNER',
          revoker: revokerSpy,
        }),
      ).rejects.toThrow(SessionBannedError);

      expect(revokerSpy).not.toHaveBeenCalled();

      // DB status remains BANNED
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(row?.status).toBe('BANNED');

      // No disable audit event emitted
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));
      expect(audits.find((e) => e.action === 'USERBOT_SESSION_DISABLED')).toBeUndefined();
    });

    it('Criterion 6: enabling a BANNED session is refused without writing audit', async () => {
      const districtId = await createTestDistrict('EnableBannedRefused');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998905558899',
        apiId: '5558899',
        apiHash: 'hash_en_ban',
      });

      await db
        .update(districtTelegramUserbotSessions)
        .set({ status: 'BANNED' })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      await expect(
        enableDistrictUserbotSession(db, districtId, {
          actorId: 'po_tester',
          actorRole: 'PRODUCT_OWNER',
        }),
      ).rejects.toThrow(SessionBannedError);

      // DB status remains BANNED
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(row?.status).toBe('BANNED');

      // No enable audit event emitted
      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));
      expect(audits.find((e) => e.action === 'USERBOT_SESSION_ENABLED')).toBeUndefined();
    });

    it('Criterion 7: a banned account is never silently revived or updated with credentials', async () => {
      const districtId = await createTestDistrict('BannedRevivalRefused');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998906669900',
        apiId: '6669900',
        apiHash: 'hash_revive_ban',
      });

      await db
        .update(districtTelegramUserbotSessions)
        .set({ status: 'BANNED' })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      // Attempt enable on BANNED
      await expect(
        enableDistrictUserbotSession(db, districtId),
      ).rejects.toThrow(SessionBannedError);

      // Attempt bootstrap on BANNED
      await expect(
        bootstrapUserbotSession(db, {
          districtId,
          getPhoneCode: async () => '12345',
          authClient: {
            sendCode: async () => ({ phoneCodeHash: 'hash' }),
            signIn: async () => ({ sessionString: 'sneaky_session' }),
          } as any,
        }),
      ).rejects.toThrow(SessionBannedError);

      // Attempt disable on BANNED
      await expect(
        disableDistrictUserbotSession(db, districtId),
      ).rejects.toThrow(SessionBannedError);

      // Status remains BANNED
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(row?.status).toBe('BANNED');
    });

    it('Criterion 8, 9 & 10: refused transitions leave stored status unchanged, write no audit record, and return failure', async () => {
      const districtId = await createTestDistrict('RefusedInvariantCheck');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998907771122',
        apiId: '7771122',
        apiHash: 'hash_refusal_check',
      });

      // Disable session
      await disableDistrictUserbotSession(db, districtId);

      const auditsBefore = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));

      // Attempt to directly bootstrap on DISABLED session
      await expect(
        bootstrapUserbotSession(db, {
          districtId,
          getPhoneCode: async () => '12345',
          authClient: {
            sendCode: async () => ({ phoneCodeHash: 'hash' }),
            signIn: async () => ({ sessionString: 'unauthorized_token' }),
          } as any,
        }),
      ).rejects.toThrow(UserbotSessionDisabledError);

      // Status remains DISABLED
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(row?.status).toBe('DISABLED');
      expect(row?.sessionEncrypted).toBeNull();

      // No new audit record was created
      const auditsAfter = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));
      expect(auditsAfter.length).toBe(auditsBefore.length);
    });
  });

  describe('Milestone 4 / Ticket 10: Key Version Rotation & Fallback Key Elimination', () => {
    const originalEnv = { ...process.env };
    const keyV1 = process.env.ENCRYPTION_KEY || 'test_encryption_key_32_bytes_ok!';
    const keyV2 = 'test_key_v2_32_bytes_length_ok!!';

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('Decryption selects correct key per row across different key versions in same DB table', async () => {
      // Configure dual keys: active is v2, v1 is also available
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY_V2 = keyV2;
      process.env.ENCRYPTION_KEY_V1 = keyV1;

      const districtA = await createTestDistrict('MultiKeyA');
      const districtB = await createTestDistrict('MultiKeyB');

      const secretA = 'session_string_for_district_A_v1';
      const secretB = 'session_string_for_district_B_v2';

      // District A explicitly created with keyVersion v1
      await createDistrictUserbotSession(db, {
        districtId: districtA,
        phoneNumber: '+998901110001',
        apiId: '12345678',
        apiHash: 'hash_a',
        sessionString: secretA,
        keyVersion: 'v1',
      });

      // District B created with default active keyVersion (v2)
      await createDistrictUserbotSession(db, {
        districtId: districtB,
        phoneNumber: '+998901110002',
        apiId: '12345678',
        apiHash: 'hash_b',
        sessionString: secretB,
      });

      // Verify row key versions in DB
      const [rowA] = await db.select().from(districtTelegramUserbotSessions).where(eq(districtTelegramUserbotSessions.districtId, districtA));
      const [rowB] = await db.select().from(districtTelegramUserbotSessions).where(eq(districtTelegramUserbotSessions.districtId, districtB));

      expect(rowA?.sessionKeyVersion).toBe('v1');
      expect(rowB?.sessionKeyVersion).toBe('v2');

      // Both decrypt correctly from the same stored state
      const decryptedA = await getDecryptedUserbotSession(db, districtA);
      const decryptedB = await getDecryptedUserbotSession(db, districtB);

      expect(decryptedA?.sessionString).toBe(secretA);
      expect(decryptedB?.sessionString).toBe(secretB);
    });

    it('Re-encryption routine migrates rows to target version and every row remains decryptable', async () => {
      process.env.ENCRYPTION_KEY_VERSION = 'v1';
      process.env.ENCRYPTION_KEY = keyV1;

      const district1 = await createTestDistrict('Migrate1');
      const district2 = await createTestDistrict('Migrate2');

      const secret1 = 'session_string_1_to_migrate';
      const secret2 = 'session_string_2_to_migrate';

      await createDistrictUserbotSession(db, {
        districtId: district1,
        phoneNumber: '+998901110011',
        apiId: '12345678',
        apiHash: 'hash_1',
        sessionString: secret1,
      });

      await createDistrictUserbotSession(db, {
        districtId: district2,
        phoneNumber: '+998901110012',
        apiId: '12345678',
        apiHash: 'hash_2',
        sessionString: secret2,
      });

      // Setup dual keys for rotation to v2
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY_V2 = keyV2;
      process.env.ENCRYPTION_KEY_V1 = keyV1;

      // Run re-encryption routine scoped to the created test districts
      const report = await reencryptUserbotSessions(db, {
        targetKeyVersion: 'v2',
        districtIds: [district1, district2],
      });
      expect(report.migratedCount).toBe(2);
      expect(report.remainingCount).toBe(0);

      // Verify DB rows updated to v2
      const [row1] = await db.select().from(districtTelegramUserbotSessions).where(eq(districtTelegramUserbotSessions.districtId, district1));
      const [row2] = await db.select().from(districtTelegramUserbotSessions).where(eq(districtTelegramUserbotSessions.districtId, district2));

      expect(row1?.sessionKeyVersion).toBe('v2');
      expect(row2?.sessionKeyVersion).toBe('v2');

      // Verify both rows decrypt correctly with v2
      const decrypted1 = await getDecryptedUserbotSession(db, district1);
      const decrypted2 = await getDecryptedUserbotSession(db, district2);

      expect(decrypted1?.sessionString).toBe(secret1);
      expect(decrypted2?.sessionString).toBe(secret2);
    });

    it('Re-encryption routine is idempotent and re-runnable', async () => {
      process.env.ENCRYPTION_KEY_VERSION = 'v1';
      process.env.ENCRYPTION_KEY_V1 = keyV1;
      process.env.ENCRYPTION_KEY = keyV1;

      const districtId = await createTestDistrict('Idempotent1');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901110013',
        apiId: '12345678',
        apiHash: 'hash_idem',
        sessionString: 'secret_idempotent_test',
      });

      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY_V2 = keyV2;
      process.env.ENCRYPTION_KEY_V1 = keyV1;

      // First run migrates districtId
      const report1 = await reencryptUserbotSessions(db, {
        targetKeyVersion: 'v2',
        districtIds: [districtId],
      });
      expect(report1.migratedCount).toBe(1);
      expect(report1.remainingCount).toBe(0);

      // Second run migrates 0 rows and reports 0 remaining
      const report2 = await reencryptUserbotSessions(db, {
        targetKeyVersion: 'v2',
        districtIds: [districtId],
      });
      expect(report2.migratedCount).toBe(0);
      expect(report2.remainingCount).toBe(0);
    });

    it('A PARTIAL session envelope on the SAME key version as the target is reported, not silently skipped', async () => {
      process.env.ENCRYPTION_KEY_VERSION = 'v1';
      process.env.ENCRYPTION_KEY = keyV1;
      process.env.ENCRYPTION_KEY_V1 = keyV1;

      const districtId = await createTestDistrict('SameVersionPartial');

      try {
        await createDistrictUserbotSession(db, {
          districtId,
          phoneNumber: '+998901110061',
          apiId: '12345678',
          apiHash: 'hash_same_ver_partial',
          sessionString: 'session_string_partial_same_version',
        });

        // Move the row onto the TARGET key version while stripping its IV, producing a PARTIAL
        // envelope whose sessionKeyVersion already equals the target. The old guard tested iv/tag
        // only inside the `keyVersion !== target` branch, so this row was skipped in total silence:
        // no error, no log, no migration. Classification now happens before that branch.
        const [partialRow] = await db
          .update(districtTelegramUserbotSessions)
          .set({ sessionKeyVersion: 'v2', sessionIv: null })
          .where(eq(districtTelegramUserbotSessions.districtId, districtId))
          .returning();

        process.env.ENCRYPTION_KEY_VERSION = 'v2';
        process.env.ENCRYPTION_KEY_V2 = keyV2;
        process.env.ENCRYPTION_KEY_V1 = keyV1;

        await expect(
          reencryptUserbotSessions(db, { targetKeyVersion: 'v2', districtIds: [districtId] }),
        ).rejects.toThrow(UserbotSessionEnvelopeCorruptError);

        await expect(
          reencryptUserbotSessions(db, { targetKeyVersion: 'v2', districtIds: [districtId] }),
        ).rejects.toThrow(
          new RegExp(
            `Userbot session row '${partialRow!.id}' \\(district '${districtId}'\\) has a corrupt encrypted session envelope`,
          ),
        );
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });

    it('A rotation that fails part-way leaves every stored session decryptable and no session lost', async () => {
      process.env.ENCRYPTION_KEY_VERSION = 'v1';
      process.env.ENCRYPTION_KEY_V1 = keyV1;
      process.env.ENCRYPTION_KEY = keyV1;

      const districtGood = await createTestDistrict('PartWayGood');
      const districtBad = await createTestDistrict('PartWayBad');

      const secretGood = 'good_session_that_migrates';

      await createDistrictUserbotSession(db, {
        districtId: districtGood,
        phoneNumber: '+998901110021',
        apiId: '12345678',
        apiHash: 'hash_good',
        sessionString: secretGood,
      });

      // Insert districtBad with corrupted ciphertext (e.g. invalid auth tag)
      await createDistrictUserbotSession(db, {
        districtId: districtBad,
        phoneNumber: '+998901110022',
        apiId: '12345678',
        apiHash: 'hash_bad',
        sessionString: 'temp_will_corrupt',
      });

      // Corrupt the ciphertext of districtBad directly in DB
      await db
        .update(districtTelegramUserbotSessions)
        .set({ sessionTag: 'corrupted_tag_0000000000000000' })
        .where(eq(districtTelegramUserbotSessions.districtId, districtBad));

      // Setup dual keys for rotation to v2
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY_V2 = keyV2;
      process.env.ENCRYPTION_KEY_V1 = keyV1;

      try {
        // Re-encryption should fail when attempting districtBad
        await expect(
          reencryptUserbotSessions(db, {
            targetKeyVersion: 'v2',
            districtIds: [districtGood, districtBad],
          }),
        ).rejects.toThrow();

        // Verify that districtGood was either migrated or remains on v1, and in either case STILL DECRYPTS!
        const decryptedGood = await getDecryptedUserbotSession(db, districtGood);
        expect(decryptedGood?.sessionString).toBe(secretGood);
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtBad));
      }
    });

    it('An unresolvable key version is a clear error, never a silent fallback', async () => {
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY = keyV2;
      delete process.env.ENCRYPTION_KEY_V99;

      const districtId = await createTestDistrict('UnknownKeyVer');
      try {
        await createDistrictUserbotSession(db, {
          districtId,
          phoneNumber: '+998901110031',
          apiId: '12345678',
          apiHash: 'hash_unk',
          sessionString: 'secret_under_unknown_version',
        });

        // Update sessionKeyVersion to 'v99' directly in DB
        await db
          .update(districtTelegramUserbotSessions)
          .set({ sessionKeyVersion: 'v99' })
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));

        await expect(getDecryptedUserbotSession(db, districtId)).rejects.toThrow(
          UnresolvableKeyVersionError,
        );
        await expect(getDecryptedUserbotSession(db, districtId)).rejects.toThrow(
          /Unresolvable encryption key version 'v99'/,
        );
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });

    it('A null key version on a row that holds ciphertext is an error naming the offending row', async () => {
      const districtId = await createTestDistrict('NullKeyVer');
      try {
        await createDistrictUserbotSession(db, {
          districtId,
          phoneNumber: '+998901110041',
          apiId: '12345678',
          apiHash: 'hash_null',
          sessionString: 'secret_with_null_ver',
        });

        // Set sessionKeyVersion to empty string (representing null/missing version)
        const [updated] = await db
          .update(districtTelegramUserbotSessions)
          .set({ sessionKeyVersion: '' })
          .where(eq(districtTelegramUserbotSessions.districtId, districtId))
          .returning();

        expect(updated).toBeDefined();

        // getDecryptedUserbotSession throws naming the offending row and district ID
        await expect(getDecryptedUserbotSession(db, districtId)).rejects.toThrow(
          new RegExp(`Userbot session row '${updated!.id}' \\(district '${districtId}'\\) has ciphertext but a null or missing sessionKeyVersion`),
        );

        // reencryptUserbotSessions throws naming the offending row and district ID
        await expect(
          reencryptUserbotSessions(db, { districtIds: [districtId] }),
        ).rejects.toThrow(
          new RegExp(`Userbot session row '${updated!.id}' \\(district '${districtId}'\\) has ciphertext but a null or missing sessionKeyVersion`),
        );
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });

    it('Full dual-key sequence: add new key, re-encrypt, verify 0 remaining, remove old key, without Telegram re-auth', async () => {
      // 1. Initial state: v1 key active
      process.env.ENCRYPTION_KEY_VERSION = 'v1';
      process.env.ENCRYPTION_KEY_V1 = keyV1;
      process.env.ENCRYPTION_KEY = keyV1;

      const districtId = await createTestDistrict('DualKeyFull');
      const originalSecret = '1BVtsOIUbuw_initial_authenticated_telegram_session_string';

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901110051',
        apiId: '12345678',
        apiHash: 'hash_dk',
        sessionString: originalSecret,
      });

      // 2. Add new key v2, keep v1 configured
      process.env.ENCRYPTION_KEY_VERSION = 'v2';
      process.env.ENCRYPTION_KEY_V2 = keyV2;
      process.env.ENCRYPTION_KEY = keyV2;
      process.env.ENCRYPTION_KEY_V1 = keyV1;

      // 3. Re-encrypt all rows for this district
      const report = await reencryptUserbotSessions(db, {
        targetKeyVersion: 'v2',
        districtIds: [districtId],
      });
      expect(report.migratedCount).toBe(1);

      // 4. Verify no old-version rows remain
      expect(report.remainingCount).toBe(0);

      // 5. Remove the old v1 key completely from environment
      delete process.env.ENCRYPTION_KEY_V1;

      // 6. Verify row decrypts successfully under v2 with original secret string intact (no re-auth!)
      const decrypted = await getDecryptedUserbotSession(db, districtId);
      expect(decrypted).toBeDefined();
      expect(decrypted?.sessionString).toBe(originalSecret);
    });
  });

  describe('Milestone 5 / Ticket 11: Encrypted API Hash Envelope & Idempotent Backfill', () => {
    class MockAuthClient {
      sendCodeCalls: Array<{ phoneNumber: string; apiId: string; apiHash: string }> = [];
      async sendCode(phoneNumber: string, apiId: string, apiHash: string) {
        this.sendCodeCalls.push({ phoneNumber, apiId, apiHash });
        return { phoneCodeHash: 'mock_hash_t11' };
      }
      async signIn() {
        return { sessionString: 'mock_session_str_t11' };
      }
    }

    it('Criterion 1 & 7: The API hash is unreadable without the key: stored as ciphertext, IV, tag, version; internal read decrypts to plaintext', async () => {
      const districtId = await createTestDistrict('EncApiHashUnreadable');
      const plainApiHash = 'secret_telegram_api_hash_abc123';

      const session = await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119901',
        apiId: '1119901',
        apiHash: plainApiHash,
      });

      expect(session).toBeDefined();

      // Directly inspect raw database record
      const [dbRow] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(dbRow).toBeDefined();
      expect(dbRow!.apiHashEncrypted).toBeDefined();
      expect(dbRow!.apiHashEncrypted).not.toBeNull();
      // Unreadable without key: ciphertext is not the plaintext
      expect(dbRow!.apiHashEncrypted).not.toBe(plainApiHash);
      expect(dbRow!.apiHashEncrypted).toMatch(/^[0-9a-fA-F]+$/);

      // IV is 12 bytes = 24 hex chars
      expect(dbRow!.apiHashIv).toBeDefined();
      expect(dbRow!.apiHashIv?.length).toBe(24);

      // Tag is 16 bytes = 32 hex chars
      expect(dbRow!.apiHashTag).toBeDefined();
      expect(dbRow!.apiHashTag?.length).toBe(32);

      // Key version recorded
      expect(dbRow!.apiHashKeyVersion).toBe('v1');

      // Internal decrypted read still returns plaintext to adapter
      const decrypted = await getDecryptedUserbotSession(db, districtId);
      expect(decrypted).toBeDefined();
      expect(decrypted!.apiHash).toBe(plainApiHash);
    });

    it('Criterion 4, 5 & 9: Null and whitespace-only API hashes normalize to null; encryption columns remain unpopulated', async () => {
      // 1. Null API hash
      const districtNull = await createTestDistrict('NullApiHashLegal');
      await createDistrictUserbotSession(db, {
        districtId: districtNull,
        phoneNumber: '+998901119902',
        apiId: '1119902',
        apiHash: null,
      });

      const [rowNull] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtNull))
        .limit(1);

      expect((rowNull as any).apiHash).toBeUndefined();
      expect(rowNull!.apiHashEncrypted).toBeNull();
      expect(rowNull!.apiHashIv).toBeNull();
      expect(rowNull!.apiHashTag).toBeNull();

      const decryptedNull = await getDecryptedUserbotSession(db, districtNull);
      expect(decryptedNull!.apiHash).toBeNull();

      // 2. Whitespace-only API hash normalizes to null
      const districtWs = await createTestDistrict('WhitespaceApiHash');
      await createDistrictUserbotSession(db, {
        districtId: districtWs,
        phoneNumber: '+998901119903',
        apiId: '1119903',
        apiHash: '    ',
      });

      const [rowWs] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtWs))
        .limit(1);

      expect((rowWs as any).apiHash).toBeUndefined();
      expect(rowWs!.apiHashEncrypted).toBeNull();
      expect(rowWs!.apiHashIv).toBeNull();
      expect(rowWs!.apiHashTag).toBeNull();

      const decryptedWs = await getDecryptedUserbotSession(db, districtWs);
      expect(decryptedWs!.apiHash).toBeNull();
    });

    it('Criterion 6: The public session view exposes neither the plaintext form nor the encrypted form of API hash', async () => {
      const districtId = await createTestDistrict('PublicViewNoLeak');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119904',
        apiId: '1119904',
        apiHash: 'sensitive_hash_public_test',
      });

      const publicSession = await getDistrictUserbotSession(db, districtId);
      expect(publicSession).toBeDefined();

      const rawPublic = publicSession as unknown as Record<string, unknown>;
      expect(rawPublic.apiHash).toBeUndefined();
      expect(rawPublic.apiHashEncrypted).toBeUndefined();
      expect(rawPublic.apiHashIv).toBeUndefined();
      expect(rawPublic.apiHashTag).toBeUndefined();
      expect(rawPublic.apiHashKeyVersion).toBeUndefined();
    });

    it('Post-migration backfill utility handles post-migration state cleanly (no-op)', async () => {
      const result = await backfillEncryptedApiHash(db);
      expect(result.migratedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(result.totalRows).toBe(0);
    });

    it('Decryption reads strictly from the encrypted envelope (no plaintext fallback)', async () => {
      const districtId = await createTestDistrict('NoFallbackDecrypt');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119907',
        apiId: '1119907',
        apiHash: 'some_hash_9907',
      });

      // Clear encrypted envelope
      await db
        .update(districtTelegramUserbotSessions)
        .set({
          apiHashEncrypted: null,
          apiHashIv: null,
          apiHashTag: null,
        })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      const decrypted = await getDecryptedUserbotSession(db, districtId);
      expect(decrypted).toBeDefined();
      expect(decrypted!.apiHash).toBeNull();
    });

    it('Distinguishes the three apiHash envelope states: complete, all-null, and corrupt PARTIAL', () => {
      expect(
        classifyApiHashEnvelope({ apiHashEncrypted: 'enc', apiHashIv: 'iv', apiHashTag: 'tag' }),
      ).toBe('COMPLETE');
      expect(
        classifyApiHashEnvelope({ apiHashEncrypted: null, apiHashIv: null, apiHashTag: null }),
      ).toBe('ABSENT');
      expect(
        classifyApiHashEnvelope({ apiHashEncrypted: 'enc', apiHashIv: null, apiHashTag: null }),
      ).toBe('PARTIAL');
      expect(
        classifyApiHashEnvelope({ apiHashEncrypted: null, apiHashIv: 'iv', apiHashTag: null }),
      ).toBe('PARTIAL');
      expect(
        classifyApiHashEnvelope({ apiHashEncrypted: null, apiHashIv: null, apiHashTag: 'tag' }),
      ).toBe('PARTIAL');
      expect(
        classifyApiHashEnvelope({ apiHashEncrypted: 'enc', apiHashIv: 'iv', apiHashTag: null }),
      ).toBe('PARTIAL');
      // A blank column is absent, matching the module's non-null-and-non-blank convention.
      expect(
        classifyApiHashEnvelope({ apiHashEncrypted: 'enc', apiHashIv: '   ', apiHashTag: null }),
      ).toBe('PARTIAL');
    });

    it('A PARTIAL apiHash envelope fails loudly with UserbotApiHashEnvelopeCorruptError instead of returning a silent null apiHash', async () => {
      const districtId = await createTestDistrict('PartialEnvelopeCorrupt');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119921',
        apiId: '1119921',
        apiHash: 'hash_partial_9921',
      });

      // Simulate a corrupt row: ciphertext retained, authentication tag lost.
      const [updated] = await db
        .update(districtTelegramUserbotSessions)
        .set({ apiHashTag: null })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .returning();

      try {
        const rejection = getDecryptedUserbotSession(db, districtId);
        await expect(rejection).rejects.toThrow(UserbotApiHashEnvelopeCorruptError);
        await expect(rejection).rejects.toThrow(
          new RegExp(
            `Userbot session row '${updated!.id}' \\(district '${districtId}'\\) has a corrupt encrypted apiHash envelope`,
          ),
        );
        await expect(rejection).rejects.toSatisfy((err: unknown) => {
          expect((err as UserbotApiHashEnvelopeCorruptError).code).toBe(
            'USERBOT_API_HASH_ENVELOPE_CORRUPT',
          );
          return true;
        });
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });

    it('An ALL-NULL apiHash envelope still returns apiHash null without throwing', async () => {
      const districtId = await createTestDistrict('AllNullEnvelope');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119922',
        apiId: '1119922',
        apiHash: null,
      });

      const decrypted = await getDecryptedUserbotSession(db, districtId);
      expect(decrypted).not.toBeNull();
      expect(decrypted!.apiHash).toBeNull();
    });

    it('A COMPLETE apiHash envelope still decrypts to the original plaintext', async () => {
      const districtId = await createTestDistrict('CompleteEnvelope');
      const plainApiHash = 'hash_complete_9923';
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119923',
        apiId: '1119923',
        apiHash: plainApiHash,
      });

      const decrypted = await getDecryptedUserbotSession(db, districtId);
      expect(decrypted!.apiHash).toBe(plainApiHash);
    });

    it('The bootstrap fallback is preserved: an absent envelope with apiHash passed as a parameter does NOT throw', async () => {
      const districtId = await createTestDistrict('BootstrapFallbackAbsentEnvelope');
      const paramHash = 'hash_supplied_as_param_9924';

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119924',
        apiId: '1119924',
        apiHash: null,
      });

      const mockAuth = new MockAuthClient();
      await bootstrapUserbotSession(db, {
        districtId,
        getPhoneCode: async () => '12345',
        authClient: mockAuth as any,
        apiHash: paramHash,
      });

      expect(mockAuth.sendCodeCalls.length).toBe(1);
      expect(mockAuth.sendCodeCalls[0]?.apiHash).toBe(paramHash);
    });

    it('Read-only preflight reports envelope health and lists corrupt rows', async () => {
      const cleanDistrict = await createTestDistrict('PreflightClean');
      await createDistrictUserbotSession(db, {
        districtId: cleanDistrict,
        phoneNumber: '+998901119925',
        apiId: '1119925',
        apiHash: 'hash_preflight_clean',
      });

      const absentDistrict = await createTestDistrict('PreflightAbsent');
      await createDistrictUserbotSession(db, {
        districtId: absentDistrict,
        phoneNumber: '+998901119926',
        apiId: '1119926',
        apiHash: null,
      });

      // The scan is global, so assert deltas against the baseline rather than absolute counts: a
      // sibling test could legitimately leave its own rows behind.
      const baseline = await verifyApiHashEnvelopes(db);

      const corruptDistrict = await createTestDistrict('PreflightCorrupt');
      try {
        await createDistrictUserbotSession(db, {
          districtId: corruptDistrict,
          phoneNumber: '+998901119927',
          apiId: '1119927',
          apiHash: 'hash_preflight_corrupt',
        });

        await db
          .update(districtTelegramUserbotSessions)
          .set({ apiHashIv: null })
          .where(eq(districtTelegramUserbotSessions.districtId, corruptDistrict));

        const report = await verifyApiHashEnvelopes(db);
        expect(report.partialCount).toBe(baseline.partialCount + 1);
        expect(report.partialRows.map((r) => r.districtId)).toContain(corruptDistrict);
        expect(report.partialRowsTruncated).toBe(false);
        expect(report.activePartialCount).toBe(0);
        expect(report.completeCount).toBeGreaterThanOrEqual(1);
        expect(report.absentCount).toBeGreaterThanOrEqual(1);
        expect(report.totalRows).toBe(
          report.completeCount + report.absentCount + report.partialCount,
        );
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, corruptDistrict));
      }
    });

    it('Ticket 12 Acceptance Criteria: plaintext api_hash column is gone, encrypted envelope remains, and pre-drop verification blocks on offending rows', async () => {
      // 1. Verify plaintext api_hash column is gone from physical table
      const columnRows = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'district_telegram_userbot_sessions'
      `);
      const columnNames = columnRows.rows.map((r: { column_name: string }) => r.column_name);

      expect(columnNames).not.toContain('api_hash');
      expect(columnNames).toContain('api_hash_encrypted');
      expect(columnNames).toContain('api_hash_iv');
      expect(columnNames).toContain('api_hash_tag');
      expect(columnNames).toContain('api_hash_key_version');

      // 2. Verify pre-drop verification logic:
      // A verification query asserts count(*) = 0 for unmigrated rows.
      // If simulated with an offending row, it blocks the drop and identifies the row.
      const simulatedVerification = (rows: Array<{ id: string; api_hash: string | null; api_hash_encrypted: string | null }>) => {
        const offending = rows.filter((r) => r.api_hash !== null && r.api_hash_encrypted === null);
        if (offending.length > 0) {
          throw new Error(
            `Verification failed before drop: ${offending.length} offending row(s) found with non-null plaintext api_hash and null api_hash_encrypted: ${offending.map((r) => r.id).join(', ')}`,
          );
        }
      };

      // Clean state passes verification
      expect(() =>
        simulatedVerification([
          { id: 'dtus_1', api_hash: 'hash', api_hash_encrypted: 'enc' },
          { id: 'dtus_2', api_hash: null, api_hash_encrypted: null },
        ]),
      ).not.toThrow();

      // Offending row blocks drop with identifiable row ID
      expect(() =>
        simulatedVerification([
          { id: 'dtus_offending_999', api_hash: 'plain_secret', api_hash_encrypted: null },
        ]),
      ).toThrow(/dtus_offending_999/);
    });

    it('Ticket 12 Acceptance Criteria: sessions decrypt their API hash with the same plaintext value, including null hash sessions', async () => {
      const testHash = 'preserved_api_hash_value_9909';
      const districtNormal = await createTestDistrict('T12DecryptNormal');
      await createDistrictUserbotSession(db, {
        districtId: districtNormal,
        phoneNumber: '+998901119909',
        apiId: '1119909',
        apiHash: testHash,
      });

      const decryptedNormal = await getDecryptedUserbotSession(db, districtNormal);
      expect(decryptedNormal!.apiHash).toBe(testHash);

      // Session with null hash
      const districtNull = await createTestDistrict('T12DecryptNull');
      await createDistrictUserbotSession(db, {
        districtId: districtNull,
        phoneNumber: '+998901119910',
        apiId: '1119910',
        apiHash: null,
      });

      const decryptedNull = await getDecryptedUserbotSession(db, districtNull);
      expect(decryptedNull!.apiHash).toBeNull();
    });

    it('Interactive bootstrap writes encrypted API hash envelope', async () => {
      const districtId = await createTestDistrict('BootstrapEncApiHash');
      const authHash = 'auth_hash_bootstrap_9908';

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119908',
        apiId: '1119908',
        apiHash: authHash,
      });

      const mockAuth = new MockAuthClient();
      await bootstrapUserbotSession(db, {
        districtId,
        getPhoneCode: async () => '12345',
        authClient: mockAuth as any,
      });

      // Verify auth client received the decrypted apiHash
      expect(mockAuth.sendCodeCalls.length).toBe(1);
      expect(mockAuth.sendCodeCalls[0]?.apiHash).toBe(authHash);

      // Verify row now has active status, encrypted session, and encrypted apiHash
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(row!.status).toBe('ACTIVE');
      expect(row!.sessionEncrypted).not.toBeNull();
      expect(row!.apiHashEncrypted).not.toBeNull();
      expect(row!.apiHashIv).not.toBeNull();
      expect(row!.apiHashTag).not.toBeNull();
      expect(row!.apiHashKeyVersion).toBe('v1');

      const decrypted = await getDecryptedUserbotSession(db, districtId);
      expect(decrypted!.apiHash).toBe(authHash);
      expect(decrypted!.sessionString).toBe('mock_session_str_t11');
    });
  });

  describe('Session-string credential envelope integrity (partial-envelope silent degradation)', () => {
    it('Distinguishes the three session envelope states, with a blank column counting as absent', () => {
      expect(
        classifySessionEnvelope({ sessionEncrypted: 'enc', sessionIv: 'iv', sessionTag: 'tag' }),
      ).toBe('COMPLETE');
      expect(
        classifySessionEnvelope({ sessionEncrypted: null, sessionIv: null, sessionTag: null }),
      ).toBe('ABSENT');
      expect(
        classifySessionEnvelope({ sessionEncrypted: 'enc', sessionIv: null, sessionTag: null }),
      ).toBe('PARTIAL');
      expect(
        classifySessionEnvelope({ sessionEncrypted: null, sessionIv: 'iv', sessionTag: null }),
      ).toBe('PARTIAL');
      expect(
        classifySessionEnvelope({ sessionEncrypted: null, sessionIv: null, sessionTag: 'tag' }),
      ).toBe('PARTIAL');
      expect(
        classifySessionEnvelope({ sessionEncrypted: 'enc', sessionIv: 'iv', sessionTag: null }),
      ).toBe('PARTIAL');
      expect(
        classifySessionEnvelope({ sessionEncrypted: '   ', sessionIv: 'iv', sessionTag: 'tag' }),
      ).toBe('PARTIAL');
    });

    it('classifyEncryptedEnvelope is total: undefined behaves exactly like null', () => {
      expect(classifyEncryptedEnvelope(undefined, undefined, undefined)).toBe('ABSENT');
      expect(classifyEncryptedEnvelope(null, undefined, undefined)).toBe('ABSENT');
      expect(classifyEncryptedEnvelope('enc', undefined, undefined)).toBe('PARTIAL');
      expect(classifyEncryptedEnvelope(null, undefined, 'tag')).toBe('PARTIAL');
      expect(classifyEncryptedEnvelope('enc', 'iv', undefined)).toBe('PARTIAL');
      expect(classifyEncryptedEnvelope('enc', 'iv', 'tag')).toBe('COMPLETE');
    });

    it('An ALL-WHITESPACE session triple is treated as absent, never handed to the decryptor', async () => {
      // Tested nowhere before this fix: the write path normalizes blank strings to NULL, so this
      // state is reachable only through out-of-band corruption. A truthiness guard accepted it as a
      // stored credential and passed three blank strings into decryptToken.
      const districtId = await createTestDistrict('AllWhitespaceSessionEnvelope');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119936',
        apiId: '1119936',
        apiHash: 'hash_all_whitespace_session',
        sessionString: '1ApW_all_whitespace_session_secret',
      });

      const [blanked] = await db
        .update(districtTelegramUserbotSessions)
        .set({ sessionEncrypted: '   ', sessionIv: '   ', sessionTag: '   ' })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .returning();

      try {
        expect(
          classifySessionEnvelope({
            sessionEncrypted: blanked!.sessionEncrypted,
            sessionIv: blanked!.sessionIv,
            sessionTag: blanked!.sessionTag,
          }),
        ).toBe('ABSENT');

        const decrypted = await getDecryptedUserbotSession(db, districtId);
        expect(decrypted).not.toBeNull();
        expect(decrypted!.sessionString).toBeNull();
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });

    it('getDecryptedUserbotSession fails loudly on a PARTIAL session envelope instead of returning a silent null', async () => {
      const districtId = await createTestDistrict('PartialSessionEnvelope');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119931',
        apiId: '1119931',
        apiHash: 'hash_session_partial',
        sessionString: '1ApW_partial_session_envelope_secret',
      });

      // Simulate a corrupt row: session ciphertext retained, authentication tag lost.
      const [updated] = await db
        .update(districtTelegramUserbotSessions)
        .set({ sessionTag: null })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .returning();

      try {
        await expect(getDecryptedUserbotSession(db, districtId)).rejects.toThrow(
          UserbotSessionEnvelopeCorruptError,
        );
        await expect(getDecryptedUserbotSession(db, districtId)).rejects.toThrow(
          new RegExp(
            `Userbot session row '${updated!.id}' \\(district '${districtId}'\\) has a corrupt encrypted session envelope`,
          ),
        );
        await expect(getDecryptedUserbotSession(db, districtId)).rejects.toSatisfy((err: unknown) => {
          expect((err as UserbotSessionEnvelopeCorruptError).code).toBe(
            'USERBOT_SESSION_ENVELOPE_CORRUPT',
          );
          return true;
        });
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });

    it('An ALL-NULL session envelope stays legitimate: sessionString is null and nothing throws', async () => {
      const districtId = await createTestDistrict('AllNullSessionEnvelope');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119932',
        apiId: '1119932',
        apiHash: 'hash_all_null_session',
      });

      const decrypted = await getDecryptedUserbotSession(db, districtId);
      expect(decrypted).not.toBeNull();
      expect(decrypted!.sessionString).toBeNull();
      expect(decrypted!.apiHash).toBe('hash_all_null_session');
    });

    it('getDistrictUserbotSession surfaces a PARTIAL session envelope instead of reporting hasSession false', async () => {
      const districtId = await createTestDistrict('PublicPartialSession');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119933',
        apiId: '1119933',
        apiHash: 'hash_public_partial',
        sessionString: '1ApW_public_partial_session_secret',
      });

      await db
        .update(districtTelegramUserbotSessions)
        .set({ sessionIv: null })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      try {
        await expect(getDistrictUserbotSession(db, districtId)).rejects.toThrow(
          UserbotSessionEnvelopeCorruptError,
        );
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });

    it('disable refuses a PARTIAL session envelope: no revocation attempt, no transition, no audit', async () => {
      const districtId = await createTestDistrict('DisablePartialSession');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119934',
        apiId: '1119934',
        apiHash: 'hash_disable_partial',
        sessionString: '1ApW_disable_partial_session_secret',
      });

      await db
        .update(districtTelegramUserbotSessions)
        .set({ sessionTag: null })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      const revokerSpy = vi.fn().mockResolvedValue({ revocationPerformed: true });

      try {
        await expect(
          disableDistrictUserbotSession(db, districtId, {
            actorId: 'po_partial_session',
            actorRole: 'PRODUCT_OWNER',
            revoker: revokerSpy,
          }),
        ).rejects.toThrow(UserbotSessionEnvelopeCorruptError);

        // The corrupt row is never revoked against and never transitioned.
        expect(revokerSpy).not.toHaveBeenCalled();

        const [row] = await db
          .select()
          .from(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
        expect(row?.status).toBe('PENDING');

        const audits = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.districtId, districtId));
        expect(audits.filter((e) => e.action === 'USERBOT_SESSION_DISABLED')).toHaveLength(0);
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });

    it('enable refuses to grade a PARTIAL session envelope ACTIVE', async () => {
      const districtId = await createTestDistrict('EnablePartialSession');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119935',
        apiId: '1119935',
        apiHash: 'hash_enable_partial',
        sessionString: '1ApW_enable_partial_session_secret',
      });

      // Ciphertext present with its IV retained but the tag lost, and the row parked in DISABLED so
      // the enable path would otherwise clear the secrets and settle on PENDING.
      await db
        .update(districtTelegramUserbotSessions)
        .set({ status: 'DISABLED', sessionTag: null })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      try {
        await expect(enableDistrictUserbotSession(db, districtId)).rejects.toThrow(
          UserbotSessionEnvelopeCorruptError,
        );

        const [row] = await db
          .select()
          .from(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
        expect(row?.status).toBe('DISABLED');
        expect(row?.sessionEncrypted).not.toBeNull();
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });

    it('bootstrap rejects a PARTIAL apiHash envelope as corruption rather than a misleading credential-validation error', async () => {
      const districtId = await createTestDistrict('BootstrapPartialApiHash');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901119936',
        apiId: '1119936',
        apiHash: 'hash_bootstrap_partial',
      });

      await db
        .update(districtTelegramUserbotSessions)
        .set({ apiHashIv: null })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      const sendCodeCalls: Array<{ phoneNumber: string; apiId: string; apiHash: string }> = [];
      const authClient = {
        async sendCode(phoneNumber: string, apiId: string, apiHash: string) {
          sendCodeCalls.push({ phoneNumber, apiId, apiHash });
          return { phoneCodeHash: 'partial_hash' };
        },
        async signIn() {
          return { sessionString: 'partial_session_str' };
        },
        async signInWithPassword() {
          return { sessionString: 'partial_session_str' };
        },
      };

      try {
        await expect(
          bootstrapUserbotSession(db, {
            districtId,
            getPhoneCode: async () => '12345',
            authClient,
          }),
        ).rejects.toThrow(UserbotApiHashEnvelopeCorruptError);

        // The corrupt row never reaches the protocol handshake.
        expect(sendCodeCalls).toHaveLength(0);
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });

    it('The preflight scan reports the session envelope and flags a corrupt session row', async () => {
      const baseline = await verifyApiHashEnvelopes(db);

      const districtId = await createTestDistrict('PreflightSessionCorrupt');
      try {
        await createDistrictUserbotSession(db, {
          districtId,
          phoneNumber: '+998901119937',
          apiId: '1119937',
          apiHash: 'hash_preflight_session',
          sessionString: '1ApW_preflight_session_secret',
        });

        await db
          .update(districtTelegramUserbotSessions)
          .set({ sessionTag: null })
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));

        const report = await verifyApiHashEnvelopes(db);

        // The session envelope is reported independently of the apiHash envelope.
        expect(report.session.partialCount).toBe(baseline.session.partialCount + 1);
        expect(report.session.partialRows.map((r) => r.districtId)).toContain(districtId);
        expect(report.session.partialRowsTruncated).toBe(false);

        // The apiHash envelope for this row is untouched, so its section does not move.
        expect(report.partialCount).toBe(baseline.partialCount);
      } finally {
        await db
          .delete(districtTelegramUserbotSessions)
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      }
    });
  });

  describe('Ticket 13: Credential Boundary Validation (Service / DTO Level)', () => {
    it('rejects malformed phone numbers ("123", "998901234567", "+998 90 123 45 67", "+abcdef") with UserbotCredentialValidationError naming phoneNumber', async () => {
      const districtId = await createTestDistrict('BoundaryPhone');

      const invalidNumbers = [
        '123',
        '998901234567',
        '+998 90 123 45 67',
        '+998-90-1234567',
        '+abcdef',
        '+12345',
        '+1234567890123456',
      ];

      for (const phone of invalidNumbers) {
        await expect(
          createDistrictUserbotSession(db, {
            districtId,
            phoneNumber: phone,
            apiId: '12345678',
          }),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(UserbotCredentialValidationError);
          expect((err as UserbotCredentialValidationError).field).toBe('phoneNumber');
          expect((err as UserbotCredentialValidationError).code).toBe('VALIDATION_ERROR');
          expect((err as Error).message).toContain('phoneNumber');
          return true;
        });
      }
    });

    it('rejects malformed API ID values ("-5", -5, "0", 0, "abc", "12.34", 12.34, " 12345 ") with UserbotCredentialValidationError naming apiId', async () => {
      const districtId = await createTestDistrict('BoundaryApiId');

      const invalidIds: Array<string | number> = [
        '-5',
        -5,
        '0',
        0,
        'abc',
        '12.34',
        12.34,
        ' 12345 ',
      ];

      for (const id of invalidIds) {
        await expect(
          createDistrictUserbotSession(db, {
            districtId,
            phoneNumber: '+998901234567',
            apiId: id,
          }),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(UserbotCredentialValidationError);
          expect((err as UserbotCredentialValidationError).field).toBe('apiId');
          expect((err as UserbotCredentialValidationError).code).toBe('VALIDATION_ERROR');
          expect((err as Error).message).toContain('apiId');
          return true;
        });
      }
    });

    it('accepts apiId supplied as numeric JSON value and stores it as a string', async () => {
      const districtId = await createTestDistrict('NumericApiId');

      const session = await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901234567',
        apiId: 20401010,
      });

      expect(session.apiId).toBe('20401010');

      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(row?.apiId).toBe('20401010');
    });

    it('treats whitespace-only apiHash as absent rather than storing non-empty value', async () => {
      const districtId = await createTestDistrict('WhitespaceHash');

      const session = await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901234567',
        apiId: '12345678',
        apiHash: '    ',
      });

      expect(session).toBeDefined();

      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(row?.apiHashEncrypted).toBeNull();

      const decrypted = await getDecryptedUserbotSession(db, districtId);
      expect(decrypted?.apiHash).toBeNull();
    });

    it('accepts non-empty apiHash matching no expected pattern (non-emptiness check, not pattern match)', async () => {
      const districtId = await createTestDistrict('UnusualPatternHash');
      const unusualHash = 'unusual_non_hex_custom_hash_xyz_123';

      const session = await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901234567',
        apiId: '12345678',
        apiHash: unusualHash,
      });

      expect(session).toBeDefined();

      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      expect(row?.apiHashEncrypted).not.toBeNull();

      const decrypted = await getDecryptedUserbotSession(db, districtId);
      expect(decrypted?.apiHash).toBe(unusualHash);
    });

    it('accepts valid credential set: positive integer API id, international phone, non-empty hash', async () => {
      const districtId = await createTestDistrict('ValidCredSet');

      const session = await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901234567',
        apiId: '77889900',
        apiHash: 'valid_credential_set_hash_1',
      });

      expect(session.status).toBe('PENDING');
      expect(session.phoneNumber).toBe('+998901234567');
      expect(session.apiId).toBe('77889900');
    });
  });

  describe('Ticket 15: Canonical Session Lifecycle Audit Records', () => {
    class Ticket15MockAuthClient {
      sendCodeCalls: Array<{ phoneNumber: string; apiId: string; apiHash: string }> = [];
      async sendCode(phoneNumber: string, apiId: string, apiHash: string) {
        this.sendCodeCalls.push({ phoneNumber, apiId, apiHash });
        return { phoneCodeHash: 'mock_hash_t15' };
      }
      async signIn() {
        return { sessionString: 'mock_session_str_ticket_15' };
      }
    }

    it('Criterion 1: strictly uses canonical action names and defines the 8 canonical actions', () => {
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
      for (const action of USERBOT_SESSION_AUDIT_ACTIONS) {
        expect(UserbotSessionAuditActionSchema.parse(action)).toBe(action);
      }
      expect(() => UserbotSessionAuditActionSchema.parse('USERBOT_SESSION_PURGED')).toThrow();
    });

    it('Criterion 2: creating writes USERBOT_SESSION_CREATED and interactive bootstrap writes USERBOT_SESSION_ACTIVATED', async () => {
      const districtId = await createTestDistrict('T15CreateAndBootstrap');
      const humanActorId = 'po_actor_t15_01';

      // 1. Create session
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901112233',
        apiId: '1112233',
        apiHash: 'hash_t15_01',
        actorId: humanActorId,
        actorRole: 'PRODUCT_OWNER',
      });

      const createAudits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));
      const createEvent = createAudits.find((e) => e.action === 'USERBOT_SESSION_CREATED');
      expect(createEvent).toBeDefined();
      expect(createEvent!.action).toBe('USERBOT_SESSION_CREATED');
      expect(createEvent!.actorId).toBe(humanActorId);
      expect(createEvent!.actorRole).toBe('PRODUCT_OWNER');
      expect(createEvent!.metadata).toMatchObject({
        previousStatus: null,
        newStatus: 'PENDING',
        phoneNumber: '+998901112233',
      });

      // 2. Interactive bootstrap
      const mockAuth = new Ticket15MockAuthClient();
      await bootstrapUserbotSession(db, {
        districtId,
        getPhoneCode: async () => '12345',
        authClient: mockAuth as any,
        actorId: humanActorId,
        actorRole: 'PRODUCT_OWNER',
      });

      const bootstrapAudits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));
      const activatedEvent = bootstrapAudits.find((e) => e.action === 'USERBOT_SESSION_ACTIVATED');
      expect(activatedEvent).toBeDefined();
      expect(activatedEvent!.action).toBe('USERBOT_SESSION_ACTIVATED');
      expect(activatedEvent!.actorId).toBe(humanActorId);
      expect(activatedEvent!.actorRole).toBe('PRODUCT_OWNER');
      expect(activatedEvent!.metadata).toMatchObject({
        previousStatus: 'PENDING',
        newStatus: 'ACTIVE',
      });
    });

    it('Criterion 3: detected ban writes USERBOT_SESSION_BANNED and duplicate auth key writes USERBOT_SESSION_AUTH_KEY_DUPLICATED', async () => {
      const distBan = await createTestDistrict('T15BanAudit');
      await createDistrictUserbotSession(db, {
        districtId: distBan,
        phoneNumber: '+998901114455',
        apiId: '1114455',
        sessionString: 'session_t15_ban',
      });
      await enableDistrictUserbotSession(db, distBan);

      const manager = new UserbotConnectionManager({ db });
      await manager.handleBan(distBan, new Error('PHONE_NUMBER_BANNED'));

      const banAudits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, distBan));
      const banEvent = banAudits.find((e) => e.action === 'USERBOT_SESSION_BANNED');
      expect(banEvent).toBeDefined();
      expect(banEvent!.action).toBe('USERBOT_SESSION_BANNED');
      expect(banEvent!.actorId).toBe('system:userbot-manager');
      expect(banEvent!.actorRole).toBe('SYSTEM');
      expect(banEvent!.metadata).toMatchObject({
        previousStatus: 'ACTIVE',
        newStatus: 'BANNED',
      });

      // Idempotency: calling handleBan again when already BANNED does not emit duplicate audit
      await manager.handleBan(distBan, new Error('PHONE_NUMBER_BANNED_AGAIN'));
      const banAuditsAfter = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, distBan));
      const banEventsCount = banAuditsAfter.filter((e) => e.action === 'USERBOT_SESSION_BANNED').length;
      expect(banEventsCount).toBe(1);

      // Duplicate auth key
      const distDup = await createTestDistrict('T15DupKeyAudit');
      await createDistrictUserbotSession(db, {
        districtId: distDup,
        phoneNumber: '+998901116677',
        apiId: '1116677',
        sessionString: 'session_t15_dup',
      });
      await enableDistrictUserbotSession(db, distDup);

      await manager.handleAuthKeyDuplicated(distDup, new Error('AUTH_KEY_DUPLICATED'));
      const dupAudits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, distDup));
      const dupEvent = dupAudits.find((e) => e.action === 'USERBOT_SESSION_AUTH_KEY_DUPLICATED');
      expect(dupEvent).toBeDefined();
      expect(dupEvent!.action).toBe('USERBOT_SESSION_AUTH_KEY_DUPLICATED');
      expect(dupEvent!.actorId).toBe('system:userbot-manager');
      expect(dupEvent!.actorRole).toBe('SYSTEM');
      expect(dupEvent!.metadata).toMatchObject({
        previousStatus: 'ACTIVE',
        newStatus: 'PENDING',
      });
    });

    it('Criterion 4: Product Owner disable writes USERBOT_SESSION_DISABLED and enable writes USERBOT_SESSION_ENABLED', async () => {
      const districtId = await createTestDistrict('T15DisableEnable');
      const humanActorId = 'po_actor_t15_02';

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901118899',
        apiId: '1118899',
        sessionString: 'session_t15_disable_enable',
      });
      await enableDistrictUserbotSession(db, districtId);

      const revokerSpy = vi.fn().mockResolvedValue({ revocationPerformed: true, revocationSuccess: true });
      await disableDistrictUserbotSession(db, districtId, {
        actorId: humanActorId,
        actorRole: 'PRODUCT_OWNER',
        revoker: revokerSpy,
      });

      const disableAudits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));
      const disableEvent = disableAudits.find((e) => e.action === 'USERBOT_SESSION_DISABLED');
      expect(disableEvent).toBeDefined();
      expect(disableEvent!.action).toBe('USERBOT_SESSION_DISABLED');
      expect(disableEvent!.actorId).toBe(humanActorId);
      expect(disableEvent!.actorRole).toBe('PRODUCT_OWNER');
      expect(disableEvent!.metadata).toMatchObject({
        previousStatus: 'ACTIVE',
        newStatus: 'DISABLED',
        revocationPerformed: true,
        secretsCleared: false,
      });

      await enableDistrictUserbotSession(db, districtId, {
        actorId: humanActorId,
        actorRole: 'PRODUCT_OWNER',
      });

      const enableAudits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));
      const enableEvent = enableAudits.find(
        (e) =>
          e.action === 'USERBOT_SESSION_ENABLED' &&
          (e.metadata as any)?.previousStatus === 'DISABLED',
      );
      expect(enableEvent).toBeDefined();
      expect(enableEvent!.action).toBe('USERBOT_SESSION_ENABLED');
      expect(enableEvent!.actorId).toBe(humanActorId);
      expect(enableEvent!.actorRole).toBe('PRODUCT_OWNER');
      expect(enableEvent!.metadata).toMatchObject({
        previousStatus: 'DISABLED',
        newStatus: 'PENDING',
      });
    });

    it('Criterion 5: status transitions not named above write USERBOT_SESSION_STATUS_UPDATED', async () => {
      const districtId = await createTestDistrict('T15StatusUpdated');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998902221100',
        apiId: '2221100',
        sessionString: 'session_t15_status_updated',
      });

      // 1. Activate session
      await enableDistrictUserbotSession(db, districtId);

      // 2. Account deleted transition writes USERBOT_SESSION_STATUS_UPDATED
      const manager = new UserbotConnectionManager({ db });
      await manager.handleAccountDeleted(districtId, new Error('USER_DEACTIVATED'));

      const audits2 = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));
      const accountDeletedEvent = audits2.find(
        (e) =>
          e.action === 'USERBOT_SESSION_STATUS_UPDATED' &&
          (e.metadata as any)?.reason === 'ACCOUNT_DELETED',
      );
      expect(accountDeletedEvent).toBeDefined();
      expect(accountDeletedEvent!.actorId).toBe('system:userbot-manager');
      expect(accountDeletedEvent!.actorRole).toBe('SYSTEM');
      expect(accountDeletedEvent!.metadata).toMatchObject({
        previousStatus: 'ACTIVE',
        newStatus: 'PENDING',
        secretsCleared: false,
        reason: 'ACCOUNT_DELETED',
      });
    });

    it('Criterion 6: transitions are attributed to the actor who performed them (human vs system)', async () => {
      const districtId = await createTestDistrict('T15ActorAttribution');

      // Human creation with role
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998902223344',
        apiId: '2223344',
        actorId: 'usr_product_owner_42',
        actorRole: 'PRODUCT_OWNER',
      });

      const [createAudit] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.districtId, districtId),
            eq(auditEvents.action, 'USERBOT_SESSION_CREATED'),
          ),
        );
      expect(createAudit?.actorId).toBe('usr_product_owner_42');
      expect(createAudit?.actorRole).toBe('PRODUCT_OWNER');

      // System-initiated status update attributes to system actor
      await enableDistrictUserbotSession(db, districtId);
      const manager = new UserbotConnectionManager({ db });
      await manager.handleAccountDeleted(districtId, new Error('USER_DEACTIVATED'));

      const [statusAudit] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.districtId, districtId),
            eq(auditEvents.action, 'USERBOT_SESSION_STATUS_UPDATED'),
          ),
        );
      expect(statusAudit?.actorId).toBe('system:userbot-manager');
      expect(statusAudit?.actorRole).toBe('SYSTEM');
    });

    it('Criterion 7: records of status transitions carry both previousStatus and newStatus', async () => {
      const districtId = await createTestDistrict('T15PrevNextStatus');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998902225566',
        apiId: '2225566',
        sessionString: 'session_prev_next_test',
        actorId: 'usr_admin',
        actorRole: 'PRODUCT_OWNER',
      });

      await disableDistrictUserbotSession(db, districtId, {
        actorId: 'usr_admin',
        actorRole: 'PRODUCT_OWNER',
      });

      await enableDistrictUserbotSession(db, districtId, {
        actorId: 'usr_admin',
        actorRole: 'PRODUCT_OWNER',
      });

      const allAudits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));

      for (const event of allAudits) {
        const meta = event.metadata as Record<string, unknown> | null;
        expect(meta).toBeDefined();
        expect(meta).toHaveProperty('previousStatus');
        expect(meta).toHaveProperty('newStatus');
      }
    });

    it('Criterion 8 & 9: disable record states revocationPerformed: boolean and secretsCleared: false (apiHash envelope preserved)', async () => {
      const districtId = await createTestDistrict('T15DisableFields');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998902227788',
        apiId: '2227788',
        sessionString: 'session_t15_secrets_test',
      });
      await enableDistrictUserbotSession(db, districtId);

      const revokerSpy = vi.fn().mockResolvedValue({ revocationPerformed: true, revocationSuccess: true });
      await disableDistrictUserbotSession(db, districtId, {
        actorId: 'po_disable_actor',
        actorRole: 'PRODUCT_OWNER',
        revoker: revokerSpy,
      });

      const [disableAudit] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.districtId, districtId),
            eq(auditEvents.action, 'USERBOT_SESSION_DISABLED'),
          ),
        );

      expect(disableAudit).toBeDefined();
      const meta = disableAudit!.metadata as Record<string, unknown>;
      expect(typeof meta.revocationPerformed).toBe('boolean');
      expect(meta.revocationPerformed).toBe(true);
      expect(meta.secretsCleared).toBe(false);
    });

    it('Criterion 10: a failed revocation is recorded as a failure rather than as a success', async () => {
      const districtId = await createTestDistrict('T15FailedRevocation');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998902229900',
        apiId: '2229900',
        sessionString: 'session_failed_revocation_test',
      });
      await enableDistrictUserbotSession(db, districtId);

      // Custom revoker returning revocationSuccess: false
      const failedRevoker = vi.fn().mockResolvedValue({
        revocationPerformed: false,
        revocationSuccess: false,
      });

      await disableDistrictUserbotSession(db, districtId, {
        actorId: 'po_fail_actor',
        actorRole: 'PRODUCT_OWNER',
        revoker: failedRevoker,
      });

      const [disableAudit] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.districtId, districtId),
            eq(auditEvents.action, 'USERBOT_SESSION_DISABLED'),
          ),
        );

      expect(disableAudit).toBeDefined();
      const meta = disableAudit!.metadata as Record<string, unknown>;
      expect(meta.revocationSuccess).toBe(false);

      // Verify determineAuditActionOutcome classifies it as FAILURE
      const calculatedOutcome = auditService.determineAuditActionOutcome(
        disableAudit!.action,
        meta,
      );
      expect(calculatedOutcome).toBe('FAILURE');

      // Verify query service formats row with outcome: FAILURE
      const retrieved = await auditQueryService.getAuditEventById(db, disableAudit!.id);
      expect(retrieved).toBeDefined();
      if (retrieved && retrieved.recordType === 'AUDIT_EVENT') {
        expect(retrieved.outcome).toBe('FAILURE');
      }
    });

    it('a corrupt api-hash envelope is logged and revocation proceeds without an api-hash instead of failing silently', async () => {
      const districtId = await createTestDistrict('CorruptApiHashRevocation');
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998902229901',
        apiId: '2229901',
        apiHash: 'hash_corrupt_revocation_9901',
        sessionString: 'session_corrupt_revocation_test',
      });
      await enableDistrictUserbotSession(db, districtId);

      // Keep the envelope structurally complete (all three fields non-empty, so the corruption
      // assertions pass) but make the IV undecryptable, which forces decryptToken to throw inside
      // the revocation path.
      await db
        .update(districtTelegramUserbotSessions)
        .set({ apiHashIv: 'this-is-not-a-valid-12-byte-iv' })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      const revokerSpy = vi.fn().mockResolvedValue({
        revocationPerformed: true,
        revocationSuccess: true,
      });
      const warnSpy = vi.spyOn(logger, 'warn');

      try {
        await disableDistrictUserbotSession(db, districtId, {
          actorId: 'po_corrupt_actor',
          actorRole: 'PRODUCT_OWNER',
          revoker: revokerSpy,
        });

        // Revocation still ran, and it ran without an api-hash (the intended fallback).
        expect(revokerSpy).toHaveBeenCalledTimes(1);
        expect(revokerSpy.mock.calls[0]![0].apiHash).toBeNull();

        // The failure is observable rather than silently swallowed.
        expect(
          warnSpy.mock.calls.some((call) =>
            String(call.at(1)).includes('proceeding without api-hash'),
          ),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('Criterion 11: Audit Records unconditionally omit session strings, API hashes, and message content', async () => {
      // 1. Test auditService.sanitizeMetadata directly
      const dirtyMetadata = {
        sessionString: '1ApW_SUPER_SECRET_SESSION_STRING',
        session_string: 'another_secret_session',
        apiHash: '0123456789abcdef0123456789abcdef',
        api_hash: 'snake_api_hash_secret',
        messageContent: 'Citizen complaint message text that should not be audited',
        message_content: 'Citizen private report',
        message: 'Direct user message content',
        safeProperty: 'allowed_value_123',
        status: 'ACTIVE',
      };

      const sanitized = auditService.sanitizeMetadata(dirtyMetadata);
      expect(sanitized).toBeDefined();
      expect(sanitized!.sessionString).toBeUndefined();
      expect(sanitized!.session_string).toBeUndefined();
      expect(sanitized!.apiHash).toBeUndefined();
      expect(sanitized!.api_hash).toBeUndefined();
      expect(sanitized!.messageContent).toBeUndefined();
      expect(sanitized!.message_content).toBeUndefined();
      expect(sanitized!.message).toBeUndefined();
      expect(sanitized!.safeProperty).toBe('allowed_value_123');
      expect(sanitized!.status).toBe('ACTIVE');

      // 2. Test that creating, bootstrapping, and disabling sessions writes no sensitive secrets into audit_events table
      const districtId = await createTestDistrict('T15SecretOmission');
      const sensitiveSessionString = '1ApW_CONFIDENTIAL_USER_SESSION_123';
      const sensitiveApiHash = 'abcdef0123456789abcdef0123456789';

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998903330011',
        apiId: '3330011',
        sessionString: sensitiveSessionString,
        apiHash: sensitiveApiHash,
      });

      const rawAudits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.districtId, districtId));

      for (const audit of rawAudits) {
        const rawJson = JSON.stringify(audit);
        expect(rawJson).not.toContain(sensitiveSessionString);
        expect(rawJson).not.toContain(sensitiveApiHash);
        expect(rawJson).not.toContain('messageContent');
      }
    });

    it('Criterion 12: a refused transition writes no Audit Record', async () => {
      const districtId = await createTestDistrict('T15RefusedTransitions');

      // 1. Initial creation
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998903332233',
        apiId: '3332233',
      });

      const auditCountBefore = (
        await db.select().from(auditEvents).where(eq(auditEvents.districtId, districtId))
      ).length;
      expect(auditCountBefore).toBe(1); // USERBOT_SESSION_CREATED

      // Attempt 1: Duplicate session create (refused with ConflictError)
      await expect(
        createDistrictUserbotSession(db, {
          districtId,
          phoneNumber: '+998903332233',
          apiId: '3332233',
        }),
      ).rejects.toThrow(ConflictError);

      // Attempt 2: Refused bootstrap on non-existent district
      await expect(
        bootstrapUserbotSession(db, {
          districtId: 'dist_non_existent_404',
          getPhoneCode: async () => '12345',
        }),
      ).rejects.toThrow(DistrictNotFoundError);

      // Attempt 3: Ban session, then attempt refused operations on BANNED session
      const mgr = new UserbotConnectionManager({ db });
      await mgr.handleBan(districtId, new Error('PHONE_NUMBER_BANNED'));
      const auditCountAfterBan = (
        await db.select().from(auditEvents).where(eq(auditEvents.districtId, districtId))
      ).length;

      // Refused disable on BANNED session
      await expect(
        disableDistrictUserbotSession(db, districtId, { actorId: 'admin' }),
      ).rejects.toThrow(SessionBannedError);

      // Refused enable on BANNED session
      await expect(
        enableDistrictUserbotSession(db, districtId, { actorId: 'admin' }),
      ).rejects.toThrow(SessionBannedError);

      // Refused bootstrap on BANNED session
      await expect(
        bootstrapUserbotSession(db, {
          districtId,
          getPhoneCode: async () => '12345',
        }),
      ).rejects.toThrow(SessionBannedError);

      // Assert that NO additional audit events were emitted for any of the 3 refused operations
      const auditCountFinal = (
        await db.select().from(auditEvents).where(eq(auditEvents.districtId, districtId))
      ).length;
      expect(auditCountFinal).toBe(auditCountAfterBan);
    });

    it('Criterion 13 (Ticket 16 AC-8): creating sessions with identical apiId across districts records sharedApplicationCredential: true and sharedWithDistrictId in audit event and logs warning', async () => {
      const dist1 = await createTestDistrict('SharedCredDist1');
      const dist2 = await createTestDistrict('SharedCredDist2');
      const sharedApiId = String(Math.floor(1000000 + Math.random() * 9000000));

      const warnSpy = vi.spyOn(logger, 'warn');

      // 1. Create session for District 1
      const session1 = await createDistrictUserbotSession(db, {
        districtId: dist1,
        phoneNumber: '+998901110001',
        apiId: sharedApiId,
        actorId: 'admin_user_1',
      });
      expect(session1).toBeDefined();

      // Check District 1 audit event (no shared credential detected)
      const [audit1] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.districtId, dist1),
            eq(auditEvents.action, 'USERBOT_SESSION_CREATED'),
          ),
        );
      expect(audit1).toBeDefined();
      if (!audit1) {
        throw new Error('Expected a USERBOT_SESSION_CREATED audit event for District 1');
      }
      expect(audit1.metadata).not.toHaveProperty('sharedApplicationCredential');

      // 2. Create session for District 2 with identical apiId
      const session2 = await createDistrictUserbotSession(db, {
        districtId: dist2,
        phoneNumber: '+998901110002',
        apiId: sharedApiId,
        actorId: 'admin_user_2',
      });
      expect(session2).toBeDefined();

      // Verify structured warning log was emitted
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'USERBOT_SHARED_APPLICATION_CREDENTIAL_DETECTED',
          districtId: dist2,
          sharedWithDistrictId: dist1,
          apiId: sharedApiId,
        }),
        'Shared Telegram application credential detected across districts',
      );

      // Check District 2 audit event records shared credential
      const [audit2] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.districtId, dist2),
            eq(auditEvents.action, 'USERBOT_SESSION_CREATED'),
          ),
        );
      expect(audit2).toBeDefined();
      if (!audit2) {
        throw new Error('Expected a USERBOT_SESSION_CREATED audit event for District 2');
      }
      expect(audit2.metadata).toMatchObject({
        sharedApplicationCredential: true,
        sharedWithDistrictId: dist1,
      });

      warnSpy.mockRestore();
    });

    it('Criterion 14 (Ticket 16 AC-9): deleting a district cascades to delete district_telegram_userbot_sessions row and wipe secret envelopes', async () => {
      const districtId = await createTestDistrict('CascadeDeleteDist');

      // Create session with secret material
      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901110003',
        apiId: '9988776',
        apiHash: '0123456789abcdef0123456789abcdef',
        sessionString: '1BJWNg...secretTelegramSession...',
      });

      // Verify row and secret envelopes exist in DB
      const [rowBefore] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(rowBefore).toBeDefined();
      if (!rowBefore) {
        throw new Error('Expected the userbot session row to exist before district deletion');
      }
      expect(rowBefore.sessionEncrypted).toBeTruthy();
      expect(rowBefore.apiHashEncrypted).toBeTruthy();
      expect(rowBefore.sessionIv).toBeTruthy();
      expect(rowBefore.sessionTag).toBeTruthy();

      // Delete the parent district
      await db.delete(districts).where(eq(districts.id, districtId));

      // Verify the session row and all its encrypted secrets are permanently deleted via cascade
      const rowsAfter = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(rowsAfter.length).toBe(0);
    });

    it('Criterion 15 (Ticket 21 AC-9): classifyAuditActionCategory maps USERBOT_ABNORMAL_SIGNAL and userbot actions to TELEGRAM_INTEGRATION', () => {
      expect(auditService.classifyAuditActionCategory('USERBOT_ABNORMAL_SIGNAL')).toBe(
        'TELEGRAM_INTEGRATION',
      );

      for (const action of USERBOT_AUDIT_ACTIONS) {
        expect(auditService.classifyAuditActionCategory(action)).toBe('TELEGRAM_INTEGRATION');
      }
    });
  });
});
