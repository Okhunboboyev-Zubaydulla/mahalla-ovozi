import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertUserbotRuntimeComposition,
  describeUserbotRuntimeComposition,
  UserbotRuntimeCompositionError,
} from '../src/modules/userbot/userbot-runtime-composition.js';
import { createDbPool, createDbClient } from '../src/adapters/db/client.js';
import { createBossClient } from '../src/adapters/jobs/boss-client.js';
import { UserbotConnectionManager } from '../src/modules/userbot/userbot-connection-manager.js';
import type {
  UserbotClientEvents,
  UserbotClientPort,
} from '../src/modules/userbot/userbot-client-port.js';

const TEST_DATABASE_URL =
  'postgresql://mahalla_user:mahalla_dev_password@localhost:5433/mahalla_ovozi_test';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const entrypointPath = path.join(testsDir, '..', 'src', 'entrypoints', 'userbot.ts');

const { processUserbotIngestEnvelopeMock } = vi.hoisted(() => ({
  processUserbotIngestEnvelopeMock: vi.fn(),
}));

/**
 * The intake service is the only thing this file substitutes. The manager, the pool, the queue
 * client and the composition guard are the real production objects; the substitution exists so a
 * failing ingest can be provoked without a live database write.
 */
vi.mock('../src/modules/telegram-intake/telegram-intake-service.js', () => ({
  processUserbotIngestEnvelope: processUserbotIngestEnvelopeMock,
}));

afterEach(() => {
  processUserbotIngestEnvelopeMock.mockReset();
});

/**
 * A real implementation of the client port that records the listeners the manager attaches and can
 * deliver one inbound update to them, exactly as the library does on a live connection.
 */
class RecordingUserbotClient implements UserbotClientPort {
  private isClientConnected = false;

  private readonly listeners: {
    message: ((update: unknown) => void)[];
    disconnect: ((reason?: string | Error) => void)[];
    reconnect: (() => void)[];
    error: ((err: Error) => void)[];
    ban: ((details?: { reason?: string; error?: Error }) => void)[];
  } = {
    message: [],
    disconnect: [],
    reconnect: [],
    error: [],
    ban: [],
  };

  connect(): Promise<void> {
    this.isClientConnected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.isClientConnected = false;
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.isClientConnected;
  }

