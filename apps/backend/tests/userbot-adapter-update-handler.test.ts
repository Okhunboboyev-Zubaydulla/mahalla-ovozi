import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GramJsUserbotClient } from '../src/adapters/telegram/userbot-client-adapter.js';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const adapterPath = path.join(
  testsDir,
  '..',
  'src',
  'adapters',
  'telegram',
  'userbot-client-adapter.ts',
);

interface RegisteredHandler {
  callback: (update: unknown) => void;
  event: unknown;
}

/**
 * A controllable stand-in for the MTProto client. It records the order of the library-level
 * operations the adapter performs and lets a test push an inbound update into the subscription
 * the adapter registered.
 */
class ControllableTelegramClient {
  static instances: ControllableTelegramClient[] = [];

  readonly operations: string[] = [];
  readonly handlers: RegisteredHandler[] = [];
  connected = false;

  constructor() {
    ControllableTelegramClient.instances.push(this);
  }

  async connect(): Promise<void> {
    this.operations.push('client.connect');
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.operations.push('client.disconnect');
    this.connected = false;
  }

  addEventHandler(callback: (update: unknown) => void, event?: unknown): void {
    this.operations.push('client.addEventHandler');
    this.handlers.push({ callback, event });
  }

  removeEventHandler(callback: (update: unknown) => void, event: unknown): void {
    this.operations.push('client.removeEventHandler');
    const index = this.handlers.findIndex(
      (entry) => entry.callback === callback && entry.event === event,
    );
    if (index >= 0) {
      this.handlers.splice(index, 1);
    }
  }

  /** Simulates the library dispatching one inbound update to every live subscription. */
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

interface AdapterHarness {
  adapter: GramJsUserbotClient;
  /** The library client the adapter most recently constructed (it builds one per connect). */
  getClient(): ControllableTelegramClient;
  received: unknown[];
  order: string[];
  errors: unknown[];
}

function buildAdapter(): AdapterHarness {
  ControllableTelegramClient.instances = [];

  const adapter = new GramJsUserbotClient({
    districtId: 'dist_adapter_handler',
    sessionString: 'stored_session_string',
    apiId: '12345',
    apiHash: 'test_api_hash',
    phoneNumber: '+998901234567',
  });

  const received: unknown[] = [];
  const order: string[] = [];
  const errors: unknown[] = [];

  adapter.on('message', (update: unknown) => {
    received.push(update);
  });
  adapter.on('error', (err: Error) => {
    errors.push(err);
  });
  adapter.on('reconnect', () => {
    order.push('adapter.reconnect');
  });
  adapter.on('disconnect', () => {
    order.push('adapter.disconnect');
  });

  (
    adapter as unknown as {
      loadGramJs: () => Promise<{
        TelegramClient: unknown;
        StringSession: unknown;
        RawUpdateEvent: unknown;
      }>;
    }
  ).loadGramJs = async () => ({
    TelegramClient: ControllableTelegramClient,
    StringSession: ControllableStringSession,
    RawUpdateEvent: ControllableRawUpdateEvent,
  });

  return {
    adapter,
    getClient(): ControllableTelegramClient {
      const instance = ControllableTelegramClient.instances[0];
      if (!instance) {
        throw new Error('Controllable client was not constructed by the adapter');
      }
      return instance;
    },
    received,
    order,
    errors,
  };
}

function wellFormedUpdate(messageId: number): unknown {
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

describe('Ticket 03: Connect registers an inbound update handler and bridges it onto the message event', () => {
  it('delivers an inbound update on the message event after a real adapter connects', async () => {
    const harness = buildAdapter();

    await harness.adapter.connect();
    expect(harness.adapter.isConnected()).toBe(true);

    const client = harness.getClient();
    expect(client.handlers).toHaveLength(1);

    const update = wellFormedUpdate(901);
    client.pushUpdate(update);

    expect(harness.received).toEqual([update]);
  });

  it('subscribes after connect succeeds and emits reconnect only once the subscription is in place', async () => {
    const harness = buildAdapter();

    await harness.adapter.connect();

    expect(harness.getClient().operations).toEqual([
      'client.connect',
      'client.addEventHandler',
    ]);
    expect(harness.order).toEqual(['adapter.reconnect']);
  });

  it('releases the subscription after the client disconnects and before the disconnect event', async () => {
    const harness = buildAdapter();

    await harness.adapter.connect();
    const client = harness.getClient();
    await harness.adapter.disconnect();

    expect(client.operations).toEqual([
      'client.connect',
      'client.addEventHandler',
      'client.disconnect',
      'client.removeEventHandler',
    ]);
    expect(harness.order).toEqual(['adapter.reconnect', 'adapter.disconnect']);

    // After disconnect a further inbound update reaches no consumer and raises no failure.
    expect(() => client.pushUpdate(wellFormedUpdate(902))).not.toThrow();
    expect(harness.received).toEqual([]);
  });

  it('registers and releases a fresh subscription across a second connect/disconnect cycle', async () => {
    const harness = buildAdapter();

    await harness.adapter.connect();
    const firstClient = harness.getClient();
    await harness.adapter.disconnect();
    expect(firstClient.handlers).toHaveLength(0);

    await harness.adapter.connect();
    const liveClients = ControllableTelegramClient.instances.filter(
      (candidate) => candidate.handlers.length > 0,
    );
    expect(liveClients).toHaveLength(1);

    // Only the freshly connected client carries a subscription; the released one carries none.
    firstClient.pushUpdate(wellFormedUpdate(903));
    expect(harness.received).toHaveLength(0);

    liveClients[0]!.pushUpdate(wellFormedUpdate(903));
    expect(harness.received).toHaveLength(1);

    await harness.adapter.disconnect();
    expect(
      ControllableTelegramClient.instances.filter((candidate) => candidate.handlers.length > 0),
    ).toHaveLength(0);
  });

  it('logs and skips one malformed update while the stream survives for the next well-formed update', async () => {
    const harness = buildAdapter();

    // A consumer that throws on a malformed update must not tear down reception.
    harness.adapter.on('message', (update: unknown) => {
      const candidate = update as { message?: { id?: number } };
      if (candidate.message?.id === 904) {
        throw new Error('malformed update rejected by consumer');
      }
    });

    await harness.adapter.connect();
    const client = harness.getClient();

    expect(() => client.pushUpdate(wellFormedUpdate(904))).not.toThrow();

    const good = wellFormedUpdate(905);
    client.pushUpdate(good);
    expect(harness.received).toContain(good);
    expect(client.handlers).toHaveLength(1);
  });

  it('interprets, normalizes, authorizes and persists nothing inside the adapter', () => {
    const source = readFileSync(adapterPath, 'utf8');

    expect(source).not.toMatch(/telegram-intake/);
    expect(source).not.toMatch(/audit-service/);
    expect(source).not.toMatch(/operationalIssues/);
    expect(source).not.toMatch(/normalizeMtprotoUpdate/);
  });
});
