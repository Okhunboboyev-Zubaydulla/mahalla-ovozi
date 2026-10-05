import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type pg from 'pg';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { createDbPool, createDbClient, type DbClient } from '../src/adapters/db/client.js';
import {
  acceptedEvidence,
  districts,
  districtTelegramGroups,
  districtTelegramUserbotSessions,
  telegramIntakeRecords,
} from '../src/adapters/db/schema/index.js';
import {
  createDistrictUserbotSession,
  updateUserbotSessionStatus,
} from '../src/modules/userbot-session/index.js';
import { normalizeMtprotoUpdate } from '../src/adapters/telegram/mtproto-normalizer.js';
import {
  startUserbotService,
  stopUserbotService,
} from '../src/entrypoints/userbot.js';

/**
 * The only substituted seam in this file is the shared library loader. Everything else — the
 * connection manager, the intake service, the database and the job queue — is real.
 *
 * The controllable client is hoisted because vi.mock's factory is lifted above the imports.
 */
const controllable = vi.hoisted(() => {
  interface Handler {
    callback: (update: unknown) => void;
    event: unknown;
  }

  class ControllableTelegramClient {
    static instances: ControllableTelegramClient[] = [];

    readonly handlers: Handler[] = [];
    connected = false;
    /**
     * The session material the adapter constructed this client with. It identifies which district
     * this client belongs to, which is what lets the test address its own district's client rather
     * than whichever client happened to be constructed last.
     */
    readonly sessionValue: string | null;

    constructor(session?: { value?: string }) {
      this.sessionValue =
        typeof session?.value === 'string' ? session.value : null;
      ControllableTelegramClient.instances.push(this);
    }

    async connect(): Promise<void> {
      this.connected = true;
    }

    async disconnect(): Promise<void> {
      this.connected = false;
    }

    addEventHandler(callback: (update: unknown) => void, event?: unknown): void {
      this.handlers.push({ callback, event });
    }

    removeEventHandler(callback: (update: unknown) => void, event: unknown): void {
      const index = this.handlers.findIndex(
        (entry) => entry.callback === callback && entry.event === event,
      );
      if (index >= 0) {
        this.handlers.splice(index, 1);
      }
    }

    /** Delivers one inbound update exactly as the library would. */
    pushUpdate(update: unknown): void {
      for (const handler of [...this.handlers]) {
        handler.callback(update);
      }
    }
  }

  class ControllableStringSession {
    readonly value: string;

    constructor(value: string) {
      this.value = value;
    }
  }

  class ControllableRawUpdateEvent {
    readonly params: Record<string, unknown>;

    constructor(params: Record<string, unknown>) {
      this.params = params;
    }
  }

  return {
    ControllableTelegramClient,
    ControllableStringSession,
    ControllableRawUpdateEvent,
  };
});

vi.mock('../src/adapters/telegram/telegram-library-loader.js', () => ({
  DEFAULT_TELEGRAM_LIBRARY_SPECIFIER: {
    moduleSpecifier: 'teleproto',
    sessionModuleSpecifier: 'teleproto/sessions/index.js',
    eventsModuleSpecifier: 'teleproto/events',
  },
  loadTelegramLibrary: async () => ({
    TelegramClient: controllable.ControllableTelegramClient,
    StringSession: controllable.ControllableStringSession,
    RawUpdateEvent: controllable.ControllableRawUpdateEvent,
  }),
}));

/**
 * Resolves the library client the adapter constructed for one district, identified by the session
 * material that district's session row carries. The manager connects every ACTIVE session in the
 * database, so construction order says nothing about which district a client belongs to.
 */
function clientForSession(
  sessionString: string,
): InstanceType<typeof controllable.ControllableTelegramClient> {
  const instance = controllable.ControllableTelegramClient.instances.find(
    (candidate) => candidate.sessionValue === sessionString,
  );
  if (!instance) {
    throw new Error(
      `No controllable library client was constructed for session ${sessionString}`,
    );
  }
  return instance;
}

function newChannelMessage(params: {
  chatChannelId: number;
  messageId: number;
  userId: number;
  text: string;
  edit?: boolean;
}): unknown {
  return {
    _: params.edit ? 'UpdateEditChannelMessage' : 'UpdateNewChannelMessage',
    message: {
      _: 'Message',
      id: params.messageId,
      peerId: { _: 'PeerChannel', channelId: params.chatChannelId },
      fromId: { _: 'PeerUser', userId: params.userId },
      date: Math.floor(Date.now() / 1000),
      message: params.text,
      ...(params.edit ? { editDate: Math.floor(Date.now() / 1000) } : {}),
    },
    chats: [{ _: 'Channel', id: params.chatChannelId, title: 'Navbahor Mahalla Group' }],
    users: [{ _: 'User', id: params.userId, firstName: 'Anvar', bot: false }],
  };
}

