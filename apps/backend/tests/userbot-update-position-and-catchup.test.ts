import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type pg from 'pg';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, and } from 'drizzle-orm';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import {
  districts,
  districtTelegramGroups,
  districtTelegramUserbotSessions,
  telegramIntakeRecords,
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
  type UserbotClientFactoryOptions,
  type UserbotClientEvents,
  isOlderLibraryPosition,
} from '../src/modules/userbot/index.js';
import { GramJsUserbotClient } from '../src/adapters/telegram/userbot-client-adapter.js';
import { PublicDistrictUserbotSessionSchema } from '@mahalla-ovozi/api-contracts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MockUserbotClient implements UserbotClientPort {
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

  private emit(_event: 'disconnect', reason?: string | Error): void {
    for (const fn of this.listeners.disconnect) fn(reason);
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

describe('Ticket 17: Update Position Persistence and Universal Catch-Up', () => {
  let pool: pg.Pool;
  let db: DbClient;
  const createdClients: Map<string, MockUserbotClient> = new Map();
  const trackedDistricts: string[] = [];

  const mockBoss = {
    send: vi.fn().mockResolvedValue('mock-boss-job-id'),
  } as unknown as any;

  const mockClientFactory = (params: UserbotClientFactoryOptions): UserbotClientPort => {
    const client = new MockUserbotClient(params);
    createdClients.set(params.districtId, client);
    return client;
  };

  async function createTestDistrictFixture(namePrefix = 'Ticket17Dist'): Promise<{
    districtId: string;
    chatChannelId: number;
    chatId: string;
    sessionString: string;
    apiId: string;
  }> {
    const districtId = `dist_t17_${crypto.randomUUID()}`;
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
      id: `dtg_t17_${crypto.randomUUID()}`,
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
    for (const districtId of trackedDistricts) {
      await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.districtId, districtId));
      await db.delete(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, districtId));
      await db.delete(districtTelegramUserbotSessions).where(eq(districtTelegramUserbotSessions.districtId, districtId));
      await db.delete(districts).where(eq(districts.id, districtId));
    }
    trackedDistricts.length = 0;
    createdClients.clear();
    vi.restoreAllMocks();
  });

  it('Criterion 1 (AC-1): After simulated teardown and rebuild, session resumes from persisted update position, and downtime message appears in intake', async () => {
    const fixture = await createTestDistrictFixture('TeardownRebuild');
    const { districtId, chatChannelId, chatId } = fixture;

    // 1. Pre-seed initial position in DB
    const initialPos = JSON.stringify({
      version: 'teleproto-v1',
      pts: 100,
      qts: 1,
      date: 1000,
      seq: 1,
    });
    await db
      .update(districtTelegramUserbotSessions)
      .set({ updatePosition: initialPos, updatePositionAdvancedAt: new Date() })
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    // 2. Start initial manager run
    const manager1 = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    await manager1.start();

    const client1 = createdClients.get(districtId);
    expect(client1).toBeDefined();
    expect(client1!.initialUpdatePosition).toBe(initialPos);

    // 3. Deliver message 1001 while online, updating position to pts: 101
    const pos101 = JSON.stringify({
      version: 'teleproto-v1',
      pts: 101,
      qts: 1,
      date: 1001,
      seq: 2,
    });
    client1!.setUpdatePosition(pos101);
    client1!.pushUpdate(
      createMtprotoChannelMessage({
        chatChannelId,
        messageId: 1001,
        userId: 554433,
        text: 'First online message',
      }),
    );

    // Verify intake record persisted and DB position advanced
    await waitFor(async () => {
      const [record] = await db
        .select()
        .from(telegramIntakeRecords)
        .where(
          and(
            eq(telegramIntakeRecords.districtId, districtId),
            eq(telegramIntakeRecords.telegramChatId, chatId),
            eq(telegramIntakeRecords.telegramMessageId, '1001'),
          ),
        );
      const pos = await manager1.getUpdatePosition(districtId);
      return Boolean(record && pos === pos101);
    });

    const [dbRowAfterMsg1] = await db
      .select({
        pos: districtTelegramUserbotSessions.updatePosition,
        advancedAt: districtTelegramUserbotSessions.updatePositionAdvancedAt,
      })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
    expect(dbRowAfterMsg1).toBeDefined();
    expect(dbRowAfterMsg1!.pos).toBe(pos101);
    expect(dbRowAfterMsg1!.advancedAt).toBeInstanceOf(Date);

    // 4. Teardown manager 1 (simulated shutdown / restart boundary)
    await manager1.stop();
    expect(client1!.isConnected()).toBe(false);
    createdClients.delete(districtId);

    // 5. Rebuild: start manager 2
    const manager2 = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    await manager2.start();

    const client2 = createdClients.get(districtId);
    expect(client2).toBeDefined();
    // Invariant: resumes from persisted position (pos101), NOT empty
    expect(client2!.initialUpdatePosition).toBe(pos101);

    // 6. Deliver catch-up message 1002 (posted during downtime)
    const pos102 = JSON.stringify({
      version: 'teleproto-v1',
      pts: 102,
      qts: 1,
      date: 1002,
      seq: 3,
    });
    client2!.setUpdatePosition(pos102);
    client2!.pushUpdate(
      createMtprotoChannelMessage({
        chatChannelId,
        messageId: 1002,
        userId: 554433,
        text: 'Downtime caught-up message',
      }),
    );

    await waitFor(async () => {
      const [record] = await db
        .select()
        .from(telegramIntakeRecords)
        .where(
          and(
            eq(telegramIntakeRecords.districtId, districtId),
            eq(telegramIntakeRecords.telegramChatId, chatId),
            eq(telegramIntakeRecords.telegramMessageId, '1002'),
          ),
        );
      const pos = await manager2.getUpdatePosition(districtId);
      return Boolean(record && pos === pos102);
    });

    const [dbRowAfterMsg2] = await db
      .select({
        pos: districtTelegramUserbotSessions.updatePosition,
        advancedAt: districtTelegramUserbotSessions.updatePositionAdvancedAt,
      })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
    expect(dbRowAfterMsg2).toBeDefined();
    expect(dbRowAfterMsg2!.pos).toBe(pos102);

    await manager2.stop();
  });

  it('Criterion 2 (AC-2): Deduplication index prevents re-delivered message during catch-up from being recorded twice', async () => {
    const fixture = await createTestDistrictFixture('DedupCatchup');
    const { districtId, chatChannelId, chatId } = fixture;

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    await manager.start();

    const client = createdClients.get(districtId)!;
    const pos = JSON.stringify({ version: 'teleproto-v1', pts: 201, qts: 1, date: 2000, seq: 1 });
    client.setUpdatePosition(pos);

    const msgPayload = createMtprotoChannelMessage({
      chatChannelId,
      messageId: 2001,
      userId: 665544,
      text: 'Message to be delivered twice',
    });

    // 1st delivery
    client.pushUpdate(msgPayload);
    await waitFor(async () => {
      const records = await db
        .select()
        .from(telegramIntakeRecords)
        .where(
          and(
            eq(telegramIntakeRecords.districtId, districtId),
            eq(telegramIntakeRecords.telegramChatId, chatId),
            eq(telegramIntakeRecords.telegramMessageId, '2001'),
          ),
        );
      return records.length === 1;
    });

    // 2nd delivery (crash re-delivery / re-transmission during catchup)
    client.pushUpdate(msgPayload);

    // Small delay to allow message handler to run through DUPLICATE branch
    await new Promise((r) => setTimeout(r, 200));

    const records = await db
      .select()
      .from(telegramIntakeRecords)
      .where(
        and(
          eq(telegramIntakeRecords.districtId, districtId),
          eq(telegramIntakeRecords.telegramChatId, chatId),
          eq(telegramIntakeRecords.telegramMessageId, '2001'),
        ),
      );
    // Unique index strictly ensures exactly 1 row
    expect(records.length).toBe(1);

    await manager.stop();
  });

  it('Criterion 3 (AC-3): Failure during position advance does not lose or skip the already-persisted message', async () => {
    const fixture = await createTestDistrictFixture('AdvanceFailureSafety');
    const { districtId, chatChannelId, chatId } = fixture;

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    // Mock advanceUpdatePosition to throw an unhandled error
    const advanceSpy = vi
      .spyOn(manager, 'advanceUpdatePosition')
      .mockRejectedValue(new Error('Simulated database deadlock during position advance'));

    await manager.start();
    const client = createdClients.get(districtId)!;
    client.setUpdatePosition(
      JSON.stringify({ version: 'teleproto-v1', pts: 301, qts: 1, date: 3000, seq: 1 }),
    );

    client.pushUpdate(
      createMtprotoChannelMessage({
        chatChannelId,
        messageId: 3001,
        userId: 778899,
        text: 'Persisted despite advance error',
      }),
    );

    // Verify intake record is safely persisted despite advance failure
    await waitFor(async () => {
      const [record] = await db
        .select()
        .from(telegramIntakeRecords)
        .where(
          and(
            eq(telegramIntakeRecords.districtId, districtId),
            eq(telegramIntakeRecords.telegramChatId, chatId),
            eq(telegramIntakeRecords.telegramMessageId, '3001'),
          ),
        );
      return Boolean(record);
    });

    expect(advanceSpy).toHaveBeenCalled();

    await manager.stop();
  });

  it('Criterion 4 (AC-4): Universal catch-up is enabled and not opt-out per District', async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    class MockTelegramClient {
      constructor(_session: unknown, _apiId: number, _apiHash: string, options: Record<string, unknown>) {
        capturedOptions = options;
      }
      async connect(): Promise<void> {}
      async disconnect(): Promise<void> {}
      addEventHandler(): void {}
      removeEventHandler(): void {}
    }

    const client = new GramJsUserbotClient({
      districtId: 'dist_universal_catchup',
      sessionString: 'test_session',
      apiId: '12345',
      apiHash: 'test_hash',
      phoneNumber: '+998901234567',
    });

    (client as any).loadGramJs = async () => ({
      TelegramClient: MockTelegramClient,
      StringSession: class {},
      RawUpdateEvent: class {},
    });

    await client.connect();

    expect(capturedOptions).toBeDefined();
    // Universal catch-up enabled: catchUp is true, never false
    expect(capturedOptions!.catchUp).toBe(true);

    await client.disconnect();
  });

  it('Criterion 5 (AC-5): Update position & advanced timestamp are observable to diagnostics, while public API contract omits them', async () => {
    const fixture = await createTestDistrictFixture('DiagnosticVisibility');
    const { districtId } = fixture;

    const testPos = JSON.stringify({
      version: 'teleproto-v1',
      pts: 555,
      qts: 12,
      date: 4567,
      seq: 8,
    });
    const advancedTime = new Date('2026-10-05T07:00:00Z');

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.advanceUpdatePosition(districtId, testPos, advancedTime);

    // Diagnostics visibility
    const retrievedPos = await manager.getUpdatePosition(districtId);
    const retrievedTime = await manager.getUpdatePositionAdvancedAt(districtId);

    expect(retrievedPos).toBe(testPos);
    expect(retrievedTime?.toISOString()).toBe(advancedTime.toISOString());

    // Public API contract check: formatPublicUserbotSession must omit both fields
    const publicSession = await getDistrictUserbotSession(db, districtId);
    expect(publicSession).toBeDefined();
    expect(publicSession).not.toHaveProperty('updatePosition');
    expect(publicSession).not.toHaveProperty('updatePositionAdvancedAt');

    // Schema boundary verification
    const serialized = JSON.parse(JSON.stringify(publicSession));
    const parsed = PublicDistrictUserbotSessionSchema.safeParse(serialized);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as any).updatePosition).toBeUndefined();
      expect((parsed.data as any).updatePositionAdvancedAt).toBeUndefined();
    }
  });

  it('Criterion 6 (AC-6): Older library position is treated as absent, cleared in DB, and generates a diagnostic gap notice', async () => {
    // 1. Test unit helper isOlderLibraryPosition
    expect(isOlderLibraryPosition('{"library":"gramjs","pts":100}')).toBe(true);
    expect(isOlderLibraryPosition('gramjs:session_raw_pos')).toBe(true);
    expect(isOlderLibraryPosition('{"version":"gramjs-v0","pts":50}')).toBe(true);
    expect(isOlderLibraryPosition('not_even_json')).toBe(true);
    expect(isOlderLibraryPosition('12345')).toBe(true);
    expect(isOlderLibraryPosition('{"version":"teleproto-v1","pts":100}')).toBe(false);
    expect(isOlderLibraryPosition(null)).toBe(false);
    expect(isOlderLibraryPosition('')).toBe(false);

    // 2. Integration: set legacy position in database
    const fixture = await createTestDistrictFixture('LegacyDiscard');
    const { districtId } = fixture;

    const legacyPosition = '{"library":"gramjs","pts":999}';
    await db
      .update(districtTelegramUserbotSessions)
      .set({
        updatePosition: legacyPosition,
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

    await manager.start();

    // Client received null initial position (treated as absent)
    const client = createdClients.get(districtId);
    expect(client).toBeDefined();
    expect(client!.initialUpdatePosition).toBeNull();

    // Position wiped in DB
    const [row] = await db
      .select({
        pos: districtTelegramUserbotSessions.updatePosition,
        advancedAt: districtTelegramUserbotSessions.updatePositionAdvancedAt,
      })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
    expect(row).toBeDefined();
    expect(row!.pos).toBeNull();
    expect(row!.advancedAt).toBeNull();

    // Diagnostic gap notice registered
    const notice = manager.getGapNotice(districtId);
    expect(notice).toBeDefined();
    expect(notice?.districtId).toBe(districtId);
    expect(notice?.discardedPosition).toBe(legacyPosition);
    expect(notice?.recordedAt).toBeInstanceOf(Date);

    const allNotices = manager.getGapNotices();
    expect(allNotices.some((n) => n.districtId === districtId)).toBe(true);

    await manager.stop();
  });

  it('Criterion 7 (AC-7): Revocation and account deletion clear update position and timestamp together with secrets', async () => {
    const fixtureRevoke = await createTestDistrictFixture('RevocationClearing');
    const validPos = JSON.stringify({
      version: 'teleproto-v1',
      pts: 777,
      qts: 1,
      date: 1000,
      seq: 1,
    });

    // 1. Test disableDistrictUserbotSession clears position
    await db
      .update(districtTelegramUserbotSessions)
      .set({ updatePosition: validPos, updatePositionAdvancedAt: new Date() })
      .where(eq(districtTelegramUserbotSessions.districtId, fixtureRevoke.districtId));

    const mockRevoker = vi.fn().mockResolvedValue({
      revocationPerformed: true,
      revocationSuccess: true,
    });

    await disableDistrictUserbotSession(
      db,
      fixtureRevoke.districtId,
      'admin_user_revoker',
      'PRODUCT_OWNER',
      { revoker: mockRevoker },
    );

    const [disabledRow] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, fixtureRevoke.districtId));

    expect(disabledRow).toBeDefined();
    expect(disabledRow!.status).toBe('DISABLED');
    expect(disabledRow!.sessionEncrypted).toBeNull();
    expect(disabledRow!.updatePosition).toBeNull();
    expect(disabledRow!.updatePositionAdvancedAt).toBeNull();

    // 2. Test handleAccountDeleted clears position on an active session
    const fixtureDeleted = await createTestDistrictFixture('AccountDeletedClearing');
    await db
      .update(districtTelegramUserbotSessions)
      .set({ updatePosition: validPos, updatePositionAdvancedAt: new Date() })
      .where(eq(districtTelegramUserbotSessions.districtId, fixtureDeleted.districtId));

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.handleAccountDeleted(fixtureDeleted.districtId);

    const [deletedRow] = await db
      .select()
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, fixtureDeleted.districtId));

    expect(deletedRow).toBeDefined();
    expect(deletedRow!.status).toBe('PENDING');
    expect(deletedRow!.sessionEncrypted).toBeNull();
    expect(deletedRow!.updatePosition).toBeNull();
    expect(deletedRow!.updatePositionAdvancedAt).toBeNull();
  });

  it('Criterion 8 (AC-8): Restart re-establishes every ACTIVE session and ignores non-ACTIVE sessions', async () => {
    const distActive = await createTestDistrictFixture('ActiveOnly_Active');
    const distPending = await createTestDistrictFixture('ActiveOnly_Pending');
    const distDisabled = await createTestDistrictFixture('ActiveOnly_Disabled');
    const distBanned = await createTestDistrictFixture('ActiveOnly_Banned');

    await updateUserbotSessionStatus(db, distPending.districtId, { status: 'PENDING' });
    await updateUserbotSessionStatus(db, distDisabled.districtId, { status: 'DISABLED' });
    await updateUserbotSessionStatus(db, distBanned.districtId, { status: 'BANNED' });

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    await manager.start();

    // Only ACTIVE is established
    expect(manager.isDistrictConnected(distActive.districtId)).toBe(true);
    expect(manager.isDistrictConnected(distPending.districtId)).toBe(false);
    expect(manager.isDistrictConnected(distDisabled.districtId)).toBe(false);
    expect(manager.isDistrictConnected(distBanned.districtId)).toBe(false);

    await manager.stop();
  });

  it('Criterion 9 (AC-9): inboundUpdateCounter defaults to zero and increments on updates', async () => {
    const fixture = await createTestDistrictFixture('UpdateCounter');
    const { districtId, chatChannelId } = fixture;

    // Check initial counter value
    const [initialRow] = await db
      .select({ count: districtTelegramUserbotSessions.inboundUpdateCounter })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
    expect(initialRow).toBeDefined();
    expect(initialRow!.count).toBe(0);

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss: mockBoss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
    await manager.start();

    const client = createdClients.get(districtId)!;
    expect(await manager.getInboundUpdateCount(districtId)).toBe(0);

    // Deliver update 1
    client.pushUpdate(
      createMtprotoChannelMessage({
        chatChannelId,
        messageId: 9001,
        userId: 112233,
        text: 'Inbound counter update 1',
      }),
    );

    await waitFor(async () => {
      const count = await manager.getInboundUpdateCount(districtId);
      return count === 1;
    });

    // Deliver update 2
    client.pushUpdate(
      createMtprotoChannelMessage({
        chatChannelId,
        messageId: 9002,
        userId: 112233,
        text: 'Inbound counter update 2',
      }),
    );

    await waitFor(async () => {
      const count = await manager.getInboundUpdateCount(districtId);
      return count === 2;
    });

    expect(await manager.getInboundUpdateCount(districtId)).toBe(2);

    await manager.stop();
  });

  it('Criterion 10 (AC-10): Delta migration check: only new position columns added; Accepted Evidence and intake structures unchanged', async () => {
    // 1. Verify columns in district_telegram_userbot_sessions
    const colsRes = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns 
       WHERE table_name = 'district_telegram_userbot_sessions' 
         AND column_name IN ('update_position', 'update_position_advanced_at')`,
    );
    expect(colsRes.rows).toHaveLength(2);
    const colMap = Object.fromEntries(colsRes.rows.map((r) => [r.column_name, r.data_type]));
    expect(colMap.update_position).toBe('text');
    expect(colMap.update_position_advanced_at).toBe('timestamp with time zone');

    // 2. Verify Accepted Evidence unique constraint (district_id, telegram_chat_id, telegram_message_id)
    const acceptedIdxRes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes 
       WHERE tablename = 'accepted_evidence' AND indexname = 'accepted_evidence_district_chat_msg_idx'`,
    );
    expect(acceptedIdxRes.rows).toHaveLength(1);

    // 3. Verify Telegram Intake Records unique constraint (district_id, telegram_chat_id, telegram_message_id)
    const intakeIdxRes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes 
       WHERE tablename = 'telegram_intake_records' AND indexname = 'telegram_intakes_district_chat_msg_idx'`,
    );
    expect(intakeIdxRes.rows).toHaveLength(1);

    // 4. Verify Drizzle journal registered migration 0032
    const journalPath = path.resolve(__dirname, '../drizzle/meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const entry32 = journal.entries.find((e: { idx: number }) => e.idx === 32);
    expect(entry32).toBeDefined();
    expect(entry32.tag).toBe('0032_wakeful_overlord');
  });
});
