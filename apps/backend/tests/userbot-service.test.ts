import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  updateUserbotSessionStatus,
  disableDistrictUserbotSession,
  getDistrictUserbotSession,
} from '../src/modules/userbot-session/index.js';
import {
  UserbotConnectionManager,
  type UserbotClientPort,
  type UserbotClientFactory,
  type UserbotClientEvents,
  type _AssertPassiveOnlyPort,
} from '../src/modules/userbot/index.js';
import { GramJsUserbotClient } from '../src/adapters/telegram/userbot-client-adapter.js';


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
    }
  }

  emit(event: 'reconnect'): void;
  emit(event: 'disconnect', reason?: string | Error): void;
  emit(event: 'message', update: unknown): void;
  emit(event: 'error', err: Error): void;
  emit(event: 'ban', details?: { reason?: string; error?: Error }): void;
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
    await updateUserbotSessionStatus(db, activeDist, { status: 'ACTIVE' });

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
    await updateUserbotSessionStatus(db, disabledDist, { status: 'ACTIVE' });
    await disableDistrictUserbotSession(db, disabledDist);

    // Banned session
    await createDistrictUserbotSession(db, {
      districtId: bannedDist,
      phoneNumber: `+99890${crypto.randomUUID().replace(/\D/g, '').slice(0, 7)}`,
      apiId: '1110004',
      sessionString: `session_banned_${crypto.randomUUID()}`,
    });
    await updateUserbotSessionStatus(db, bannedDist, { status: 'BANNED' });

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
    await updateUserbotSessionStatus(db, districtId, { status: 'ACTIVE' });

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

    await updateUserbotSessionStatus(db, districtId, { status: 'ACTIVE' });

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
    await updateUserbotSessionStatus(db, districtId, { status: 'ACTIVE' });

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
    await updateUserbotSessionStatus(db, dist1, { status: 'ACTIVE' });

    await createDistrictUserbotSession(db, {
      districtId: dist2,
      phoneNumber: '+998905550002',
      apiId: '5550002',
      sessionString: 'session_shutdown_2',
    });
    await updateUserbotSessionStatus(db, dist2, { status: 'ACTIVE' });

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
    await updateUserbotSessionStatus(db, districtId, { status: 'ACTIVE' });

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

  it('Test 8: FLOOD_WAIT raises a District-scoped Operational Issue alert before ban and retries once without hammering', async () => {
    const districtId = await createTestDistrict('FloodWaitSignal');

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998907770001',
      apiId: '7770001',
      sessionString: 'session_flood_wait_token',
    });
    await updateUserbotSessionStatus(db, districtId, { status: 'ACTIVE' });

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
    await updateUserbotSessionStatus(db, dist1, { status: 'ACTIVE' });

    await createDistrictUserbotSession(db, {
      districtId: dist2,
      phoneNumber: '+998908880002',
      apiId: '8880002',
      sessionString: sharedSessionString,
    });
    await updateUserbotSessionStatus(db, dist2, { status: 'ACTIVE' });

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
    }

    class MockStringSession {
      session: string;
      constructor(session: string) {
        this.session = session;
      }
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
    });

    await client.connect();

    expect(capturedOptions).toEqual({
      connectionRetries: 5,
      catchUp: false,
    });
    expect(client.isConnected()).toBe(true);

    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it('Test 11: _AssertPassiveOnlyPort active compile-time guard resolves to true and validates port has no write methods (Ticket 18)', () => {
    const isPassiveOnly: _AssertPassiveOnlyPort = true;
    expect(isPassiveOnly).toBe(true);
  });
});