  on<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void;
  on(
    ...[event, listener]: {
      [K in keyof UserbotClientEvents]: [K, UserbotClientEvents[K]];
    }[keyof UserbotClientEvents]
  ): void {
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

  /** Delivers one inbound update to every registered message listener and surfaces its outcome. */
  async deliverMessage(update: unknown): Promise<void> {
    for (const listener of [...this.listeners.message]) {
      await listener(update);
    }
  }
}

interface AttachListenersSeam {
  attachClientListeners(districtId: string, client: UserbotClientPort): void;
}

/**
 * The one seam this file reaches through. Listener attachment happens on the manager's private
 * connect path, which cannot run without a live database row; the narrow structural cast names the
 * real production method instead of standing in a fake for it.
 */
function attachListeners(
  manager: UserbotConnectionManager,
  districtId: string,
  client: UserbotClientPort,
): void {
  const seam = manager as unknown as AttachListenersSeam;
  seam.attachClientListeners(districtId, client);
}

function newChannelMessage(messageId: number): unknown {
  return {
    _: 'UpdateNewChannelMessage',
    message: {
      _: 'Message',
      id: messageId,
      peerId: { _: 'PeerChannel', channelId: 555000111 },
      fromId: { _: 'PeerUser', userId: 777888 },
      date: Math.floor(Date.now() / 1000),
      message: 'Mahallada suv bosimi past',
    },
    chats: [{ _: 'Channel', id: 555000111, title: 'Navbahor Mahalla Group' }],
    users: [{ _: 'User', id: 777888, firstName: 'Anvar', bot: false }],
  };
}

describe('Ticket 04: The userbot runtime composes its own job queue and refuses to start misconfigured', () => {
  it('aborts naming the absent dependency when the database pool is missing', () => {
    const boss = createBossClient({ connectionString: TEST_DATABASE_URL });

    expect(() =>
      assertUserbotRuntimeComposition({ pool: null, boss }),
    ).toThrowError(UserbotRuntimeCompositionError);

    expect(() =>
      assertUserbotRuntimeComposition({ pool: null, boss }),
    ).toThrowError(/database pool/i);
  });

  it('aborts naming the absent dependency when the job-queue client is missing', () => {
    const pool = createDbPool(TEST_DATABASE_URL);

    try {
      expect(() =>
        assertUserbotRuntimeComposition({ pool, boss: null }),
      ).toThrowError(UserbotRuntimeCompositionError);

      expect(() =>
        assertUserbotRuntimeComposition({ pool, boss: null }),
      ).toThrowError(/job-queue client/i);
    } finally {
      void pool.end();
    }
  });

  it('completes and reports its composition when both dependencies are present', () => {
    const pool = createDbPool(TEST_DATABASE_URL);
    const boss = createBossClient({ connectionString: TEST_DATABASE_URL });

    try {
      expect(() => assertUserbotRuntimeComposition({ pool, boss })).not.toThrow();

      const composition = describeUserbotRuntimeComposition({ pool, boss });
      expect(composition.hasPool).toBe(true);
      expect(composition.hasJobQueueClient).toBe(true);
    } finally {
      void pool.end();
    }
  });

  it('composes both dependencies through the same factory the HTTP and worker entrypoints use', () => {
    const entrypoint = readFileSync(entrypointPath, 'utf8');

    expect(entrypoint).toMatch(/createBossClient/);
    expect(entrypoint).toMatch(/initBossQueues/);
    expect(entrypoint).toMatch(/createDbPool/);
  });

  it('raises a missing job-queue client out of the message handler with its own error type', async () => {
    const pool = createDbPool(TEST_DATABASE_URL);
    const db = createDbClient(pool);
    const reportedFatal: unknown[] = [];

    const manager = new UserbotConnectionManager({
      db,
      pool,
      onFatalRuntimeError: (err: unknown) => {
        reportedFatal.push(err);
      },
    });
    const client = new RecordingUserbotClient();
    attachListeners(manager, 'dist_missing_queue', client);

    try {
      // A normalized message that cannot be ingested raises rather than being logged and dropped.
      await expect(client.deliverMessage(newChannelMessage(2001))).rejects.toBeInstanceOf(
        UserbotRuntimeCompositionError,
      );

      // The failure also reaches the process-fatal escalation channel, not only the rejection.
      expect(reportedFatal).toHaveLength(1);
      const reported = reportedFatal[0];
      expect(reported).toBeInstanceOf(UserbotRuntimeCompositionError);
      if (!(reported instanceof UserbotRuntimeCompositionError)) return;
      expect(reported.code).toBe('USERBOT_RUNTIME_MISCONFIGURED');
      expect(reported.message).toMatch(/job-queue client/i);

      // The guard fires before the intake path is reached, so nothing is half-ingested.
      expect(processUserbotIngestEnvelopeMock).not.toHaveBeenCalled();
    } finally {
      void pool.end();
    }
  });

  it('raises a missing database pool out of the message handler with its own error type', async () => {
    const pool = createDbPool(TEST_DATABASE_URL);
    const db = createDbClient(pool);
    const boss = createBossClient({ connectionString: TEST_DATABASE_URL });
    const reportedFatal: unknown[] = [];

    const manager = new UserbotConnectionManager({
      db,
      boss,
      onFatalRuntimeError: (err: unknown) => {
        reportedFatal.push(err);
      },
    });
    const client = new RecordingUserbotClient();
    attachListeners(manager, 'dist_missing_pool', client);

    try {
      await expect(client.deliverMessage(newChannelMessage(2002))).rejects.toBeInstanceOf(
        UserbotRuntimeCompositionError,
      );

      expect(reportedFatal).toHaveLength(1);
      const reported = reportedFatal[0];
      expect(reported).toBeInstanceOf(UserbotRuntimeCompositionError);
      if (!(reported instanceof UserbotRuntimeCompositionError)) return;
      expect(reported.message).toMatch(/database pool/i);

      expect(processUserbotIngestEnvelopeMock).not.toHaveBeenCalled();
    } finally {
      void pool.end();
    }
  });

  it('keeps an ordinary ingest failure non-fatal so it never takes the composition branch', async () => {
    const pool = createDbPool(TEST_DATABASE_URL);
    const db = createDbClient(pool);
    const boss = createBossClient({ connectionString: TEST_DATABASE_URL });
    const reportedFatal: unknown[] = [];

    processUserbotIngestEnvelopeMock.mockRejectedValueOnce(
      new Error('intake transaction failed for this one update'),
    );

    const manager = new UserbotConnectionManager({
      db,
      pool,
      boss,
      onFatalRuntimeError: (err: unknown) => {
        reportedFatal.push(err);
      },
    });
    const client = new RecordingUserbotClient();
    attachListeners(manager, 'dist_ordinary_failure', client);

    try {
      // The handler absorbs a single failed update exactly as it always did: no escalation, no throw.
      await expect(client.deliverMessage(newChannelMessage(2003))).resolves.toBeUndefined();

      expect(processUserbotIngestEnvelopeMock).toHaveBeenCalledTimes(1);
      expect(reportedFatal).toHaveLength(0);
    } finally {
      void pool.end();
    }
  });
});
