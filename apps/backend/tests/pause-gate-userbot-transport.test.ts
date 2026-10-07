import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import { createBossClient, initBossQueues } from '../src/adapters/jobs/boss-client.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  districtTelegramUserbotSessions,
  telegramIntakeRecords,
} from '../src/adapters/db/schema/index.js';
import { encryptToken } from '../src/adapters/crypto/token-cipher.js';
import {
  createDistrictUserbotSession,
  updateUserbotSessionStatus,
} from '../src/modules/userbot-session/index.js';
import {
  UserbotConnectionManager,
  type UserbotClientPort,
  type UserbotClientFactoryOptions,
  type UserbotClientEvents,
} from '../src/modules/userbot/index.js';
import { normalizeMtprotoUpdate } from '../src/adapters/telegram/mtproto-normalizer.js';
import {
  resolveDistrictBotAndGroup,
  resolveDistrictUserbotAndGroup,
  resolveDistrictTransportAuthorization,
  processUserbotIngestEnvelope,
} from '../src/modules/telegram-intake/telegram-intake-service.js';

class MockUserbotClient implements UserbotClientPort {
  readonly districtId: string;
  readonly sessionString: string;
  readonly apiId: string;
  readonly phoneNumber: string;
  readonly initialUpdatePosition?: string | null;

  private connected = false;
  currentPosition: string | null = null;

  private listeners: { [K in keyof UserbotClientEvents]: UserbotClientEvents[K][] } = {
    message: [],
    disconnect: [],
    reconnect: [],
    error: [],
    ban: [],
    gap: [],
    signal: [],
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
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const fn of this.listeners.disconnect) fn();
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
    this.listeners[event].push(listener);
  }

  off<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void {
    const registered = this.listeners[event];
    const index = registered.indexOf(listener);
    if (index >= 0) {
      registered.splice(index, 1);
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
    chats: [{ _: 'Channel', id: params.chatChannelId, title: 'Paused Mahalla Group' }],
    users: [{ _: 'User', id: params.userId, firstName: 'Anvar', bot: false }],
  };
}

