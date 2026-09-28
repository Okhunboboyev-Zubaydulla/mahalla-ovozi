/**
 * MTProto Userbot Client Adapter (Ticket 07).
 * Implements UserbotClientPort using GramJS (telegram) dynamic import.
 */

import {
  UserbotClientPort,
  UserbotClientFactory,
  UserbotClientEvents,
  _AssertPassiveOnlyPort,
} from '../../modules/userbot/userbot-client-port.js';
import { logger } from '../../utils/logger.js';

interface GramJsClientStub {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  connected?: boolean;
}

interface TelegramClientOptions {
  connectionRetries?: number;
  catchUp?: boolean;
  [key: string]: unknown;
}

interface TelegramModuleStub {
  TelegramClient: new (
    session: unknown,
    apiId: number,
    apiHash: string,
    options: TelegramClientOptions,
  ) => GramJsClientStub;
}

interface SessionModuleStub {
  StringSession: new (session: string) => unknown;
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

  private client: GramJsClientStub | null = null;
  private isClientConnected: boolean = false;
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
    apiHash?: string | null;
    phoneNumber: string;
  }) {
    this.districtId = params.districtId;
    this.sessionString = params.sessionString;
    this.apiId = params.apiId;
    this.apiHash = params.apiHash ?? null;
    this.phoneNumber = params.phoneNumber;
  }

  private async loadGramJs(): Promise<{
    TelegramClient: new (
      session: unknown,
      apiId: number,
      apiHash: string,
      options: TelegramClientOptions,
    ) => GramJsClientStub;
    StringSession: new (session: string) => unknown;
  }> {
    try {
      const modName = 'telegram';
      const telegramMod = (await import(modName)) as TelegramModuleStub;
      const sessionModPath = 'telegram/sessions/index.js';
      const sessionMod = (await import(sessionModPath)) as SessionModuleStub;
      return {
        TelegramClient: telegramMod.TelegramClient,
        StringSession: sessionMod.StringSession,
      };
    } catch (err: unknown) {
      throw new Error(
        'GramJS (telegram) client library is not installed in the environment. Please ensure telegram is installed on the host to execute live MTProto connections.',
        { cause: err },
      );
    }
  }

  async connect(): Promise<void> {
    try {
      const { TelegramClient, StringSession } = await this.loadGramJs();
      const stringSession = new StringSession(this.sessionString);
      const tgClient = new TelegramClient(
        stringSession,
        Number(this.apiId),
        this.apiHash || '',
        {
          connectionRetries: 5,
          catchUp: false,
        },
      );

      await tgClient.connect();
      this.client = tgClient;
      this.isClientConnected = true;
      this.emit('reconnect');
    } catch (err: unknown) {
      this.isClientConnected = false;
      const msg = err instanceof Error ? err.message : String(err);
      const errorObj = err instanceof Error ? err : new Error(String(err));
      if (msg.includes('PHONE_NUMBER_BANNED')) {
        this.emit('ban', { reason: 'PHONE_NUMBER_BANNED', error: errorObj });
      } else {
        this.emit('error', errorObj);
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.isClientConnected = false;
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (err: unknown) {
        logger.warn({ districtId: this.districtId, err }, 'Error during GramJs disconnect');
      } finally {
        this.client = null;
        this.emit('disconnect');
      }
    }
  }

  isConnected(): boolean {
    return this.isClientConnected;
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

  private emit(event: 'reconnect'): void;
  private emit(event: 'disconnect', reason?: string | Error): void;
  private emit(event: 'message', update: unknown): void;
  private emit(event: 'error', err: Error): void;
  private emit(event: 'ban', details?: { reason?: string; error?: Error }): void;
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
      }
    } catch (err: unknown) {
      logger.error({ districtId: this.districtId, event, err }, 'Error in UserbotClient listener');
    }
  }
}

export function createDefaultUserbotClientFactory(): UserbotClientFactory {
  return (params) => new GramJsUserbotClient(params);
}
