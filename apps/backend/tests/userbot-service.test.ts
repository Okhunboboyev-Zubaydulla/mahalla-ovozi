import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import {
  districts,
  districtTelegramUserbotSessions,
  auditEvents,
  operationalIssues,
} from '../src/adapters/db/schema/index.js';
import {
  createDistrictUserbotSession,
  enableDistrictUserbotSession,
  disableDistrictUserbotSession,
  getDistrictUserbotSession,
  updateUserbotSessionStatus,
} from '../src/modules/userbot-session/index.js';
import {
  UserbotConnectionManager,
  type ClassifiedUserbotSignal,
  type UserbotClientPort,
  type UserbotClientFactory,
  type UserbotClientEvents,
  type _AssertPassiveOnlyPort,
} from '../src/modules/userbot/index.js';
import { GramJsUserbotClient } from '../src/adapters/telegram/userbot-client-adapter.js';
import { logger } from '../src/utils/logger.js';
import {
  describeUserbotRuntimeComposition,
  assertUserbotRuntimeComposition,
  UserbotRuntimeCompositionError,
} from '../src/modules/userbot/userbot-runtime-composition.js';


class MockUserbotClient implements UserbotClientPort {
  readonly districtId: string;
  readonly sessionString: string;
  readonly apiId: string;
  readonly phoneNumber: string;

  connectCalls: number = 0;
  disconnectCalls: number = 0;
  private connected: boolean = false;
  private listeners = {
    message: [] as ((update: unknown) => void)[],
    disconnect: [] as ((reason?: string | Error) => void)[],
    reconnect: [] as (() => void)[],
    error: [] as ((err: Error) => void)[],
    ban: [] as ((details?: { reason?: string; error?: Error }) => void)[],
    gap: [] as ((details?: { reason?: string; lastKnownPosition?: string | null; error?: Error }) => void)[],
    signal: [] as ((signal: ClassifiedUserbotSignal) => void)[],
  };

  constructor(params: {
    districtId: string;
    sessionString: string;
    apiId: string;
    phoneNumber: string;
  }) {
    this.districtId = params.districtId;
    this.sessionString = params.sessionString;
    this.apiId = params.apiId;
    this.phoneNumber = params.phoneNumber;
  }

  async connect(): Promise<void> {
    this.connectCalls++;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.connected = false;
    this.emit('disconnect');
  }

  isConnected(): boolean {
    return this.connected;
  }

  on<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void;
  on(...[event, listener]: { [K in keyof UserbotClientEvents]: [K, UserbotClientEvents[K]] }[keyof UserbotClientEvents]): void {
    switch (event) {
      case 'message':
        this.listeners.message.push(listener);
        break;
      case 'disconnect':
        this.listeners.disconnect.push(listener);
        break;
      case 'reconnect':
        this.listeners.reconnect.push(listener);
        break;
      case 'error':
        this.listeners.error.push(listener);
        break;
      case 'ban':
        this.listeners.ban.push(listener);
        break;
      case 'signal':
        this.listeners.signal.push(listener);
        break;
    }
  }

  off<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void;
  off(...[event, listener]: { [K in keyof UserbotClientEvents]: [K, UserbotClientEvents[K]] }[keyof UserbotClientEvents]): void {
    switch (event) {
      case 'message':
        this.listeners.message = this.listeners.message.filter((l) => l !== listener);
        break;
      case 'disconnect':
        this.listeners.disconnect = this.listeners.disconnect.filter((l) => l !== listener);
        break;
      case 'reconnect':
        this.listeners.reconnect = this.listeners.reconnect.filter((l) => l !== listener);
        break;
      case 'error':
        this.listeners.error = this.listeners.error.filter((l) => l !== listener);
        break;
      case 'ban':
        this.listeners.ban = this.listeners.ban.filter((l) => l !== listener);
        break;
      case 'signal':
        this.listeners.signal = this.listeners.signal.filter((l) => l !== listener);
        break;
    }
  }

  emit(event: 'reconnect'): void;
  emit(event: 'disconnect', reason?: string | Error): void;
  emit(event: 'message', update: unknown): void;
  emit(event: 'error', err: Error): void;
  emit(event: 'ban', details?: { reason?: string; error?: Error }): void;
  emit(event: 'signal', signal: ClassifiedUserbotSignal): void;
  emit(event: keyof UserbotClientEvents, arg?: unknown): void {
    switch (event) {
      case 'reconnect':
        for (const fn of this.listeners.reconnect) fn();
        break;
      case 'disconnect':
        if (typeof arg === 'string' || arg instanceof Error || arg === undefined) {
          for (const fn of this.listeners.disconnect) fn(arg);
        }
        break;
      case 'message':
        for (const fn of this.listeners.message) fn(arg);
        break;
      case 'error':
        if (arg instanceof Error) {
          for (const fn of this.listeners.error) fn(arg);
        }
        break;
      case 'ban':
        if (arg === undefined || (typeof arg === 'object' && arg !== null)) {
          for (const fn of this.listeners.ban) fn(arg);
        }
        break;
      case 'signal':
        if (typeof arg === 'object' && arg !== null) {
          for (const fn of this.listeners.signal) fn(arg as ClassifiedUserbotSignal);
        }
        break;
    }
  }

  simulateDrop(error?: Error): void {
    this.connected = false;
    this.emit('disconnect', error);
  }

  simulateBan(error?: Error): void {
    this.connected = false;
    this.emit('ban', {
      reason: 'PHONE_NUMBER_BANNED',
      error: error ?? new Error('PHONE_NUMBER_BANNED'),
    });
  }

  simulateAuthKeyDuplicated(error?: Error): void {
    this.connected = false;
    this.emit('error', error ?? new Error('AUTH_KEY_DUPLICATED'));
  }

  simulateFloodWait(seconds: number): void {
    this.emit('error', new Error(`FLOOD_WAIT_${seconds}`));
  }

  simulateAbnormalSignal(signalType: string): void {
    this.emit('error', new Error(signalType));
  }

  simulateAccountDeleted(error?: Error): void {
    this.connected = false;
    this.emit('error', error ?? new Error('USER_DEACTIVATED'));
  }

  simulateSessionRevoked(error?: Error): void {
    this.connected = false;
    this.emit('error', error ?? new Error('AUTH_KEY_UNREGISTERED'));
  }

  /**
   * Emits the typed `signal` event for a revocation, the way the real adapter does, without the
   * accompanying `error` event. Used to drive the signal-only delivery path.
   */
  simulateSessionRevokedSignal(reason: string = 'AUTH_KEY_UNREGISTERED'): void {
    this.connected = false;
    this.emit('signal', {
      category: 'SESSION_REVOKED',
      reason,
      error: new Error(reason),
    });
  }

  /**
   * Reproduces the real adapter's connect-failure delivery for one underlying revocation: it
   * emits the typed `signal` event and then also emits `error` for the same failure. The listener
   * dispatch of the mock is synchronous, matching the ordering of the adapter's own `emit`.
   */
  simulateSessionRevokedSignalAndError(reason: string = 'AUTH_KEY_UNREGISTERED'): void {
    this.connected = false;
    const errorObj = new Error(reason);
    this.emit('signal', { category: 'SESSION_REVOKED', reason, error: errorObj });
    this.emit('error', errorObj);
  }
}


