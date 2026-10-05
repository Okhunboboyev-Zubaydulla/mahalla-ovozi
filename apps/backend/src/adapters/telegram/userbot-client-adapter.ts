/**
 * MTProto Userbot Client Adapter (Ticket 07).
 * Implements UserbotClientPort using GramJS (telegram) dynamic import.
 */

import {
  UserbotClientPort,
  UserbotClientFactory,
  UserbotClientEvents,
  ClassifiedUserbotSignal,
  _AssertPassiveOnlyPort,
} from '../../modules/userbot/userbot-client-port.js';
import { logger } from '../../utils/logger.js';
import {
  loadTelegramLibrary,
  DEFAULT_TELEGRAM_LIBRARY_SPECIFIER,
  type TelegramLibrary,
  type TelegramEventBuilderConstructor,
} from './telegram-library-loader.js';
import {
  classifyTelegramSignal,
  toUserbotSignalError,
} from './telegram-signal-classifier.js';

interface GramJsClientStub {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  connected?: boolean;
  addEventHandler?(callback: (update: unknown) => void, event: unknown): void;
  removeEventHandler?(callback: (update: unknown) => void, event: unknown): void;
  updateManager?: {
    refreshFromState?(state: { pts?: number; qts?: number; date?: number; seq?: number }): void;
    state?: {
      pts?: number;
      qts?: number;
      date?: number;
      seq?: number;
    };
  };
}

interface InboundUpdateSubscription {
  callback: (update: unknown) => void;
  event: unknown;
}

export type _AssertPassiveOnlyAdapter = _AssertPassiveOnlyPort;

/**
 * GramJS implementation of UserbotClientPort.
 * Enforces passive-only intake invariant: strictly no write methods.
 */
export class GramJsUserbotClient implements UserbotClientPort {

  readonly districtId: string;
  readonly sessionString: string;
  readonly apiId: string;
  readonly apiHash: string | null;
  readonly phoneNumber: string;
  readonly initialUpdatePosition: string | null;