function positionWithPts(pts: number): string {
  return JSON.stringify({ version: 'teleproto-v1', pts, qts: 1, date: pts, seq: 1 });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25,
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

describe('Ticket 02: Pause gate for the userbot transport, with deliberate cursor advance', () => {
  let pool: pg.Pool;
  let db: DbClient;
  let boss: PgBoss;

  const createdClients: Map<string, MockUserbotClient> = new Map();
  const trackedDistricts: string[] = [];

  const mockClientFactory = (params: UserbotClientFactoryOptions): UserbotClientPort => {
    const client = new MockUserbotClient(params);
    createdClients.set(params.districtId, client);
    return client;
  };

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
    boss = createBossClient();
    await boss.start();
    await initBossQueues(boss);
  });

  afterAll(async () => {
    await boss.stop({ graceful: true, timeout: 10000 });
    await pool.end();
  });

  afterEach(async () => {
    for (const districtId of trackedDistricts) {
      await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.districtId, districtId));
      await db.delete(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, districtId));
      await db
        .delete(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      await db.delete(districtTelegramBots).where(eq(districtTelegramBots.districtId, districtId));
      await db.delete(districts).where(eq(districts.id, districtId));
    }
    trackedDistricts.length = 0;
    createdClients.clear();
    vi.restoreAllMocks();
  });

  interface GroupFixture {
    groupId: string;
    chatId: string;
    channelId: number;
    mahallaName: string;
  }

  async function createDistrictFixture(params: {
    groups: Array<{ mahallaName: string; isPaused: boolean }>;
    withBot?: boolean;
  }): Promise<{ districtId: string; botId: string | null; groups: GroupFixture[] }> {
    const districtId = `dist_t02_${crypto.randomUUID()}`;
    trackedDistricts.push(districtId);

    await db.insert(districts).values({
      id: districtId,
      name: `Ticket02 District ${crypto.randomUUID().slice(0, 8)}`,
      region: 'Tashkent',
      status: 'ACTIVE',
      accessEligible: true,
    });

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: `+99890${Math.floor(1000000 + Math.random() * 9000000)}`,
      apiId: String(Math.floor(1000000 + Math.random() * 9000000)),
      apiHash: 'test_hash_val',
      sessionString: `session_str_${districtId}`,
    });
    await updateUserbotSessionStatus(db, districtId, { status: 'ACTIVE' });

    let botId: string | null = null;
    if (params.withBot) {
      botId = `bot_t02_${crypto.randomUUID().slice(0, 8)}`;
      const enc = encryptToken(`555555555:EE${crypto.randomUUID()}`);
      await db.insert(districtTelegramBots).values({
        id: `dtb_${crypto.randomUUID()}`,
        districtId,
        botId,
        botFirstName: 'Ticket 02 Bot',
        botUsername: 'ticket02_bot',
        encryptedToken: enc.encryptedToken,
        tokenIv: enc.tokenIv,
        tokenTag: enc.tokenTag,
        tokenKeyVersion: enc.tokenKeyVersion,
        tokenMasked: `${botId}:••••••••••••`,
        status: 'VALID',
        lastValidatedAt: new Date(),
      });
    }

    const groups: GroupFixture[] = [];
    for (const group of params.groups) {
      const channelId = Math.floor(1000000000 + Math.random() * 9000000000);
      const chatId = `-100${channelId}`;
      const groupId = `dtg_t02_${crypto.randomUUID()}`;
      await db.insert(districtTelegramGroups).values({
        id: groupId,
        districtId,
        mahallaName: group.mahallaName,
        telegramChatId: chatId,
        telegramChatTitle: `${group.mahallaName} Group`,
        transport: 'USERBOT',
        status: 'VALID',
        isPaused: group.isPaused,
      });
      groups.push({ groupId, chatId, channelId, mahallaName: group.mahallaName });
    }

    return { districtId, botId, groups };
  }

  async function readGroup(groupId: string) {
    const [row] = await db
      .select()
      .from(districtTelegramGroups)
      .where(eq(districtTelegramGroups.id, groupId));
    return row;
  }

  async function readStoredPosition(districtId: string): Promise<string | null> {
    const [row] = await db
      .select({ updatePosition: districtTelegramUserbotSessions.updatePosition })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
    return row?.updatePosition ?? null;
  }

  async function seedStoredPosition(districtId: string, position: string): Promise<void> {
    await db
      .update(districtTelegramUserbotSessions)
      .set({ updatePosition: position, updatePositionAdvancedAt: new Date() })
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
  }

  async function countIntakeRows(chatId: string): Promise<number> {
    const rows = await db
      .select()
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.telegramChatId, chatId));
    return rows.length;
  }

  async function countQueuedJobs(chatId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pgboss.job WHERE data->>'telegramChatId' = $1`,
      [chatId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  function startManager(): UserbotConnectionManager {
    return new UserbotConnectionManager({
      db,
      pool,
      boss,
      clientFactory: mockClientFactory,
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });
  }

  describe('Shared authorization seam: the userbot reaches the same paused outcome', () => {
    it('returns the dropped authorization outcome with reason GROUP_PAUSED for a paused USERBOT group, after the group and transport checks pass', async () => {
      const fixture = await createDistrictFixture({
        groups: [{ mahallaName: 'Paused Userbot Mahalla', isPaused: true }],
      });
      const paused = fixture.groups[0]!;

      const result = await resolveDistrictUserbotAndGroup(db, fixture.districtId, paused.chatId);

      expect(result).toMatchObject({ authorized: false, reason: 'GROUP_PAUSED', paused: true });
    });

    it('reaches the same paused outcome through the factored transport resolver with a USERBOT target', async () => {
      const fixture = await createDistrictFixture({
        groups: [{ mahallaName: 'Paused Factored Mahalla', isPaused: true }],
      });
      const paused = fixture.groups[0]!;

      const result = await resolveDistrictTransportAuthorization(db, {
        transport: 'USERBOT',
        districtId: fixture.districtId,
        chatId: paused.chatId,
      });

      expect(result).toMatchObject({ authorized: false, reason: 'GROUP_PAUSED', paused: true });
    });

    it('authorizes a non-paused USERBOT group exactly as before the pause gate', async () => {
      const fixture = await createDistrictFixture({
        groups: [{ mahallaName: 'Live Userbot Mahalla', isPaused: false }],
      });
      const live = fixture.groups[0]!;

      const result = await resolveDistrictUserbotAndGroup(db, fixture.districtId, live.chatId);

      expect(result.authorized).toBe(true);
      if (result.authorized) {
        expect(result.transport).toBe('USERBOT');
        expect(result.districtId).toBe(fixture.districtId);
        expect(result.mahallaName).toBe('Live Userbot Mahalla');
        expect(result.botId).toBeNull();
      }
    });

    it('increments the paused group skipped counter on the userbot path exactly as it does on the bot path', async () => {
      const fixture = await createDistrictFixture({
        groups: [
          { mahallaName: 'Parity Userbot Mahalla', isPaused: true },
          { mahallaName: 'Parity Bot Mahalla', isPaused: true },
        ],
        withBot: true,
      });
      const userbotGroup = fixture.groups[0]!;
      const botGroup = fixture.groups[1]!;
      await db
        .update(districtTelegramGroups)
        .set({ transport: 'BOT_API' })
        .where(eq(districtTelegramGroups.id, botGroup.groupId));

      await resolveDistrictUserbotAndGroup(db, fixture.districtId, userbotGroup.chatId);
      await resolveDistrictUserbotAndGroup(db, fixture.districtId, userbotGroup.chatId);
      await resolveDistrictBotAndGroup(db, fixture.botId!, botGroup.chatId);
      await resolveDistrictBotAndGroup(db, fixture.botId!, botGroup.chatId);

      const userbotRow = await readGroup(userbotGroup.groupId);
      const botRow = await readGroup(botGroup.groupId);
      expect(userbotRow?.isPausedSkippedCount).toBe(2);
      expect(botRow?.isPausedSkippedCount).toBe(2);
      expect(userbotRow?.isPausedSkippedCount).toBe(botRow?.isPausedSkippedCount);
    });

    it('returns the identical dropped outcome kind for a paused message whichever transport carries it', async () => {
      const fixture = await createDistrictFixture({
        groups: [
          { mahallaName: 'Shape Userbot Mahalla', isPaused: true },
          { mahallaName: 'Shape Bot Mahalla', isPaused: true },
        ],
        withBot: true,
      });
      const userbotGroup = fixture.groups[0]!;
      const botGroup = fixture.groups[1]!;
      await db
        .update(districtTelegramGroups)
        .set({ transport: 'BOT_API' })
        .where(eq(districtTelegramGroups.id, botGroup.groupId));

      const normalized = normalizeMtprotoUpdate(
        createMtprotoChannelMessage({
          chatChannelId: userbotGroup.channelId,
          messageId: 7101,
          userId: 880011,
          text: 'Suv quvuri yorildi.',
        }),
      );
      expect(normalized.status).toBe('NORMALIZED');
      if (normalized.status !== 'NORMALIZED') return;

      const userbotResult = await processUserbotIngestEnvelope(
        pool,
        boss,
        fixture.districtId,
        normalized.envelope,
      );
      const botAuth = await resolveDistrictBotAndGroup(db, fixture.botId!, botGroup.chatId);

      expect(userbotResult.status).toBe('DROPPED');
      expect(botAuth.authorized).toBe(false);
      if (userbotResult.status === 'DROPPED' && !botAuth.authorized) {
        expect(userbotResult.reason).toBe(botAuth.reason);
        expect(userbotResult.reason).toBe('GROUP_PAUSED');
      }
    });
  });

  describe('Paused userbot message: no persistence, no enqueued work', () => {
    it('drops a paused userbot message without writing an intake row or enqueueing any pipeline work', async () => {
      const fixture = await createDistrictFixture({
        groups: [{ mahallaName: 'Silent Userbot Mahalla', isPaused: true }],
      });
      const paused = fixture.groups[0]!;

      const normalized = normalizeMtprotoUpdate(
        createMtprotoChannelMessage({
          chatChannelId: paused.channelId,
          messageId: 7201,
          userId: 880022,
          text: 'Yangi yoʻl kerak.',
        }),
      );
      expect(normalized.status).toBe('NORMALIZED');
      if (normalized.status !== 'NORMALIZED') return;

      const jobsBefore = await countQueuedJobs(paused.chatId);
      const result = await processUserbotIngestEnvelope(
        pool,
        boss,
        fixture.districtId,
        normalized.envelope,
      );

      expect(result.status).toBe('DROPPED');
      if (result.status === 'DROPPED') {
        expect(result.reason).toBe('GROUP_PAUSED');
        expect(result.chatId).toBe(paused.chatId);
        expect(result.messageId).toBe('7201');
      }

      expect(await countIntakeRows(paused.chatId)).toBe(0);
      expect(await countQueuedJobs(paused.chatId)).toBe(jobsBefore);

      const row = await readGroup(paused.groupId);
      expect(row?.isPausedSkippedCount).toBe(1);
    });

    it('still persists and enqueues for a non-paused userbot group', async () => {
      const fixture = await createDistrictFixture({
        groups: [{ mahallaName: 'Active Userbot Mahalla', isPaused: false }],
      });
      const live = fixture.groups[0]!;

      const normalized = normalizeMtprotoUpdate(
        createMtprotoChannelMessage({
          chatChannelId: live.channelId,
          messageId: 7202,
          userId: 880023,
          text: 'Mahalla hashari boshlandi.',
        }),
      );
      expect(normalized.status).toBe('NORMALIZED');
      if (normalized.status !== 'NORMALIZED') return;

      const jobsBefore = await countQueuedJobs(live.chatId);
      const result = await processUserbotIngestEnvelope(
        pool,
        boss,
        fixture.districtId,
        normalized.envelope,
      );

      expect(result.status).toBe('ACCEPTED');
      expect(await countIntakeRows(live.chatId)).toBe(1);
      expect(await countQueuedJobs(live.chatId)).toBe(jobsBefore + 1);

      const row = await readGroup(live.groupId);
      expect(row?.isPaused).toBe(false);
      expect(row?.isPausedSkippedCount).toBe(0);
    });
  });

  describe('Deliberate cursor advance on the paused-drop path', () => {
    it('advances the stored District session position for a paused drop, from the paused-drop path itself', async () => {
      const fixture = await createDistrictFixture({
        groups: [{ mahallaName: 'Cursor Paused Mahalla', isPaused: true }],
      });
      const paused = fixture.groups[0]!;
      const pos201 = positionWithPts(201);
      await seedStoredPosition(fixture.districtId, positionWithPts(200));

      const manager = startManager();
      await manager.start();
      const client = createdClients.get(fixture.districtId)!;
      client.setUpdatePosition(pos201);
      client.pushUpdate(
        createMtprotoChannelMessage({
          chatChannelId: paused.channelId,
          messageId: 7301,
          userId: 880031,
          text: 'Paused message that must still move the cursor.',
        }),
      );

      await waitFor(async () => (await readStoredPosition(fixture.districtId)) === pos201);

      expect(await readStoredPosition(fixture.districtId)).toBe(pos201);
      expect(await countIntakeRows(paused.chatId)).toBe(0);
      expect(await countQueuedJobs(paused.chatId)).toBe(0);

      await manager.stop();
    });

    it('leaves a fully paused Tuman cursor healthy so a reconnect does not replay the paused backlog', async () => {
      const fixture = await createDistrictFixture({
        groups: [
          { mahallaName: 'All Paused One', isPaused: true },
          { mahallaName: 'All Paused Two', isPaused: true },
        ],
      });
      const first = fixture.groups[0]!;
      const second = fixture.groups[1]!;

      const manager1 = startManager();
      await manager1.start();
      const client1 = createdClients.get(fixture.districtId)!;

      const pos301 = positionWithPts(301);
      client1.setUpdatePosition(pos301);
      client1.pushUpdate(
        createMtprotoChannelMessage({
          chatChannelId: first.channelId,
          messageId: 7401,
          userId: 880041,
          text: 'Paused backlog one.',
        }),
      );
      await waitFor(async () => (await readStoredPosition(fixture.districtId)) === pos301);

      const pos302 = positionWithPts(302);
      client1.setUpdatePosition(pos302);
      client1.pushUpdate(
        createMtprotoChannelMessage({
          chatChannelId: second.channelId,
          messageId: 7402,
          userId: 880042,
          text: 'Paused backlog two.',
        }),
      );
      await waitFor(async () => (await readStoredPosition(fixture.districtId)) === pos302);

      expect(await readStoredPosition(fixture.districtId)).toBe(pos302);

      await manager1.stop();
      createdClients.delete(fixture.districtId);

      const manager2 = startManager();
      await manager2.start();
      const client2 = createdClients.get(fixture.districtId)!;

      expect(client2.initialUpdatePosition).toBe(pos302);

      await manager2.stop();
    });

    it('does not disturb position handling for active sibling groups beside a paused group', async () => {
      const fixture = await createDistrictFixture({
        groups: [
          { mahallaName: 'Sibling Paused Mahalla', isPaused: true },
          { mahallaName: 'Sibling Active Mahalla', isPaused: false },
        ],
      });
      const paused = fixture.groups[0]!;
      const active = fixture.groups[1]!;

      const manager = startManager();
      await manager.start();
      const client = createdClients.get(fixture.districtId)!;

      const pos401 = positionWithPts(401);
      client.setUpdatePosition(pos401);
      client.pushUpdate(
        createMtprotoChannelMessage({
          chatChannelId: paused.channelId,
          messageId: 7501,
          userId: 880051,
          text: 'Paused sibling message.',
        }),
      );
      await waitFor(async () => (await readStoredPosition(fixture.districtId)) === pos401);

      const pos402 = positionWithPts(402);
      client.setUpdatePosition(pos402);
      client.pushUpdate(
        createMtprotoChannelMessage({
          chatChannelId: active.channelId,
          messageId: 7502,
          userId: 880052,
          text: 'Active sibling message.',
        }),
      );
      await waitFor(async () => (await readStoredPosition(fixture.districtId)) === pos402);

      expect(await readStoredPosition(fixture.districtId)).toBe(pos402);
      expect(await countIntakeRows(active.chatId)).toBe(1);
      expect(await countIntakeRows(paused.chatId)).toBe(0);

      const pausedRow = await readGroup(paused.groupId);
      const activeRow = await readGroup(active.groupId);
      expect(pausedRow?.isPausedSkippedCount).toBe(1);
      expect(activeRow?.isPausedSkippedCount).toBe(0);

      await manager.stop();
    });

    it('counts a paused drop without advancing the cursor when the update carries no captured position', async () => {
      const fixture = await createDistrictFixture({
        groups: [{ mahallaName: 'No Position Mahalla', isPaused: true }],
      });
      const paused = fixture.groups[0]!;
      const seeded = positionWithPts(500);
      await seedStoredPosition(fixture.districtId, seeded);

      const manager = startManager();
      await manager.start();
      const client = createdClients.get(fixture.districtId)!;
      client.setUpdatePosition(null);
      client.pushUpdate(
        createMtprotoChannelMessage({
          chatChannelId: paused.channelId,
          messageId: 7601,
          userId: 880061,
          text: 'Paused message with no captured position.',
        }),
      );

      await waitFor(async () => {
        const row = await readGroup(paused.groupId);
        return row?.isPausedSkippedCount === 1;
      });

      expect(await readStoredPosition(fixture.districtId)).toBe(seeded);

      await manager.stop();
    });

    it('leaves a genuinely unauthorized userbot update with no cursor advance', async () => {
      const fixture = await createDistrictFixture({
        groups: [{ mahallaName: 'Known Mahalla', isPaused: false }],
      });
      const seeded = positionWithPts(600);
      await seedStoredPosition(fixture.districtId, seeded);
      const unknownChannelId = Math.floor(1000000000 + Math.random() * 9000000000);

      const manager = startManager();
      await manager.start();
      const client = createdClients.get(fixture.districtId)!;
      client.setUpdatePosition(positionWithPts(601));
      client.pushUpdate(
        createMtprotoChannelMessage({
          chatChannelId: unknownChannelId,
          messageId: 7701,
          userId: 880071,
          text: 'Message from an unmapped chat.',
        }),
      );

      await waitFor(async () => {
        const [row] = await db
          .select({ id: telegramIntakeRecords.id })
          .from(telegramIntakeRecords)
          .where(
            and(
              eq(telegramIntakeRecords.districtId, fixture.districtId),
              eq(telegramIntakeRecords.telegramMessageId, '7701'),
            ),
          );
        return row === undefined;
      });

      // The unauthorized path behaves exactly as it did before ticket 02.
      expect(await readStoredPosition(fixture.districtId)).toBe(seeded);

      await manager.stop();
    });
  });
});
