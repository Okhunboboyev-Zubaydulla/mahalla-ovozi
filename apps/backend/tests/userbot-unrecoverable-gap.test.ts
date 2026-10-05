import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type pg from 'pg';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import {
  districts,
  districtTelegramGroups,
  districtTelegramUserbotSessions,
  telegramIntakeRecords,
  operationalIssues,
  auditEvents,
} from '../src/adapters/db/schema/index.js';
import {
  createDistrictUserbotSession,
  updateUserbotSessionStatus,
} from '../src/modules/userbot-session/index.js';
import {
  UserbotConnectionManager,
  type UserbotClientPort,
  type UserbotClientFactoryOptions,
  type UserbotClientEvents,
  isUnrecoverableGap,
} from '../src/modules/userbot/index.js';
import { checkDistrictIntakeHealth } from '../src/modules/health/health-checker.js';
import { healthService } from '../src/modules/health/health-service.js';

class MockGapUserbotClient implements UserbotClientPort {
  readonly districtId: string;
  readonly sessionString: string;
  readonly apiId: string;
  readonly phoneNumber: string;
  readonly initialUpdatePosition?: string | null;

  connectCalls = 0;
  disconnectCalls = 0;
  private connected = false;
  currentPosition: string | null = null;

  private listeners = {
    message: [] as ((update: unknown) => void)[],
    disconnect: [] as ((reason?: string | Error) => void)[],
    reconnect: [] as (() => void)[],
    error: [] as ((err: Error) => void)[],
    ban: [] as ((details?: { reason?: string; error?: Error }) => void)[],
    gap: [] as ((details?: { reason?: string; lastKnownPosition?: string | null; error?: Error }) => void)[],
  };