  private client: GramJsClientStub | null = null;
  private isClientConnected: boolean = false;
  private inboundSubscription: InboundUpdateSubscription | null = null;
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
    apiHash?: string | null;
    phoneNumber: string;
    initialUpdatePosition?: string | null;
  }) {
    this.districtId = params.districtId;
    this.sessionString = params.sessionString;
    this.apiId = params.apiId;
    this.apiHash = params.apiHash ?? null;
    this.phoneNumber = params.phoneNumber;
    this.initialUpdatePosition = params.initialUpdatePosition ?? null;
  }

  private async loadGramJs(): Promise<TelegramLibrary<GramJsClientStub>> {
    try {
      return await loadTelegramLibrary<GramJsClientStub>(DEFAULT_TELEGRAM_LIBRARY_SPECIFIER);
    } catch (err: unknown) {
      throw new Error(
        'GramJS (telegram) client library is not installed in the environment. Please ensure telegram is installed on the host to execute live MTProto connections.',
        { cause: err },
      );
    }
  }

  async connect(): Promise<void> {
    try {
      const { TelegramClient, StringSession, RawUpdateEvent } = await this.loadGramJs();
      const stringSession = new StringSession(this.sessionString);
      const tgClient = new TelegramClient(
        stringSession,
        Number(this.apiId),
        this.apiHash || '',
        {
          connectionRetries: 5,
          catchUp: true,
        },
      );

      if (this.initialUpdatePosition && typeof tgClient.updateManager?.refreshFromState === 'function') {
        try {
          const parsed = JSON.parse(this.initialUpdatePosition);
          if (parsed && typeof parsed.pts === 'number') {
            tgClient.updateManager.refreshFromState(parsed);
          }
        } catch (err: unknown) {
          logger.warn(
            { districtId: this.districtId, err },
            'Failed to restore update position from initialUpdatePosition',
          );
        }
      }

      await tgClient.connect();
      this.client = tgClient;

      // A connected client is by construction a subscribed client: the inbound subscription is
      // installed after connect succeeds and before `reconnect` is emitted, so no consumer that
      // reacts to that signal can ever observe a connected-but-deaf transport.
      this.subscribeToInboundUpdates(tgClient, RawUpdateEvent);

      this.isClientConnected = true;
      this.emit('reconnect');
    } catch (err: unknown) {
      this.isClientConnected = false;
      const signal = classifyTelegramSignal(err);
      const errorObj = toUserbotSignalError(err);
      this.emit('signal', signal);
      if (signal.category === 'ACCOUNT_BANNED') {
        this.emit('ban', { reason: signal.reason, error: errorObj });
      } else if (signal.category === 'UNRECOVERABLE_GAP') {
        this.emit('gap', {
          reason: signal.reason,
          lastKnownPosition: this.getUpdatePosition(),
          error: errorObj,
        });
      } else {
        this.emit('error', errorObj);
      }
      throw err;
    }
  }

  /**
   * Bridges raw library updates onto the adapter's `message` event. The adapter interprets,
   * normalizes, authorizes and persists nothing — it only forwards the raw update unchanged,
   * exactly as a test client does when it emits.
   */
  private subscribeToInboundUpdates(
    client: GramJsClientStub,
    RawUpdateEvent: TelegramEventBuilderConstructor,
  ): void {
    if (typeof client.addEventHandler !== 'function') {
      throw new Error(
        'MTProto client library does not expose addEventHandler; cannot subscribe to inbound updates.',
      );
    }

    const event = new RawUpdateEvent({});
    const callback = (update: unknown): void => {
      // Per-update error isolation: one malformed update is logged and skipped. A failure to
      // hand off a single update must not tear down the subscription or escape into the
      // library's dispatch loop.
      try {
        const updateObj = update as Record<string, unknown> | null;
        const typeName = typeof updateObj?._ === 'string' ? updateObj._ : '';
        const signal = classifyTelegramSignal(typeName || update);
        if (signal.category === 'UNRECOVERABLE_GAP') {
          this.emit('gap', {
            reason: typeName || signal.reason,
            lastKnownPosition: this.getUpdatePosition(),
          });
          this.emit('signal', signal);
        }
        this.emit('message', update);
      } catch (err: unknown) {
        logger.error(
          { districtId: this.districtId, err },
          'Error bridging inbound MTProto update; update skipped',
        );
      }
    };

    client.addEventHandler(callback, event);
    this.inboundSubscription = { callback, event };
  }

  /**
   * Releases the inbound subscription. Called after the client's own disconnect completes and
   * before the `disconnect` event is emitted, so a torn-down adapter receives nothing.
   */
  private releaseInboundSubscription(client: GramJsClientStub): void {
    const subscription = this.inboundSubscription;
    this.inboundSubscription = null;

    if (!subscription || typeof client.removeEventHandler !== 'function') {
      return;
    }

    try {
      client.removeEventHandler(subscription.callback, subscription.event);
    } catch (err: unknown) {
      logger.warn(
        { districtId: this.districtId, err },
        'Error releasing inbound MTProto update subscription',
      );
    }
  }

  async disconnect(): Promise<void> {
    this.isClientConnected = false;
    const client = this.client;

    if (client) {
      try {
        await client.disconnect();
      } catch (err: unknown) {
        logger.warn({ districtId: this.districtId, err }, 'Error during GramJs disconnect');
      } finally {
        this.releaseInboundSubscription(client);
        this.client = null;
        this.emit('disconnect');
      }
    } else {
      this.inboundSubscription = null;
    }
  }

  isConnected(): boolean {
    return this.isClientConnected;
  }

  getUpdatePosition(): string | null {
    const state = this.client?.updateManager?.state;
    if (!state || typeof state.pts !== 'number') {
      return null;
    }
    return JSON.stringify({
      version: 'teleproto-v1',
      pts: state.pts,
      qts: state.qts,
      date: state.date,
      seq: state.seq,
    });
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
      case 'gap':
        this.listeners.gap.push(listener);
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
      case 'gap':
        this.listeners.gap = this.listeners.gap.filter((l) => l !== listener);
        break;
      case 'signal':
        this.listeners.signal = this.listeners.signal.filter((l) => l !== listener);
        break;
    }
  }

  private emit(event: 'reconnect'): void;
  private emit(event: 'disconnect', reason?: string | Error): void;
  private emit(event: 'message', update: unknown): void;
  private emit(event: 'error', err: Error): void;
  private emit(event: 'ban', details?: { reason?: string; error?: Error }): void;
  private emit(event: 'gap', details?: { reason?: string; lastKnownPosition?: string | null; error?: Error }): void;
  private emit(event: 'signal', signal: ClassifiedUserbotSignal): void;
  private emit(event: keyof UserbotClientEvents, arg?: unknown): void {
    try {
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
        case 'gap':
          if (typeof arg === 'object' && arg !== null) {
            for (const fn of this.listeners.gap) fn(arg as any);
          }
          break;
        case 'signal':
          if (typeof arg === 'object' && arg !== null) {
            for (const fn of this.listeners.signal) fn(arg as ClassifiedUserbotSignal);
          }
          break;
      }
    } catch (err: unknown) {
      logger.error({ districtId: this.districtId, event, err }, 'Error in UserbotClient listener');
    }
  }
}

export function createDefaultUserbotClientFactory(): UserbotClientFactory {
  return (params) => new GramJsUserbotClient(params);
}