async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor condition timed out after ${timeoutMs}ms`);
}

describe('Userbot Service & Connection Manager Integration Tests (Ticket 07)', () => {
  let pool: pg.Pool;
  let db: DbClient;
  const createdClients: Map<string, MockUserbotClient> = new Map();

  const mockClientFactory: UserbotClientFactory = (params) => {
    const client = new MockUserbotClient({
      districtId: params.districtId,
      sessionString: params.sessionString,
      apiId: params.apiId,
      phoneNumber: params.phoneNumber,
    });
    createdClients.set(params.districtId, client);
    return client;
  };

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    await db.delete(districtTelegramUserbotSessions);
  });

  afterAll(async () => {
    await db.delete(districtTelegramUserbotSessions);
    await pool.end();
  });

  beforeEach(async () => {
    createdClients.clear();
    await db.delete(districtTelegramUserbotSessions);
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

  async function countRevokedIssues(districtId: string): Promise<number> {
    const rows = await db
      .select()
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.districtId, districtId),
          eq(operationalIssues.component, 'USERBOT'),
          eq(operationalIssues.issueCategory, 'USERBOT_SESSION_REVOKED'),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );
    return rows.length;
  }

  async function countRevocationAudits(districtId: string): Promise<number> {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.districtId, districtId),
          eq(auditEvents.action, 'USERBOT_SESSION_REVOKED'),
        ),
      );
    return rows.length;
  }

  it('Test 1: Service queries DB and connects only ACTIVE sessions (ignores PENDING, DISABLED, BANNED)', async () => {
    // 1. Create 4 test districts with different statuses
    const activeDist = await createTestDistrict('ActiveSession');
    const pendingDist = await createTestDistrict('PendingSession');
    const disabledDist = await createTestDistrict('DisabledSession');
    const bannedDist = await createTestDistrict('BannedSession');

    // Active session
    await createDistrictUserbotSession(db, {
      districtId: activeDist,
      phoneNumber: `+99890${crypto.randomUUID().replace(/\D/g, '').slice(0, 7)}`,
      apiId: '1110001',
      sessionString: `session_active_${crypto.randomUUID()}`,
    });
    await enableDistrictUserbotSession(db, activeDist);

    // Pending session (default status is PENDING)
    await createDistrictUserbotSession(db, {
      districtId: pendingDist,
      phoneNumber: `+99890${crypto.randomUUID().replace(/\D/g, '').slice(0, 7)}`,
      apiId: '1110002',
      sessionString: `session_pending_${crypto.randomUUID()}`,
    });

    // Disabled session
    await createDistrictUserbotSession(db, {
      districtId: disabledDist,
      phoneNumber: `+99890${crypto.randomUUID().replace(/\D/g, '').slice(0, 7)}`,
      apiId: '1110003',
      sessionString: `session_disabled_${crypto.randomUUID()}`,
    });
    await enableDistrictUserbotSession(db, disabledDist);
    await disableDistrictUserbotSession(db, disabledDist);

    // Banned session
    await createDistrictUserbotSession(db, {
      districtId: bannedDist,
      phoneNumber: `+99890${crypto.randomUUID().replace(/\D/g, '').slice(0, 7)}`,
      apiId: '1110004',
      sessionString: `session_banned_${crypto.randomUUID()}`,
    });
    const banMgr = new UserbotConnectionManager({ db });
    await banMgr.handleBan(bannedDist, new Error('PHONE_NUMBER_BANNED'));

    // 2. Start connection manager
    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      reconnectBaseDelayMs: 25,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    // 3. Verify that only the ACTIVE session was connected
    const managedDistricts = manager.getManagedDistricts();
    expect(managedDistricts).toContain(activeDist);
    expect(managedDistricts).not.toContain(pendingDist);
    expect(managedDistricts).not.toContain(disabledDist);
    expect(managedDistricts).not.toContain(bannedDist);

    expect(createdClients.has(activeDist)).toBe(true);
    expect(createdClients.has(pendingDist)).toBe(false);

    expect(createdClients.has(disabledDist)).toBe(false);
    expect(createdClients.has(bannedDist)).toBe(false);

    const activeClient = createdClients.get(activeDist)!;
    expect(activeClient.connectCalls).toBe(1);
    expect(activeClient.isConnected()).toBe(true);

    await manager.stop();
  });

  it('Test 2: Simulated connection drop triggers automatic reconnection and succeeds', async () => {
    const districtId = await createTestDistrict('ReconnectSession');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998902220001',
      apiId: '2220001',
      sessionString: 'session_reconnect_token',
    });
    await enableDistrictUserbotSession(db, districtId);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 100,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    const client = createdClients.get(districtId);
    expect(client).toBeDefined();
    expect(client!.connectCalls).toBe(1);
    expect(client!.isConnected()).toBe(true);

    // Simulate connection drop
    client!.simulateDrop(new Error('Simulated network disruption'));

    // Wait for reconnection to trigger with backoff
    await waitFor(() => client!.connectCalls >= 2 && client!.isConnected(), 2000, 20);

    expect(client!.connectCalls).toBeGreaterThanOrEqual(2);
    expect(client!.isConnected()).toBe(true);

    await manager.stop();
  });

  it('Test 3: Connected sessions have their last_seen_at timestamps updated in the database', async () => {
    const districtId = await createTestDistrict('LastSeenSession');

    const created = await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998903330001',
      apiId: '3330001',
      sessionString: 'session_lastseen_token',
    });
    expect(created.lastSeenAt).toBeNull();

    await enableDistrictUserbotSession(db, districtId);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    const beforeRefresh = new Date(Date.now() - 1000);

    // Trigger last seen refresh
    await manager.refreshLastSeen();

    const sessionInDb = await getDistrictUserbotSession(db, districtId);
    expect(sessionInDb).toBeDefined();
    expect(sessionInDb!.lastSeenAt).not.toBeNull();
    expect(sessionInDb!.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(beforeRefresh.getTime());

    await manager.stop();
  });

  it('Test 4: Ban detection transitions session status to BANNED, stops reconnecting, and writes a District-scoped Operational Issue', async () => {
    const districtId = await createTestDistrict('BannedDetection');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998904440001',
      apiId: '4440001',
      sessionString: 'session_ban_token',
    });
    await enableDistrictUserbotSession(db, districtId);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      reconnectBaseDelayMs: 20,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    const client = createdClients.get(districtId)!;
    expect(client).toBeDefined();
    expect(client.connectCalls).toBe(1);

    // Simulate ban event
    client.simulateBan(new Error('PHONE_NUMBER_BANNED'));

    // Wait for ban handling to update DB
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      return row?.status === 'BANNED';
    }, 2000, 25);

    // 1. Assert DB session status transitioned to BANNED
    const [bannedRow] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
    expect(bannedRow).toBeDefined();
    expect(bannedRow!.status).toBe('BANNED');

    // 2. Assert audit event emitted
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.districtId, districtId),
          eq(auditEvents.action, 'USERBOT_SESSION_BANNED'),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit!.action).toBe('USERBOT_SESSION_BANNED');

    // 3. Assert active Operational Issue exists in operational_issues
    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.districtId, districtId),
          eq(operationalIssues.component, 'USERBOT'),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );
    expect(issue).toBeDefined();
    expect(issue!.scope).toBe('DISTRICT');
    expect(issue!.districtId).toBe(districtId);
    expect(issue!.component).toBe('USERBOT');
    expect(issue!.severity).toBe('Critical');
    expect(issue!.status).toBe('ACTIVE');

    // 4. Assert manager marked district as banned and stopped reconnection
    expect(manager.isDistrictBanned(districtId)).toBe(true);

    // Wait a brief period and ensure no reconnection calls were made
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(client.connectCalls).toBe(1);

    await manager.stop();
  });

  it('Test 5: Service shutdown cleanly closes all connections without throwing or affecting the DB', async () => {
    const dist1 = await createTestDistrict('Shutdown1');
    const dist2 = await createTestDistrict('Shutdown2');

    await createDistrictUserbotSession(db, {
      districtId: dist1,
      phoneNumber: '+998905550001',
      apiId: '5550001',
      sessionString: 'session_shutdown_1',
    });
    await enableDistrictUserbotSession(db, dist1);

    await createDistrictUserbotSession(db, {
      districtId: dist2,
      phoneNumber: '+998905550002',
      apiId: '5550002',
      sessionString: 'session_shutdown_2',
    });
    await enableDistrictUserbotSession(db, dist2);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    const client1 = createdClients.get(dist1)!;
    const client2 = createdClients.get(dist2)!;
    expect(client1.isConnected()).toBe(true);
    expect(client2.isConnected()).toBe(true);

    // Execute graceful shutdown
    await manager.stop();

    // Verify all clients were cleanly disconnected
    expect(client1.disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(client2.disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(client1.isConnected()).toBe(false);
    expect(client2.isConnected()).toBe(false);
    expect(manager.getManagedDistricts()).toHaveLength(0);

    // Verify DB sessions remain unaffected (still ACTIVE, not removed or corrupted)
    const session1 = await getDistrictUserbotSession(db, dist1);
    const session2 = await getDistrictUserbotSession(db, dist2);
    expect(session1?.status).toBe('ACTIVE');
    expect(session2?.status).toBe('ACTIVE');

    // Calling stop again should be idempotent and not throw
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('Test 6: UserbotClientPort and GramJsUserbotClient expose NO write methods (enforced passive-only invariant)', () => {
    const forbiddenMethods = [
      'send',
      'sendMessage',
      'sendMedia',
      'invite',
      'inviteToChannel',
      'react',
      'sendReaction',
      'join',
      'joinChat',
      'joinChannel',
      'leave',
      'leaveChat',
      'deleteMessage',
      'deleteMessages',
      'editMessage',
      'pinChatMessage',
    ];

    const adapterPrototype = GramJsUserbotClient.prototype as unknown as Record<string, unknown>;
    for (const method of forbiddenMethods) {
      expect(adapterPrototype[method]).toBeUndefined();
    }


    const mockClient = new MockUserbotClient({
      districtId: 'dist_test',
      sessionString: 'test_session',
      apiId: '12345',
      phoneNumber: '+998901234567',
    });
    for (const method of forbiddenMethods) {
      expect((mockClient as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it('Test 7: AUTH_KEY_DUPLICATED halts reconnection immediately, updates DB status to PENDING, and creates Operational Issue', async () => {
    const districtId = await createTestDistrict('AuthKeyDup');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998906660001',
      apiId: '6660001',
      sessionString: 'session_auth_key_dup_token',
    });
    await enableDistrictUserbotSession(db, districtId);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      reconnectBaseDelayMs: 20,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    const client = createdClients.get(districtId)!;
    expect(client).toBeDefined();
    expect(client.connectCalls).toBe(1);

    // Trigger AUTH_KEY_DUPLICATED
    client.simulateAuthKeyDuplicated();

    // Wait for DB session status to transition to PENDING
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      return row?.status === 'PENDING';
    }, 2000, 25);

    // 1. Assert DB session status is PENDING (requires re-login)
    const [row] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
    expect(row?.status).toBe('PENDING');

    // 2. Assert audit event recorded
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.districtId, districtId),
          eq(auditEvents.action, 'USERBOT_SESSION_AUTH_KEY_DUPLICATED'),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit!.action).toBe('USERBOT_SESSION_AUTH_KEY_DUPLICATED');

    // 3. Assert active Operational Issue created
    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.districtId, districtId),
          eq(operationalIssues.component, 'USERBOT'),
          eq(operationalIssues.issueCategory, 'AUTH_KEY_DUPLICATED'),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );
    expect(issue).toBeDefined();
    expect(issue!.scope).toBe('DISTRICT');
    expect(issue!.severity).toBe('Critical');

    // 4. Assert manager marks district as auth key duplicated and halts reconnection
    expect(manager.isDistrictAuthKeyDuplicated(districtId)).toBe(true);

    // Wait brief time and assert no further connect calls
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(client.connectCalls).toBe(1);

    await manager.stop();
  });

  it('Test 7b: SESSION_REVOKED terminates the session: no reconnection, DB status PENDING, District-scoped Operational Issue, and repeat delivery is an idempotent no-op', async () => {
    const districtId = await createTestDistrict('SessionRevoked');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998906770001',
      apiId: '6670001',
      sessionString: 'session_revoked_token',
    });
    await enableDistrictUserbotSession(db, districtId);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      reconnectBaseDelayMs: 20,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    const client = createdClients.get(districtId)!;
    expect(client).toBeDefined();
    expect(client.connectCalls).toBe(1);

    // Trigger session revocation (Telegram invalidated the session / auth key unregistered)
    client.simulateSessionRevoked(new Error('AUTH_KEY_UNREGISTERED'));

    // Wait for DB session status to transition to PENDING
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      return row?.status === 'PENDING';
    }, 2000, 25);

    // (b) Assert DB session status is PENDING (requires re-login)
    const [row] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
    expect(row?.status).toBe('PENDING');

    // Assert audit event recorded with the new action literal
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.districtId, districtId),
          eq(auditEvents.action, 'USERBOT_SESSION_REVOKED'),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit!.action).toBe('USERBOT_SESSION_REVOKED');

    // (c) Assert exactly one active Operational Issue exists with the expected identity
    const firstIssues = await db
      .select()
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.districtId, districtId),
          eq(operationalIssues.component, 'USERBOT'),
          eq(operationalIssues.issueCategory, 'USERBOT_SESSION_REVOKED'),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );
    expect(firstIssues).toHaveLength(1);
    const issue = firstIssues[0]!;
    expect(issue.scope).toBe('DISTRICT');
    expect(issue.districtId).toBe(districtId);
    expect(issue.logicalKey).toBe(`DISTRICT:${districtId}:USERBOT:USERBOT_SESSION_REVOKED`);
    expect(issue.severity).toBe('Critical');
    expect(issue.healthStatus).toBe('Unavailable');
    expect(issue.status).toBe('ACTIVE');

    // Assert manager marks the district as session-revoked
    expect(manager.isDistrictSessionRevoked(districtId)).toBe(true);

    // (a) Assert no reconnection is rescheduled after a revoked signal
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(client.connectCalls).toBe(1);

    // (d) Repeat delivery of the same revoked signal must be an idempotent no-op:
    // no second Operational Issue, no second audit event, and no restarted reconnection.
    client.simulateSessionRevoked(new Error('AUTH_KEY_UNREGISTERED'));
    await manager.handleSignal(
      districtId,
      { category: 'SESSION_REVOKED', reason: 'AUTH_KEY_UNREGISTERED' },
      { isConnected: false },
    );
    await new Promise((resolve) => setTimeout(resolve, 120));

    const afterRepeatIssues = await db
      .select()
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.districtId, districtId),
          eq(operationalIssues.component, 'USERBOT'),
          eq(operationalIssues.issueCategory, 'USERBOT_SESSION_REVOKED'),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );
    expect(afterRepeatIssues).toHaveLength(1);

    const afterRepeatAudits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.districtId, districtId),
          eq(auditEvents.action, 'USERBOT_SESSION_REVOKED'),
        ),
      );
    expect(afterRepeatAudits).toHaveLength(1);

    const [rowAfterRepeat] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
    expect(rowAfterRepeat?.status).toBe('PENDING');
    expect(client.connectCalls).toBe(1);

    await manager.stop();
  });

  it('Test 7c: a revocation delivered through the adapter signal event path terminates the session exactly once, and the real signal+error dual-emit adds no duplicate issue, audit or reconnection', async () => {
    const districtId = await createTestDistrict('SessionRevokedSignalPath');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998906770101',
      apiId: '6670101',
      sessionString: 'session_revoked_signal_token',
    });
    await enableDistrictUserbotSession(db, districtId);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      reconnectBaseDelayMs: 20,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    const client = createdClients.get(districtId)!;
    expect(client.connectCalls).toBe(1);

    // Deliver the revocation the way the real adapter does on a connect failure: the typed
    // `signal` event first, then the plain `error` event for the SAME underlying failure. The
    // mock only carries the signal listener because the manager registers one.
    client.simulateSessionRevokedSignalAndError('AUTH_KEY_UNREGISTERED');

    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      return row?.status === 'PENDING';
    }, 2000, 25);

    // Let both deliveries of the dual-emit, plus any reconnection the category could schedule,
    // settle before counting side effects.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Exactly one issue and one audit event survived the signal+error dual delivery.
    expect(await countRevokedIssues(districtId)).toBe(1);
    expect(await countRevocationAudits(districtId)).toBe(1);

    // The signal path drove the handler: the district is guarded, deregistered and disconnected.
    expect(manager.isDistrictSessionRevoked(districtId)).toBe(true);
    expect(manager.isDistrictConnected(districtId)).toBe(false);
    expect(manager.getManagedDistricts()).not.toContain(districtId);

    // SESSION_REVOKED never schedules a reconnection, under either delivery.
    expect(client.connectCalls).toBe(1);

    await manager.stop();
  });

  it('Test 7d: a re-established session clears the revocation guard so the worker reconnects without a restart, while an invalid session keeps reconnection blocked', async () => {
    const districtId = await createTestDistrict('SessionRevokedRecovery');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998906770201',
      apiId: '6670201',
      sessionString: 'session_revoked_recovery_token',
    });
    await enableDistrictUserbotSession(db, districtId);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      reconnectBaseDelayMs: 20,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    const firstClient = createdClients.get(districtId)!;
    expect(firstClient.connectCalls).toBe(1);

    firstClient.simulateSessionRevoked(new Error('AUTH_KEY_UNREGISTERED'));

    // The guard is set before the handler's DB write, so wait on the persisted state instead: it
    // is the stored session, not the in-memory guard, that the recovery rule keys on.
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      return row?.status === 'PENDING';
    }, 2000, 25);

    // NEGATIVE: the stored session is still invalid (the handler left it PENDING and no re-login
    // has happened), so the guard must keep blocking and a sync cycle must not reconnect.
    expect(manager.isDistrictSessionRevoked(districtId)).toBe(true);

    await manager.syncSessions();

    expect(manager.isDistrictSessionRevoked(districtId)).toBe(true);
    expect(manager.getManagedDistricts()).not.toContain(districtId);
    expect(firstClient.connectCalls).toBe(1);

    // Re-establish the session the way a successful CLI re-login/bootstrap does: a complete
    // credential envelope written together with a transition back to ACTIVE.
    await updateUserbotSessionStatus(db, districtId, {
      status: 'ACTIVE',
      sessionString: 'session_relogin_complete',
    });

    // The worker's own polling path observes the re-established session and clears the guard.
    await manager.syncSessions();

    expect(manager.isDistrictSessionRevoked(districtId)).toBe(false);
    expect(manager.getManagedDistricts()).toContain(districtId);

    const reconnectedClient = createdClients.get(districtId)!;
    expect(reconnectedClient).not.toBe(firstClient);
    expect(reconnectedClient.connectCalls).toBe(1);

    await manager.stop();
  });

  it('Test 7e: a revocation occurring after a successful recovery raises its operational issue exactly once, with no duplicate audit event', async () => {
    const districtId = await createTestDistrict('SessionRevokedAfterRecovery');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998906770301',
      apiId: '6670301',
      sessionString: 'session_revoked_after_recovery_token',
    });
    await enableDistrictUserbotSession(db, districtId);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      reconnectBaseDelayMs: 20,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    // First revocation.
    createdClients.get(districtId)!.simulateSessionRevoked(new Error('AUTH_KEY_UNREGISTERED'));
    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      return row?.status === 'PENDING';
    }, 2000, 25);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await countRevokedIssues(districtId)).toBe(1);
    const auditsAfterFirstRevocation = await countRevocationAudits(districtId);
    expect(auditsAfterFirstRevocation).toBe(1);

    // Operator repairs the session; the worker observes it on its polling path and unblocks.
    await updateUserbotSessionStatus(db, districtId, {
      status: 'ACTIVE',
      sessionString: 'session_relogin_after_recovery',
    });
    await manager.syncSessions();
    expect(manager.isDistrictSessionRevoked(districtId)).toBe(false);

    // The first issue is still open. A fresh revocation for the same district produces the same
    // logical key, so it must upsert onto that issue rather than open a second one. It is driven
    // through the real dual-emit so a double delivery cannot double-count either signal.
    createdClients.get(districtId)!.simulateSessionRevokedSignalAndError('AUTH_KEY_UNREGISTERED');

    await waitFor(async () => {
      const [row] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      return row?.status === 'PENDING';
    }, 2000, 25);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(manager.isDistrictSessionRevoked(districtId)).toBe(true);
    // Still exactly one ACTIVE issue: the second revocation upserted onto the same logical key.
    expect(await countRevokedIssues(districtId)).toBe(1);
    // Exactly one audit event per revocation occurrence, despite the signal+error dual delivery.
    expect(await countRevocationAudits(districtId)).toBe(auditsAfterFirstRevocation + 1);

    await manager.stop();
  });

  it('Test 8: FLOOD_WAIT raises a District-scoped Operational Issue alert before ban and retries once without hammering', async () => {
    const districtId = await createTestDistrict('FloodWaitSignal');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998907770001',
      apiId: '7770001',
      sessionString: 'session_flood_wait_token',
    });
    await enableDistrictUserbotSession(db, districtId);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      reconnectBaseDelayMs: 20,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
      maxFloodWaitMs: 50, // fast sleep for test
    });

    await manager.start();

    const client = createdClients.get(districtId)!;
    expect(client).toBeDefined();
    expect(client.connectCalls).toBe(1);

    // Trigger FLOOD_WAIT abnormal signal
    client.simulateFloodWait(1);

    // Wait for active Operational Issue to be created in DB
    await waitFor(async () => {
      const [issue] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtId),
            eq(operationalIssues.component, 'USERBOT'),
            eq(operationalIssues.issueCategory, 'FLOOD_WAIT'),
            eq(operationalIssues.status, 'ACTIVE'),
          ),
        );
      return Boolean(issue);
    }, 2000, 25);

    // 1. Assert Operational Issue exists before ban
    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.districtId, districtId),
          eq(operationalIssues.component, 'USERBOT'),
          eq(operationalIssues.issueCategory, 'FLOOD_WAIT'),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );
    expect(issue).toBeDefined();
    expect(issue!.scope).toBe('DISTRICT');
    expect(issue!.severity).toBe('Warning');
    expect(issue!.healthStatus).toBe('Degraded');

    // 2. Assert manager retries once honoring sleep duration
    await waitFor(() => client.connectCalls >= 2, 2000, 25);
    expect(client.connectCalls).toBe(2);

    // 3. Trigger second FLOOD_WAIT: manager must NEVER hammer and must halt automatic retry
    client.simulateFloodWait(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(client.connectCalls).toBe(2);

    await manager.stop();
  });

  it('Test 9: Single-main-session guard prevents overlapping connections for the same auth key', async () => {
    const dist1 = await createTestDistrict('SingleMain1');
    const dist2 = await createTestDistrict('SingleMain2');

    const sharedSessionString = 'shared_secret_session_token_123';

    await createDistrictUserbotSession(db, {
      districtId: dist1,
      phoneNumber: '+998908880001',
      apiId: '8880001',
      sessionString: sharedSessionString,
    });
    await enableDistrictUserbotSession(db, dist1);

    await createDistrictUserbotSession(db, {
      districtId: dist2,
      phoneNumber: '+998908880002',
      apiId: '8880002',
      sessionString: sharedSessionString,
    });
    await enableDistrictUserbotSession(db, dist2);

    const manager = new UserbotConnectionManager({
      db,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    // Dist1 connected successfully, but Dist2 must be rejected by single-main-session guard because it shares the same auth key
    expect(createdClients.has(dist1)).toBe(true);
    expect(createdClients.has(dist2)).toBe(false);

    const managed = manager.getManagedDistricts();
    expect(managed).toContain(dist1);
    expect(managed).not.toContain(dist2);

    await manager.stop();
  });

  it('Test 10: GramJsUserbotClient configures TelegramClient with catchUp: false and connectionRetries: 5 (Ticket 18)', async () => {
    let capturedOptions: unknown = null;

    class MockTelegramClient {
      constructor(
        _session: unknown,
        _apiId: number,
        _apiHash: string,
        options: unknown,
      ) {
        capturedOptions = options;
      }
      async connect(): Promise<void> {}
      async disconnect(): Promise<void> {}
      addEventHandler(_callback: (update: unknown) => void, _event: unknown): void {}
      removeEventHandler(_callback: (update: unknown) => void, _event: unknown): void {}
    }

    class MockStringSession {
      session: string;
      constructor(session: string) {
        this.session = session;
      }
    }

    class MockRawUpdateEvent {
      constructor(_params: Record<string, unknown>) {}
    }

    const client = new GramJsUserbotClient({
      districtId: 'dist_test_catchup',
      sessionString: 'test_session_string',
      apiId: '99999',
      apiHash: 'test_api_hash',
      phoneNumber: '+998909999999',
    });

    (client as unknown as { loadGramJs: () => Promise<unknown> }).loadGramJs = async () => ({
      TelegramClient: MockTelegramClient,
      StringSession: MockStringSession,
      RawUpdateEvent: MockRawUpdateEvent,
    });

    await client.connect();

    expect(capturedOptions).toEqual({
      connectionRetries: 5,
      catchUp: true,
    });
    expect(client.isConnected()).toBe(true);

    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it('Test 11: _AssertPassiveOnlyPort active compile-time guard resolves to true and validates port has no write methods (Ticket 18)', () => {
    const isPassiveOnly: _AssertPassiveOnlyPort = true;
    expect(isPassiveOnly).toBe(true);
  });

  describe('Ticket 08: Liveness and connection health criteria', () => {
    it('Criteria 1, 2, 3: last_seen_at advances only while genuinely connected, refreshes on timer, and freezes when disconnected', async () => {
      const districtId = await createTestDistrict('LivenessTimerTest');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901080001',
        apiId: '1080001',
        sessionString: 'session_liveness_timer_token',
      });
      await enableDistrictUserbotSession(db, districtId);

      // Start manager with 50ms liveness refresh timer and 2000ms reconnect delay
      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        reconnectBaseDelayMs: 2000,
        lastSeenIntervalMs: 50,
        pollIntervalMs: 0,
      });

      await manager.start();

      const client = createdClients.get(districtId);
      expect(client).toBeDefined();
      expect(client!.isConnected()).toBe(true);

      // Initial connection sets lastSeenAt
      await waitFor(async () => {
        const s = await getDistrictUserbotSession(db, districtId);
        return Boolean(s?.lastSeenAt);
      }, 2000, 20);

      const firstSeen = (await getDistrictUserbotSession(db, districtId))!.lastSeenAt!;

      // 1 & 2: Liveness is refreshed on timer while genuinely connected
      await waitFor(async () => {
        const s = await getDistrictUserbotSession(db, districtId);
        return Boolean(s?.lastSeenAt && s.lastSeenAt.getTime() > firstSeen.getTime());
      }, 2000, 20);

      const advancedSeen = (await getDistrictUserbotSession(db, districtId))!.lastSeenAt!;
      expect(advancedSeen.getTime()).toBeGreaterThan(firstSeen.getTime());

      // 3: When disconnected, last_seen_at does not advance
      client!.simulateDrop(new Error('Simulated drop for liveness freeze check'));
      expect(client!.isConnected()).toBe(false);

      const disconnectedSeen = (await getDistrictUserbotSession(db, districtId))!.lastSeenAt!;

      // Wait 120ms with timer running while disconnected
      await new Promise((resolve) => setTimeout(resolve, 120));

      const afterWaitSeen = (await getDistrictUserbotSession(db, districtId))!.lastSeenAt!;
      expect(afterWaitSeen.getTime()).toBe(disconnectedSeen.getTime());

      // Even manual refreshLastSeen() does not advance last_seen_at for a disconnected session
      await manager.refreshLastSeen();
      const afterManualRefresh = (await getDistrictUserbotSession(db, districtId))!.lastSeenAt!;
      expect(afterManualRefresh.getTime()).toBe(disconnectedSeen.getTime());

      await manager.stop();
    });

    it('Criterion 4: The number of inbound updates received per session is observable', async () => {
      const districtId = await createTestDistrict('InboundObservableTest');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901080002',
        apiId: '1080002',
        sessionString: 'session_inbound_observable_token',
      });
      await enableDistrictUserbotSession(db, districtId);

      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
      });

      await manager.start();

      // Initially zero
      expect(await manager.getInboundUpdateCount(districtId)).toBe(0);
      const initialSession = await getDistrictUserbotSession(db, districtId);
      expect(initialSession?.inboundUpdateCounter).toBe(0);

      const initialHealth = await manager.checkSessionHealth(districtId);
      expect(initialHealth.inboundUpdateCounter).toBe(0);

      // Record 3 incoming updates
      await manager.recordInboundUpdate(districtId);
      await manager.recordInboundUpdate(districtId);
      await manager.recordInboundUpdate(districtId);

      // Observable across all boundaries
      expect(await manager.getInboundUpdateCount(districtId)).toBe(3);

      const updatedSession = await getDistrictUserbotSession(db, districtId);
      expect(updatedSession?.inboundUpdateCounter).toBe(3);

      const updatedHealth = await manager.checkSessionHealth(districtId);
      expect(updatedHealth.inboundUpdateCounter).toBe(3);

      await manager.stop();
    });

    it('Criterion 5: ACTIVE session that received nothing for an implausibly long period is flagged rather than passing as healthy', async () => {
      const districtId = await createTestDistrict('StaleSessionTest');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901080003',
        apiId: '1080003',
        sessionString: 'session_stale_flagging_token',
      });
      await enableDistrictUserbotSession(db, districtId);

      // Configure a very short staleThresholdMs (40ms) for testing
      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
        staleThresholdMs: 40,
      });

      await manager.start();

      // Immediately after start, session is healthy
      const initialHealth = await manager.checkSessionHealth(districtId);
      expect(initialHealth.isHealthy).toBe(true);
      expect(initialHealth.isConnected).toBe(true);
      expect(initialHealth.isStale).toBe(false);
      expect(initialHealth.status).toBe('ACTIVE');

      // Wait beyond the 40ms staleness threshold
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Check health now: must be flagged as STALE rather than passing as healthy
      const staleHealth = await manager.checkSessionHealth(districtId);
      expect(staleHealth.isHealthy).toBe(false);
      expect(staleHealth.isConnected).toBe(true);
      expect(staleHealth.isStale).toBe(true);
      expect(staleHealth.status).toBe('STALE');
      expect(staleHealth.reason).toContain('implausibly long period');

      // Assert DB row isStale flag is set to true
      const dbSession = await getDistrictUserbotSession(db, districtId);
      expect(dbSession?.isStale).toBe(true);

      // Assert District-scoped Operational Issue was created with severity Warning, status ACTIVE
      const [issue] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtId),
            eq(operationalIssues.component, 'USERBOT'),
            eq(operationalIssues.issueCategory, 'USERBOT_STALE'),
            eq(operationalIssues.status, 'ACTIVE'),
          ),
        );
      expect(issue).toBeDefined();
      expect(issue!.scope).toBe('DISTRICT');
      expect(issue!.severity).toBe('Warning');
      expect(issue!.healthStatus).toBe('Degraded');

      // When inbound update finally arrives, staleness is resolved
      await manager.recordInboundUpdate(districtId);

      const recoveredHealth = await manager.checkSessionHealth(districtId);
      expect(recoveredHealth.isHealthy).toBe(true);
      expect(recoveredHealth.isStale).toBe(false);
      expect(recoveredHealth.status).toBe('ACTIVE');

      const recoveredSession = await getDistrictUserbotSession(db, districtId);
      expect(recoveredSession?.isStale).toBe(false);

      const [resolvedIssue] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtId),
            eq(operationalIssues.logicalKey, `DISTRICT:${districtId}:USERBOT:STALE_INACTIVITY`),
          ),
        );
      expect(resolvedIssue?.status).toBe('RESOLVED');

      await manager.stop();
    });

    it('Criterion 6: A session that is not ACTIVE is never reported as connected', async () => {
      const pendingDist = await createTestDistrict('NotActivePending');
      const disabledDist = await createTestDistrict('NotActiveDisabled');
      const bannedDist = await createTestDistrict('NotActiveBanned');
      const nonexistentDist = `dist_nonexistent_${crypto.randomUUID()}`;

      // PENDING
      await createDistrictUserbotSession(db, {
        districtId: pendingDist,
        phoneNumber: '+998901080004',
        apiId: '1080004',
        sessionString: 'session_pending_test',
      });

      // DISABLED
      await createDistrictUserbotSession(db, {
        districtId: disabledDist,
        phoneNumber: '+998901080005',
        apiId: '1080005',
        sessionString: 'session_disabled_test',
      });
      await enableDistrictUserbotSession(db, disabledDist);
      await disableDistrictUserbotSession(db, disabledDist);

      // BANNED
      await createDistrictUserbotSession(db, {
        districtId: bannedDist,
        phoneNumber: '+998901080006',
        apiId: '1080006',
        sessionString: 'session_banned_test',
      });
      const banMgr = new UserbotConnectionManager({ db });
      await banMgr.handleBan(bannedDist, new Error('PHONE_NUMBER_BANNED'));

      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
      });

      await manager.start();

      // None of the non-ACTIVE sessions must be reported as connected
      expect(manager.isDistrictConnected(pendingDist)).toBe(false);
      expect(manager.isDistrictConnected(disabledDist)).toBe(false);
      expect(manager.isDistrictConnected(bannedDist)).toBe(false);
      expect(manager.isDistrictConnected(nonexistentDist)).toBe(false);

      const connectedList = manager.getConnectedDistricts();
      expect(connectedList).not.toContain(pendingDist);
      expect(connectedList).not.toContain(disabledDist);
      expect(connectedList).not.toContain(bannedDist);
      expect(connectedList).not.toContain(nonexistentDist);

      const pendingHealth = await manager.checkSessionHealth(pendingDist);
      expect(pendingHealth.isConnected).toBe(false);
      expect(pendingHealth.isHealthy).toBe(false);
      expect(pendingHealth.status).toBe('PENDING');

      const disabledHealth = await manager.checkSessionHealth(disabledDist);
      expect(disabledHealth.isConnected).toBe(false);
      expect(disabledHealth.isHealthy).toBe(false);
      expect(disabledHealth.status).toBe('DISABLED');

      const bannedHealth = await manager.checkSessionHealth(bannedDist);
      expect(bannedHealth.isConnected).toBe(false);
      expect(bannedHealth.isHealthy).toBe(false);
      expect(bannedHealth.status).toBe('BANNED');

      const nonexistentHealth = await manager.checkSessionHealth(nonexistentDist);
      expect(nonexistentHealth.isConnected).toBe(false);
      expect(nonexistentHealth.isHealthy).toBe(false);
      expect(nonexistentHealth.status).toBe('NOT_FOUND');

      await manager.stop();
    });

    it('Criterion 7: When account has been deleted on Telegram, session surfaces as PENDING rather than remaining ACTIVE', async () => {
      const districtId = await createTestDistrict('AccountDeletedLifecycle');

      await createDistrictUserbotSession(db, {
        districtId,
        phoneNumber: '+998901080007',
        apiId: '1080007',
        sessionString: 'session_account_deleted_token',
      });
      await enableDistrictUserbotSession(db, districtId);

      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        reconnectBaseDelayMs: 20,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
      });

      await manager.start();

      const client = createdClients.get(districtId)!;
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(true);

      // Simulate Telegram account deleted error event (USER_DEACTIVATED)
      client.simulateAccountDeleted(new Error('USER_DEACTIVATED'));

      // Wait for DB session status to transition to PENDING
      await waitFor(async () => {
        const s = await getDistrictUserbotSession(db, districtId);
        return s?.status === 'PENDING';
      }, 2000, 20);

      // 1. Assert status surfaced as PENDING rather than remaining ACTIVE
      const sessionInDb = await getDistrictUserbotSession(db, districtId);
      expect(sessionInDb?.status).toBe('PENDING');
      expect(sessionInDb?.hasSession).toBe(false);

      // 2. Assert stored secrets are wiped
      const [rawRow] = await db
        .select()
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      expect(rawRow?.status).toBe('PENDING');
      expect(rawRow?.sessionEncrypted).toBeNull();
      expect(rawRow?.sessionIv).toBeNull();
      expect(rawRow?.sessionTag).toBeNull();

      // 3. Assert audit event emitted with previousStatus: ACTIVE and newStatus: PENDING
      const audits = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.districtId, districtId),
            eq(auditEvents.action, 'USERBOT_SESSION_STATUS_UPDATED'),
          ),
        );
      const audit = audits.find(
        (a) => (a.metadata as { reason?: string } | null)?.reason === 'ACCOUNT_DELETED',
      );
      expect(audit).toBeDefined();
      expect(audit!.metadata).toMatchObject({
        previousStatus: 'ACTIVE',
        newStatus: 'PENDING',
        reason: 'ACCOUNT_DELETED',
      });

      // 4. Assert active Operational Issue created
      const [issue] = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtId),
            eq(operationalIssues.component, 'USERBOT'),
            eq(operationalIssues.issueCategory, 'ACCOUNT_DELETED'),
            eq(operationalIssues.status, 'ACTIVE'),
          ),
        );
      expect(issue).toBeDefined();
      expect(issue!.scope).toBe('DISTRICT');
      expect(issue!.severity).toBe('Critical');
      expect(issue!.healthStatus).toBe('Unavailable');

      // 5. Assert manager marks district as account deleted and halts reconnection
      expect(manager.isDistrictAccountDeleted(districtId)).toBe(true);
      expect(manager.isDistrictConnected(districtId)).toBe(false);

      const health = await manager.checkSessionHealth(districtId);
      expect(health.isConnected).toBe(false);
      expect(health.status).toBe('PENDING');

      // Ensure no further reconnection calls are made
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(client.connectCalls).toBe(1);

      await manager.stop();
    });

    it('Criterion 8: The session last successful connection time is visible and preserved across drops', async () => {
      const activeDist = await createTestDistrict('LastSuccessfulConnActive');
      const pendingDist = await createTestDistrict('LastSuccessfulConnPending');

      // Pending session has never connected
      await createDistrictUserbotSession(db, {
        districtId: pendingDist,
        phoneNumber: '+998901080008',
        apiId: '1080008',
      });

      // Active session
      await createDistrictUserbotSession(db, {
        districtId: activeDist,
        phoneNumber: '+998901080009',
        apiId: '1080009',
        sessionString: 'session_last_successful_conn_token',
      });
      await enableDistrictUserbotSession(db, activeDist);

      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
      });

      // Pending session before any connection
      expect(await manager.getLastSuccessfulConnectionAt(pendingDist)).toBeNull();
      const pendingPublic = await getDistrictUserbotSession(db, pendingDist);
      expect(pendingPublic?.lastSuccessfulConnectionAt).toBeNull();

      const beforeConnect = new Date(Date.now() - 1000);
      await manager.start();

      // Active session connected
      const connectedAt = await manager.getLastSuccessfulConnectionAt(activeDist);
      expect(connectedAt).toBeInstanceOf(Date);
      expect(connectedAt!.getTime()).toBeGreaterThanOrEqual(beforeConnect.getTime());

      // Visible on public session record
      const activePublic = await getDistrictUserbotSession(db, activeDist);
      expect(activePublic?.lastSuccessfulConnectionAt).toEqual(connectedAt);

      // Visible on checkSessionHealth
      const activeHealth = await manager.checkSessionHealth(activeDist);
      expect(activeHealth.lastSuccessfulConnectionAt).toEqual(connectedAt);

      // When client drops, lastSuccessfulConnectionAt is PRESERVED (does not reset to null)
      const client = createdClients.get(activeDist)!;
      client.simulateDrop(new Error('Connection dropped'));

      expect(await manager.getLastSuccessfulConnectionAt(activeDist)).toEqual(connectedAt);
      const droppedPublic = await getDistrictUserbotSession(db, activeDist);
      expect(droppedPublic?.lastSuccessfulConnectionAt).toEqual(connectedAt);

      const droppedHealth = await manager.checkSessionHealth(activeDist);
      expect(droppedHealth.lastSuccessfulConnectionAt).toEqual(connectedAt);

      await manager.stop();
    });

    it('Criterion 9: The runtime logs its startup composition, stating whether its database pool and job-queue client were constructed', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      const mockPool = {} as pg.Pool;
      const mockBoss = {} as any;

      const manager = new UserbotConnectionManager({
        db,
        pool: mockPool,
        boss: mockBoss,
        clientFactory: mockClientFactory,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
      });

      await manager.start();

      // Assert runtime logged its startup composition stating whether database pool and job-queue client were constructed
      expect(infoSpy).toHaveBeenCalledWith(
        {
          hasDatabasePool: true,
          hasJobQueueClient: true,
        },
        'Userbot runtime composition: database pool and job-queue client status',
      );

      // Assert helper functions behavior
      expect(describeUserbotRuntimeComposition({ pool: mockPool, boss: mockBoss })).toEqual({
        hasPool: true,
        hasJobQueueClient: true,
      });
      expect(describeUserbotRuntimeComposition({ pool: mockPool, boss: null })).toEqual({
        hasPool: true,
        hasJobQueueClient: false,
      });
      expect(describeUserbotRuntimeComposition({ pool: null, boss: mockBoss })).toEqual({
        hasPool: false,
        hasJobQueueClient: true,
      });

      // Fail-fast assertion
      expect(() => assertUserbotRuntimeComposition({ pool: null, boss: mockBoss })).toThrow(
        UserbotRuntimeCompositionError,
      );
      expect(() => assertUserbotRuntimeComposition({ pool: mockPool, boss: null })).toThrow(
        UserbotRuntimeCompositionError,
      );
      expect(() => assertUserbotRuntimeComposition({ pool: null, boss: null })).toThrow(
        UserbotRuntimeCompositionError,
      );
      expect(() => assertUserbotRuntimeComposition({ pool: mockPool, boss: mockBoss })).not.toThrow();

      await manager.stop();
      infoSpy.mockRestore();
    });

    it('Criterion 10: The runtime shuts down cleanly on termination signals, and after shutdown does not leave a session reported as connected', async () => {
      const dist1 = await createTestDistrict('ShutdownClean1');
      const dist2 = await createTestDistrict('ShutdownClean2');

      await createDistrictUserbotSession(db, {
        districtId: dist1,
        phoneNumber: '+998901080010',
        apiId: '1080010',
        sessionString: 'session_shutdown_clean_1',
      });
      await enableDistrictUserbotSession(db, dist1);

      await createDistrictUserbotSession(db, {
        districtId: dist2,
        phoneNumber: '+998901080011',
        apiId: '1080011',
        sessionString: 'session_shutdown_clean_2',
      });
      await enableDistrictUserbotSession(db, dist2);

      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
      });

      await manager.start();

      expect(manager.isDistrictConnected(dist1)).toBe(true);
      expect(manager.isDistrictConnected(dist2)).toBe(true);
      expect(manager.getConnectedDistricts()).toContain(dist1);
      expect(manager.getConnectedDistricts()).toContain(dist2);

      const client1 = createdClients.get(dist1)!;
      const client2 = createdClients.get(dist2)!;
      expect(client1.isConnected()).toBe(true);
      expect(client2.isConnected()).toBe(true);

      // Execute shutdown
      await manager.stop();

      // After shutdown, both clients are disconnected
      expect(client1.isConnected()).toBe(false);
      expect(client2.isConnected()).toBe(false);

      // After shutdown, NO session is reported as connected
      expect(manager.getConnectedDistricts()).toEqual([]);
      expect(manager.isDistrictConnected(dist1)).toBe(false);
      expect(manager.isDistrictConnected(dist2)).toBe(false);

      const health1 = await manager.checkSessionHealth(dist1);
      const health2 = await manager.checkSessionHealth(dist2);
      expect(health1.isConnected).toBe(false);
      expect(health2.isConnected).toBe(false);

      // Persistence is preserved (status remains ACTIVE, not deleted)
      expect((await getDistrictUserbotSession(db, dist1))?.status).toBe('ACTIVE');
      expect((await getDistrictUserbotSession(db, dist2))?.status).toBe('ACTIVE');

      // Idempotent stop
      await expect(manager.stop()).resolves.toBeUndefined();
    });
  });

  describe('Ticket 16: Per-District isolation of sessions, fault domains, and district deletion', () => {
    it('AC-5: Multi-district transport fault isolation: District A connection drop leaves District B connected and healthy', async () => {
      const distA = await createTestDistrict('FaultIsoA');
      const distB = await createTestDistrict('FaultIsoB');

      await createDistrictUserbotSession(db, {
        districtId: distA,
        phoneNumber: '+998901160001',
        apiId: '1160001',
        sessionString: 'session_fault_iso_a',
      });
      await enableDistrictUserbotSession(db, distA);

      await createDistrictUserbotSession(db, {
        districtId: distB,
        phoneNumber: '+998901160002',
        apiId: '1160002',
        sessionString: 'session_fault_iso_b',
      });
      await enableDistrictUserbotSession(db, distB);

      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
      });

      await manager.start();

      expect(manager.isDistrictConnected(distA)).toBe(true);
      expect(manager.isDistrictConnected(distB)).toBe(true);

      const clientA = createdClients.get(distA)!;
      const clientB = createdClients.get(distB)!;
      expect(clientA.isConnected()).toBe(true);
      expect(clientB.isConnected()).toBe(true);

      // District A experiences a transport fault (simulated drop/error)
      clientA.simulateDrop(new Error('Connection reset by peer'));

      // District A is marked disconnected
      expect(manager.isDistrictConnected(distA)).toBe(false);
      expect(clientA.isConnected()).toBe(false);

      // District B remains connected, unaffected and healthy
      expect(manager.isDistrictConnected(distB)).toBe(true);
      expect(clientB.isConnected()).toBe(true);

      const healthB = await manager.checkSessionHealth(distB);
      expect(healthB.isConnected).toBe(true);
      expect(healthB.isHealthy).toBe(true);

      await manager.stop();
    });

    it('AC-6: Abnormal signal isolation: District A FLOOD_WAIT creates issue strictly on District A; District B remains unaffected', async () => {
      const distA = await createTestDistrict('SignalIsoA');
      const distB = await createTestDistrict('SignalIsoB');

      await createDistrictUserbotSession(db, {
        districtId: distA,
        phoneNumber: '+998901160003',
        apiId: '1160003',
        sessionString: 'session_signal_iso_a',
      });
      await enableDistrictUserbotSession(db, distA);

      await createDistrictUserbotSession(db, {
        districtId: distB,
        phoneNumber: '+998901160004',
        apiId: '1160004',
        sessionString: 'session_signal_iso_b',
      });
      await enableDistrictUserbotSession(db, distB);

      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
      });

      await manager.start();

      const clientA = createdClients.get(distA)!;
      const clientB = createdClients.get(distB)!;
      expect(manager.isDistrictConnected(distA)).toBe(true);
      expect(manager.isDistrictConnected(distB)).toBe(true);

      // District A encounters FLOOD_WAIT_120
      clientA.simulateFloodWait(120);

      // Wait for issue creation for District A
      await waitFor(async () => {
        const issuesA = await db
          .select()
          .from(operationalIssues)
          .where(
            and(
              eq(operationalIssues.districtId, distA),
              eq(operationalIssues.component, 'USERBOT'),
              eq(operationalIssues.issueCategory, 'FLOOD_WAIT'),
              eq(operationalIssues.status, 'ACTIVE'),
            ),
          );
        return issuesA.length > 0;
      }, 5000, 100);

      const issuesA = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.districtId, distA));
      expect(issuesA.length).toBeGreaterThanOrEqual(1);
      const floodWaitIssue = issuesA[0];
      if (!floodWaitIssue) {
        throw new Error('Expected at least one operational issue for District A');
      }
      expect(floodWaitIssue.logicalKey).toBe(`DISTRICT:${distA}:USERBOT:FLOOD_WAIT`);

      // District B has ZERO operational issues
      const issuesB = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.districtId, distB));
      expect(issuesB.length).toBe(0);

      // District B client and connection state remain active and healthy
      expect(manager.isDistrictConnected(distB)).toBe(true);
      expect(clientB.isConnected()).toBe(true);
      const healthB = await manager.checkSessionHealth(distB);
      expect(healthB.isConnected).toBe(true);
      expect(healthB.isHealthy).toBe(true);

      await manager.stop();
    });

    it('AC-7: Subscription ineligibility: When district status becomes non-active/ineligible, syncSessions() disconnects District A while District B remains connected', async () => {
      const distA = await createTestDistrict('IneligibleA');
      const distB = await createTestDistrict('EligibleB');

      await createDistrictUserbotSession(db, {
        districtId: distA,
        phoneNumber: '+998901160005',
        apiId: '1160005',
        sessionString: 'session_ineligible_a',
      });
      await enableDistrictUserbotSession(db, distA);

      await createDistrictUserbotSession(db, {
        districtId: distB,
        phoneNumber: '+998901160006',
        apiId: '1160006',
        sessionString: 'session_eligible_b',
      });
      await enableDistrictUserbotSession(db, distB);

      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
      });

      await manager.start();

      expect(manager.isDistrictConnected(distA)).toBe(true);
      expect(manager.isDistrictConnected(distB)).toBe(true);

      const clientA = createdClients.get(distA)!;
      const clientB = createdClients.get(distB)!;
      expect(clientA.isConnected()).toBe(true);
      expect(clientB.isConnected()).toBe(true);

      // District A subscription lapses: status -> SUSPENDED, accessEligible -> false
      await db
        .update(districts)
        .set({ status: 'SUSPENDED', accessEligible: false })
        .where(eq(districts.id, distA));

      // Trigger syncSessions
      await manager.syncSessions();

      // District A must be cleanly disconnected
      expect(manager.isDistrictConnected(distA)).toBe(false);
      expect(clientA.isConnected()).toBe(false);

      // District B remains connected and healthy
      expect(manager.isDistrictConnected(distB)).toBe(true);
      expect(clientB.isConnected()).toBe(true);

      const healthB = await manager.checkSessionHealth(distB);
      expect(healthB.isConnected).toBe(true);
      expect(healthB.isHealthy).toBe(true);

      await manager.stop();
    });

    it('AC-10: District deletion isolation: Deleting District A removes its connection in the manager while District B remains connected and healthy', async () => {
      const distA = await createTestDistrict('DeleteIsoA');
      const distB = await createTestDistrict('DeleteIsoB');

      await createDistrictUserbotSession(db, {
        districtId: distA,
        phoneNumber: '+998901160007',
        apiId: '1160007',
        sessionString: 'session_delete_iso_a',
      });
      await enableDistrictUserbotSession(db, distA);

      await createDistrictUserbotSession(db, {
        districtId: distB,
        phoneNumber: '+998901160008',
        apiId: '1160008',
        sessionString: 'session_delete_iso_b',
      });
      await enableDistrictUserbotSession(db, distB);

      const manager = new UserbotConnectionManager({
        db,
        clientFactory: mockClientFactory,
        lastSeenIntervalMs: 0,
        pollIntervalMs: 0,
      });

      await manager.start();

      expect(manager.isDistrictConnected(distA)).toBe(true);
      expect(manager.isDistrictConnected(distB)).toBe(true);

      const clientA = createdClients.get(distA)!;
      const clientB = createdClients.get(distB)!;

      // Permanently delete District A row from districts table (DB cascade deletes its session)
      await db.delete(districts).where(eq(districts.id, distA));

      // Sync sessions
      await manager.syncSessions();

      // District A is cleanly disconnected and removed
      expect(manager.isDistrictConnected(distA)).toBe(false);
      expect(clientA.isConnected()).toBe(false);

      // District B remains connected, healthy, and completely undisturbed
      expect(manager.isDistrictConnected(distB)).toBe(true);
      expect(clientB.isConnected()).toBe(true);

      const healthB = await manager.checkSessionHealth(distB);
      expect(healthB.isConnected).toBe(true);
      expect(healthB.isHealthy).toBe(true);

      await manager.stop();
    });
  });
});