describe('Ticket 05: Envelope adaptation and end-to-end intake proof', () => {
  let pool: pg.Pool;
  let db: DbClient;

  let districtId: string;
  let sessionString: string;
  let chatChannelId: number;
  let chatId: string;

  beforeAll(async () => {
    pool = createDbPool();
    db = createDbClient(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    // Self-isolation. Every row this test creates is removed here, so a repeated run starts from the
    // same state as the first one. The pg-boss rows are deleted explicitly because they carry the
    // district id only inside their payload and are not linked to the district by a foreign key.
    await pool.query(`DELETE FROM pgboss.job WHERE data->>'districtId' = $1`, [districtId]);
    // Accepted Evidence references its intake record, so it must be removed first.
    await db.delete(acceptedEvidence).where(eq(acceptedEvidence.districtId, districtId));
    await db.delete(telegramIntakeRecords).where(eq(telegramIntakeRecords.districtId, districtId));
    await db.delete(districtTelegramGroups).where(eq(districtTelegramGroups.districtId, districtId));
    await db
      .delete(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));
    await db.delete(districts).where(eq(districts.id, districtId));
  });

  beforeEach(async () => {
    controllable.ControllableTelegramClient.instances = [];

    districtId = `dist_env_e2e_${crypto.randomUUID()}`;
    sessionString = `test_session_${districtId}`;
    await db.insert(districts).values({
      id: districtId,
      name: `Envelope E2E District ${crypto.randomUUID()}`,
      status: 'ACTIVE',
    });

    await createDistrictUserbotSession(db, {
      districtId,
      phoneNumber: '+998901234567',
      apiId: '12345',
      apiHash: 'test_api_hash',
      sessionString,
    });
    await updateUserbotSessionStatus(db, districtId, { status: 'ACTIVE' });

    chatChannelId = Math.floor(1000000000 + Math.random() * 9000000000);
    chatId = `-100${chatChannelId}`;

    await db.insert(districtTelegramGroups).values({
      id: `dtg_env_${crypto.randomUUID()}`,
      districtId,
      mahallaName: 'Navbahor',
      telegramChatId: chatId,
      telegramChatTitle: 'Navbahor Mahalla Group',
      transport: 'USERBOT',
      status: 'VALID',
      lastValidatedAt: new Date(),
    });
  });

  it('populates the update identifier only when the library supplies one', () => {
    const bare = normalizeMtprotoUpdate(
      newChannelMessage({ chatChannelId, messageId: 1101, userId: 445566, text: 'Suv yo‘q' }),
    );
    expect(bare.status).toBe('NORMALIZED');
    if (bare.status !== 'NORMALIZED') return;
    expect(bare.envelope.updateId).toBeNull();

    const withUpdateId = normalizeMtprotoUpdate({
      ...(newChannelMessage({
        chatChannelId,
        messageId: 1102,
        userId: 445566,
        text: 'Suv yo‘q',
      }) as Record<string, unknown>),
      update_id: 90210,
    });
    expect(withUpdateId.status).toBe('NORMALIZED');
    if (withUpdateId.status !== 'NORMALIZED') return;
    expect(withUpdateId.envelope.updateId).toBe('90210');
  });

  it('classifies an edit structurally in the normalizer and carries it as an explicit envelope field', () => {
    const fresh = normalizeMtprotoUpdate(
      newChannelMessage({ chatChannelId, messageId: 1201, userId: 445566, text: 'Gaz yo‘q' }),
    );
    expect(fresh.status).toBe('NORMALIZED');
    if (fresh.status !== 'NORMALIZED') return;
    expect(fresh.envelope.isEdit).toBe(false);

    const edited = normalizeMtprotoUpdate(
      newChannelMessage({
        chatChannelId,
        messageId: 1201,
        userId: 445566,
        text: 'Gaz yo‘q, tuzatildi',
        edit: true,
      }),
    );
    expect(edited.status).toBe('NORMALIZED');
    if (edited.status !== 'NORMALIZED') return;
    expect(edited.envelope.isEdit).toBe(true);
  });

  it('proves the whole path end to end with only the library loader substituted', async () => {
    // The runtime composes its own real pool and real job-queue client through the same
    // factories the HTTP and worker entrypoints use. No dependency is injected here.
    const manager = await startUserbotService({
      lastSeenIntervalMs: 0,
      pollIntervalMs: 0,
    });

    try {
      expect(manager.getManagedDistricts()).toContain(districtId);

      // The adapter — not the test — registered the inbound subscription on the library client.
      const client = clientForSession(sessionString);
      expect(client.handlers).toHaveLength(1);

      const text = 'Mahallamizda suv bosimi juda past bo‘lyapti';
      client.pushUpdate(
        newChannelMessage({ chatChannelId, messageId: 1301, userId: 998811, text }),
      );

      await vi.waitFor(
        async () => {
          const [record] = await db
            .select()
            .from(telegramIntakeRecords)
            .where(
              and(
                eq(telegramIntakeRecords.districtId, districtId),
                eq(telegramIntakeRecords.telegramChatId, chatId),
                eq(telegramIntakeRecords.telegramMessageId, '1301'),
              ),
            );
          expect(record).toBeDefined();
        },
        { timeout: 5000, interval: 50 },
      );

      const [record] = await db
        .select()
        .from(telegramIntakeRecords)
        .where(
          and(
            eq(telegramIntakeRecords.districtId, districtId),
            eq(telegramIntakeRecords.telegramChatId, chatId),
            eq(telegramIntakeRecords.telegramMessageId, '1301'),
          ),
        );

      // Provenance and District ownership.
      expect(record!.source).toBe('USERBOT');
      expect(record!.districtId).toBe(districtId);
      expect(record!.mahallaName).toBe('Navbahor');
      expect(record!.telegramChatId).toBe(chatId);
      expect(record!.telegramMessageId).toBe('1301');
      expect(record!.telegramUserId).toBe('998811');

      // No bot identity: the consistency constraint holds by that absence.
      expect(record!.telegramBotId).toBeNull();

      // The raw payload keeps the diagnostic value of what the transport delivered.
      const rawPayload = record!.rawPayload as Record<string, unknown>;
      expect(rawPayload._).toBe('UpdateNewChannelMessage');
      expect(Array.isArray(rawPayload.chats)).toBe(true);
      expect(rawPayload.message).toBeDefined();

      // The downstream job was enqueued in the same transaction as the intake record.
      await vi.waitFor(
        async () => {
          const jobs = await pool.query<{ name: string }>(
            `SELECT name FROM pgboss.job WHERE name = $1 AND data->>'districtId' = $2 AND data->>'telegramChatId' = $3`,
            ['telegram-burst-debounce', districtId, chatId],
          );
          expect(jobs.rows.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000, interval: 50 },
      );
    } finally {
      await stopUserbotService(manager);
    }
  });

  it('treats a structurally classified edit with an unknown identifier as a new message, not an edit', async () => {
    const manager = await startUserbotService({ lastSeenIntervalMs: 0, pollIntervalMs: 0 });

    try {
      const client = clientForSession(sessionString);
      client.pushUpdate(
        newChannelMessage({
          chatChannelId,
          messageId: 1401,
          userId: 998811,
          text: 'Tahrirlangan xabar',
          edit: true,
        }),
      );

      await vi.waitFor(
        async () => {
          const rows = await db
            .select()
            .from(telegramIntakeRecords)
            .where(eq(telegramIntakeRecords.districtId, districtId));
          expect(rows.length).toBe(1);
        },
        { timeout: 5000, interval: 50 },
      );

      const rows = await db
        .select()
        .from(telegramIntakeRecords)
        .where(eq(telegramIntakeRecords.districtId, districtId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.telegramMessageId).toBe('1401');
    } finally {
      await stopUserbotService(manager);
    }
  });

  it('deduplicates a re-delivered edit against the original record instead of creating a second', async () => {
    const manager = await startUserbotService({ lastSeenIntervalMs: 0, pollIntervalMs: 0 });

    try {
      const client = clientForSession(sessionString);
      client.pushUpdate(
        newChannelMessage({ chatChannelId, messageId: 1501, userId: 998811, text: 'Asl xabar' }),
      );

      await vi.waitFor(
        async () => {
          const rows = await db
            .select()
            .from(telegramIntakeRecords)
            .where(
              and(
                eq(telegramIntakeRecords.districtId, districtId),
                eq(telegramIntakeRecords.telegramMessageId, '1501'),
              ),
            );
          expect(rows.length).toBe(1);
        },
        { timeout: 5000, interval: 50 },
      );

      client.pushUpdate(
        newChannelMessage({
          chatChannelId,
          messageId: 1501,
          userId: 998811,
          text: 'Asl xabar, tahrirlangan',
          edit: true,
        }),
      );

      await vi.waitFor(
        async () => {
          const rows = await db
            .select()
            .from(telegramIntakeRecords)
            .where(
              and(
                eq(telegramIntakeRecords.districtId, districtId),
                eq(telegramIntakeRecords.telegramMessageId, '1501'),
              ),
            );
          const payload = rows[0]?.rawPayload as Record<string, unknown> | undefined;
          expect(payload?.edited_message).toBeDefined();
        },
        { timeout: 5000, interval: 50 },
      );

      const rows = await db
        .select()
        .from(telegramIntakeRecords)
        .where(
          and(
            eq(telegramIntakeRecords.districtId, districtId),
            eq(telegramIntakeRecords.telegramMessageId, '1501'),
          ),
        );
      expect(rows).toHaveLength(1);
    } finally {
      await stopUserbotService(manager);
    }
  });

  it('keeps the shared intake core free of transport-specific branching', () => {
    const testsDir = path.dirname(fileURLToPath(import.meta.url));
    const intakePath = path.join(
      testsDir,
      '..',
      'src',
      'modules',
      'telegram-intake',
      'telegram-intake-service.ts',
    );
    const source = readFileSync(intakePath, 'utf8');

    expect(source).not.toMatch(/isUserbotEnvelopeEdit/);
    expect(source).not.toMatch(/UpdateEditChannelMessage/);
    expect(source).not.toMatch(/MTProto/);
  });
});