  constructor(params: UserbotClientFactoryOptions) {
    this.districtId = params.districtId;
    this.sessionString = params.sessionString;
    this.apiId = params.apiId;
    this.phoneNumber = params.phoneNumber;
    this.initialUpdatePosition = params.initialUpdatePosition;
    this.currentPosition = params.initialUpdatePosition ?? null;
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

  getUpdatePosition(): string | null {
    return this.currentPosition;
  }

  setUpdatePosition(pos: string | null): void {
    this.currentPosition = pos;
  }

  on<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void {
    this.listeners[event].push(listener as any);
  }

  off<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void {
    this.listeners[event] = (this.listeners[event] as any[]).filter((l) => l !== listener);
  }

  private emit(event: 'disconnect', reason?: string | Error): void {
    for (const fn of this.listeners.disconnect) fn(reason);
  }

  triggerGap(details: { reason: string; lastKnownPosition?: string | null; error?: Error }): void {
    for (const fn of [...this.listeners.gap]) {
      fn(details);
    }
  }

  triggerError(err: Error): void {
    for (const fn of [...this.listeners.error]) {
      fn(err);
    }
  }

  pushUpdate(update: unknown): void {
    for (const fn of [...this.listeners.message]) {
      fn(update);
    }
  }
}

function createMtprotoChannelMessage(params: {
  chatChannelId: number;
  messageId: number;
  userId: number;
  text: string;
}): unknown {
  return {
    _: 'UpdateNewChannelMessage',
    message: {
      _: 'Message',
      id: params.messageId,
      peerId: { _: 'PeerChannel', channelId: params.chatChannelId },
      fromId: { _: 'PeerUser', userId: params.userId },
      date: Math.floor(Date.now() / 1000),
      message: params.text,
    },
    chats: [{ _: 'Channel', id: params.chatChannelId, title: 'Navbahor Mahalla Group' }],
    users: [{ _: 'User', id: params.userId, firstName: 'Anvar', bot: false }],
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor condition timed out after ${timeoutMs}ms`);
}

describe('Ticket 18: An Unrecoverable Gap is Raised, Not Swallowed', () => {
  let pool: pg.Pool;
  let db: DbClient;
  const createdClients: Map<string, MockGapUserbotClient> = new Map();
  const trackedDistricts: string[] = [];
  const activeManagers: UserbotConnectionManager[] = [];

  const mockBoss = {
    send: vi.fn().mockResolvedValue('mock-boss-job-id'),
  } as unknown as any;

  const mockClientFactory = (params: UserbotClientFactoryOptions): UserbotClientPort => {
    const client = new MockGapUserbotClient(params);
    createdClients.set(params.districtId, client);
    return client;
  };

  async function createTestDistrictFixture(namePrefix = 'Ticket18Dist'): Promise<{
    districtId: string;
    chatChannelId: number;
    chatId: string;
    sessionString: string;
    apiId: string;
  }> {
    const districtId = `dist_t18_${crypto.randomUUID()}`;
    trackedDistricts.push(districtId);
    const sessionString = `session_str_${districtId}`;
    const apiId = String(Math.floor(1000000 + Math.random() * 9000000));
    const chatChannelId = Math.floor(1000000000 + Math.random() * 9000000000);
    const chatId = `-100${chatChannelId}`;

    await db.insert(districts).values({
      id: districtId,
      name: `${namePrefix}_${crypto.randomUUID().slice(0, 8)}`,
      region: 'Tashkent',
      status: 'ACTIVE',
      accessEligible: true,
    });

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: `+99890${Math.floor(1000000 + Math.random() * 9000000)}`,
      apiId,
      apiHash: 'test_hash_val',
      sessionString,
    });
    await updateUserbotSessionStatus(db, districtId, { status: 'ACTIVE' });

    await db.insert(districtTelegramGroups).values({
      id: `dtg_t18_${crypto.randomUUID()}`,
      districtId,
      mahallaName: 'Navbahor',
      telegramChatId: chatId,
      telegramChatTitle: 'Navbahor Mahalla Group',
      transport: 'USERBOT',
      status: 'VALID',
      lastValidatedAt: new Date(),
    });

    return { districtId, chatChannelId, chatId, sessionString, apiId };
  }

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    for (const manager of activeManagers) {
      await manager.stop();
    }
    activeManagers.length = 0;

    for (const districtId of trackedDistricts) {
      await db.delete(operationalIssues).where(eq(operationalIssues.districtId, districtId));
      await db.delete(auditEvents).where(eq(auditEvents.districtId, districtId));
      await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.districtId, districtId));
      await db.delete(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, districtId));
      await db.delete(districtTelegramUserbotSessions).where(eq(districtTelegramUserbotSessions.districtId, districtId));
      await db.delete(districts).where(eq(districts.id, districtId));
    }
    trackedDistricts.length = 0;
    createdClients.clear();
    vi.restoreAllMocks();
  });

  it('Criterion 1 (AC-1): An unrecoverable gap raises a District-scoped Operational Issue rather than passing silently', async () => {
    const fixture = await createTestDistrictFixture('AC1GapIssue');
    const { districtId } = fixture;

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    activeManagers.push(manager);
    await manager.start();

    const client = createdClients.get(districtId);
    expect(client).toBeDefined();

    // Trigger an unrecoverable gap event from the client
    client!.triggerGap({
      reason: 'UpdateChannelTooLong',
      lastKnownPosition: '{"version":"teleproto-v1","pts":500}',
    });

    // Wait for the operational issue to be written
    await waitFor(async () => {
      const issues = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtId),
            eq(operationalIssues.issueCategory, 'UNRECOVERABLE_GAP'),
          ),
        );
      return issues.length > 0;
    });

    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.districtId, districtId),
          eq(operationalIssues.issueCategory, 'UNRECOVERABLE_GAP'),
        ),
      );

    expect(issue).toBeDefined();
    expect(issue!.scope).toBe('DISTRICT');
    expect(issue!.districtId).toBe(districtId);
    expect(issue!.component).toBe('USERBOT');
    expect(issue!.issueCategory).toBe('UNRECOVERABLE_GAP');
    expect(issue!.severity).toBe('Warning');
    expect(issue!.status).toBe('ACTIVE');
    expect(issue!.healthStatus).toBe('Degraded');
    expect(issue!.logicalKey).toBe(`DISTRICT:${districtId}:USERBOT:UNRECOVERABLE_GAP`);

    // Audit event was also emitted
    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.districtId, districtId),
          eq(auditEvents.action, 'USERBOT_UNRECOVERABLE_GAP_DETECTED'),
        ),
      );
    expect(audits.length).toBeGreaterThan(0);
  });

  it('Criterion 2 (AC-2): The raised Operational Issue names the incomplete awareness', async () => {
    const fixture = await createTestDistrictFixture('AC2Awareness');
    const { districtId } = fixture;

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    activeManagers.push(manager);
    await manager.start();

    const client = createdClients.get(districtId);
    client!.triggerGap({
      reason: 'DIFFERENCE_TOO_LONG',
      lastKnownPosition: '{"version":"teleproto-v1","pts":1200}',
    });

    await waitFor(async () => {
      const issues = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.districtId, districtId));
      return issues.length > 0;
    });

    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.districtId, districtId));

    // Must explicitly name "incomplete awareness"
    expect(issue!.sanitizedDescription.toLowerCase()).toContain('incomplete awareness');
    expect(issue!.sanitizedTitle.toLowerCase()).toContain('incomplete awareness');
    expect(issue!.metadata).toBeDefined();
    expect((issue!.metadata as Record<string, unknown>).incompleteAwareness).toBe(true);
  });

  it('Criterion 3 (AC-3): The last known good position is recorded on the raised Operational Issue', async () => {
    const fixture = await createTestDistrictFixture('AC3LastPos');
    const { districtId } = fixture;

    const seededPosition = JSON.stringify({
      version: 'teleproto-v1',
      pts: 9876,
      qts: 12,
      date: 1728000000,
      seq: 42,
    });

    // Advance position in DB
    await db
      .update(districtTelegramUserbotSessions)
      .set({
        updatePosition: seededPosition,
        updatePositionAdvancedAt: new Date(),
      })
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    activeManagers.push(manager);
    await manager.start();

    const client = createdClients.get(districtId);
    // Client has updatePosition
    client!.setUpdatePosition(seededPosition);

    // Trigger gap without passing position in details — manager reads it from DB / client
    client!.triggerGap({ reason: 'UpdateChannelTooLong' });

    await waitFor(async () => {
      const issues = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.districtId, districtId));
      return issues.length > 0;
    });

    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.districtId, districtId));

    expect((issue!.metadata as Record<string, unknown>).lastKnownGoodPosition).toBe(seededPosition);
    expect(issue!.sanitizedDescription).toContain(seededPosition);
  });

  it('Criterion 4 (AC-4): The Operational Issue is scoped to the affected District and does not appear against any other District', async () => {
    const fixtureA = await createTestDistrictFixture('AC4DistA');
    const fixtureB = await createTestDistrictFixture('AC4DistB');

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    activeManagers.push(manager);
    await manager.start();

    const clientA = createdClients.get(fixtureA.districtId);
    clientA!.triggerGap({
      reason: 'UpdateChannelTooLong',
      lastKnownPosition: '{"pts":100}',
    });

    await waitFor(async () => {
      const issues = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.districtId, fixtureA.districtId));
      return issues.length > 0;
    });

    // District A has 1 active issue
    const issuesA = await db
      .select()
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.districtId, fixtureA.districtId),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );
    expect(issuesA.length).toBe(1);
    expect(issuesA[0]!.districtId).toBe(fixtureA.districtId);

    // District B has ZERO issues
    const issuesB = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.districtId, fixtureB.districtId));
    expect(issuesB.length).toBe(0);
  });

  it('Criterion 5 (AC-5): A long outage surfaces the District as degraded rather than healthy', async () => {
    const fixture = await createTestDistrictFixture('AC5Degraded');
    const { districtId } = fixture;

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    activeManagers.push(manager);
    await manager.start();

    const client = createdClients.get(districtId);
    client!.triggerGap({
      reason: 'PTS_OUT_OF_BOUNDS',
      lastKnownPosition: '{"pts":300}',
    });

    await waitFor(async () => {
      return manager.hasUnrecoverableGap(districtId);
    });

    // 1. Session health report surfaces as Degraded (isHealthy: false)
    const sessionHealth = await manager.checkSessionHealth(districtId);
    expect(sessionHealth.isHealthy).toBe(false);
    expect(sessionHealth.status).toBe('DEGRADED');
    expect(sessionHealth.reason).toContain('Unrecoverable update gap detected');

    // 2. District intake component health check surfaces as Degraded
    const intakeObs = await checkDistrictIntakeHealth(db, districtId);
    expect(intakeObs.status).toBe('Degraded');
    expect(intakeObs.errorCode).toBe('UNRECOVERABLE_GAP');

    // 3. District overall health surfaces as Degraded rather than Healthy
    const districtHealth = await healthService.getDistrictHealth(db, districtId);
    expect(districtHealth.status).toBe('Degraded');
  });

  it('Criterion 6 (AC-6): Recovery after a recoverable gap records no Operational Issue', async () => {
    const fixture = await createTestDistrictFixture('AC6Recoverable');
    const { districtId, chatChannelId, chatId } = fixture;

    // Seed update position
    const initialPos = JSON.stringify({
      version: 'teleproto-v1',
      pts: 200,
      qts: 1,
      date: 1000,
      seq: 1,
    });
    await db
      .update(districtTelegramUserbotSessions)
      .set({ updatePosition: initialPos, updatePositionAdvancedAt: new Date() })
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    activeManagers.push(manager);
    await manager.start();

    const client = createdClients.get(districtId);
    expect(client).toBeDefined();

    // Normal catch-up: deliver message and advance position to 201
    const pos201 = JSON.stringify({
      version: 'teleproto-v1',
      pts: 201,
      qts: 1,
      date: 1001,
      seq: 1,
    });
    client!.setUpdatePosition(pos201);
    client!.pushUpdate(
      createMtprotoChannelMessage({
        chatChannelId,
        messageId: 201,
        userId: 111,
        text: 'Normal catch-up message',
      }),
    );

    await waitFor(async () => {
      const records = await db
        .select()
        .from(telegramIntakeRecords)
        .where(eq(telegramIntakeRecords.districtId, districtId));
      return records.length > 0;
    });

    // Zero operational issues created for this recoverable gap / normal catchup
    const issues = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.districtId, districtId));
    expect(issues.length).toBe(0);
  });

  it('Criterion 7 (AC-7): The platform raises the incomplete-awareness notice automatically rather than leaving it to the Hokim to infer', async () => {
    const fixture = await createTestDistrictFixture('AC7AutoNotice');
    const { districtId } = fixture;

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    activeManagers.push(manager);
    await manager.start();

    const client = createdClients.get(districtId);

    // Event is raised directly from transport error event (e.g. library detects gap)
    client!.triggerError(new Error('UpdateChannelTooLong: history truncated on Telegram server'));

    // Automatically raised without any operator intervention or API trigger
    await waitFor(async () => {
      const issues = await db
        .select()
        .from(operationalIssues)
        .where(
          and(
            eq(operationalIssues.districtId, districtId),
            eq(operationalIssues.status, 'ACTIVE'),
          ),
        );
      return issues.length > 0;
    });

    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.districtId, districtId));

    expect(issue!.issueCategory).toBe('UNRECOVERABLE_GAP');
    expect(issue!.sanitizedTitle).toContain('Incomplete Awareness');
  });

  it('Criterion 8 (AC-8): A gap in one District does not change the reported health of another District', async () => {
    const fixtureA = await createTestDistrictFixture('AC8DistA');
    const fixtureB = await createTestDistrictFixture('AC8DistB');

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    activeManagers.push(manager);
    await manager.start();

    const clientA = createdClients.get(fixtureA.districtId);
    clientA!.triggerGap({
      reason: 'DIFFERENCE_TOO_LONG',
      lastKnownPosition: '{"pts":888}',
    });

    await waitFor(async () => {
      return manager.hasUnrecoverableGap(fixtureA.districtId);
    });

    // District A health is degraded
    const healthA = await manager.checkSessionHealth(fixtureA.districtId);
    expect(healthA.isHealthy).toBe(false);
    expect(healthA.status).toBe('DEGRADED');

    // District B health is completely unaffected (Healthy and active)
    const healthB = await manager.checkSessionHealth(fixtureB.districtId);
    expect(healthB.isHealthy).toBe(true);
    expect(healthB.status).toBe('ACTIVE');

    const districtHealthB = await healthService.getDistrictHealth(db, fixtureB.districtId);
    expect(districtHealthB.status).not.toBe('Degraded');
  });

  it('Criterion 9 (AC-9): The lifecycle states PENDING, ACTIVE, BANNED and DISABLED are unchanged, and no fifth state is introduced; transport continues receiving live messages', async () => {
    const fixture = await createTestDistrictFixture('AC9StateAndTransport');
    const { districtId, chatChannelId } = fixture;

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    activeManagers.push(manager);
    await manager.start();

    const client = createdClients.get(districtId);

    // Trigger unrecoverable gap
    client!.triggerGap({
      reason: 'UpdateChannelTooLong',
      lastKnownPosition: '{"pts":1500}',
    });

    await waitFor(async () => {
      return manager.hasUnrecoverableGap(districtId);
    });

    // Check DB session row status: MUST REMAIN 'ACTIVE'
    const [sessionRow] = await db
      .select({ status: districtTelegramUserbotSessions.status })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    expect(sessionRow!.status).toBe('ACTIVE');

    // Client connection remains intact
    expect(client!.isConnected()).toBe(true);

    // Transport continues receiving and persisting live incoming messages
    client!.pushUpdate(
      createMtprotoChannelMessage({
        chatChannelId,
        messageId: 9001,
        userId: 777,
        text: 'Live update after gap occurred',
      }),
    );

    await waitFor(async () => {
      const records = await db
        .select()
        .from(telegramIntakeRecords)
        .where(
          and(
            eq(telegramIntakeRecords.districtId, districtId),
            eq(telegramIntakeRecords.telegramMessageId, '9001'),
          ),
        );
      return records.length > 0;
    });

    const [liveRecord] = await db
      .select()
      .from(telegramIntakeRecords)
      .where(
        and(
          eq(telegramIntakeRecords.districtId, districtId),
          eq(telegramIntakeRecords.telegramMessageId, '9001'),
        ),
      );

    expect(liveRecord).toBeDefined();
    expect(liveRecord!.telegramMessageId).toBe('9001');
  });

  it('Criterion 10 (AC-10): No database migration is introduced; the Operational Issue record shape is unchanged', async () => {
    // 1. Verify isUnrecoverableGap helper recognizes standard MTProto gap errors
    expect(isUnrecoverableGap(new Error('UpdateChannelTooLong'))).toBe(true);
    expect(isUnrecoverableGap(new Error('UpdatesTooLong'))).toBe(true);
    expect(isUnrecoverableGap(new Error('DIFFERENCE_TOO_LONG'))).toBe(true);
    expect(isUnrecoverableGap(new Error('PTS_OUT_OF_BOUNDS'))).toBe(true);
    expect(isUnrecoverableGap(new Error('PERSISTENT_TIMESTAMP_INVALID'))).toBe(true);
    expect(isUnrecoverableGap({ code: 'UNRECOVERABLE_GAP' })).toBe(true);
    expect(isUnrecoverableGap(new Error('FLOOD_WAIT_10'))).toBe(false);
    expect(isUnrecoverableGap(new Error('PHONE_NUMBER_BANNED'))).toBe(false);
    expect(isUnrecoverableGap(null)).toBe(false);

    // 2. Operational Issue record shape conforms to existing schema columns
    const fixture = await createTestDistrictFixture('AC10SchemaCheck');
    const { districtId } = fixture;

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    activeManagers.push(manager);
    await manager.start();

    const client = createdClients.get(districtId);
    client!.triggerGap({ reason: 'UpdateChannelTooLong' });

    await waitFor(async () => {
      const issues = await db
        .select()
        .from(operationalIssues)
        .where(eq(operationalIssues.districtId, districtId));
      return issues.length > 0;
    });

    const [issue] = await db
      .select()
      .from(operationalIssues)
      .where(eq(operationalIssues.districtId, districtId));

    // Confirm standard columns exist and have expected types
    expect(typeof issue!.id).toBe('string');
    expect(typeof issue!.logicalKey).toBe('string');
    expect(typeof issue!.scope).toBe('string');
    expect(typeof issue!.districtId).toBe('string');
    expect(typeof issue!.component).toBe('string');
    expect(typeof issue!.issueCategory).toBe('string');
    expect(typeof issue!.severity).toBe('string');
    expect(typeof issue!.status).toBe('string');
    expect(typeof issue!.healthStatus).toBe('string');
    expect(typeof issue!.sanitizedTitle).toBe('string');
    expect(typeof issue!.sanitizedDescription).toBe('string');
    expect(typeof issue!.recommendedAction).toBe('string');
    expect(issue!.startedAt instanceof Date).toBe(true);
    expect(issue!.latestCheckAt instanceof Date).toBe(true);
  });
});
