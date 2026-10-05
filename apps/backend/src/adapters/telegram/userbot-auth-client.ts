/**
 * MTProto Userbot Auth Adapter (Ticket 05).
 * Connects Telegram MTProto authentication flow to the UserbotAuthClientPort.
 * Isolated strictly behind this adapter boundary.
 */

import {
  UserbotAuthClientPort,
  SendCodeResult,
  SignInParams,
  SignInResult,
  SignInWithPasswordParams,
  UserbotAuthError,
  PhoneNumberBannedError,
  InvalidPhoneCodeError,
  Invalid2FAPasswordError,
} from '../../modules/userbot-session/userbot-auth-port.js';
import {
  loadTelegramLibrary,
  DEFAULT_TELEGRAM_LIBRARY_SPECIFIER,
} from './telegram-library-loader.js';

export type {
  UserbotAuthClientPort,
  SendCodeResult,
  SignInParams,
  SignInResult,
  SignInWithPasswordParams,
};

export {
  UserbotAuthError,
  PhoneNumberBannedError,
  InvalidPhoneCodeError,
  Invalid2FAPasswordError,
};

interface GramJsClientStub {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendCode(params: { apiId: number; apiHash: string }, phoneNumber: string): Promise<{ phoneCodeHash: string; isCodeViaApp?: boolean }>;
  signInUser(
    params: { apiId: number; apiHash: string },
    auth: {
      phoneNumber: string;
      phoneCodeHash?: string;
      phoneCode: string | ((isCodeViaApp?: boolean) => Promise<string>);
      onError?: (err: unknown) => Promise<boolean> | void;
    },
  ): Promise<unknown>;
  signInWithPassword(
    params: { apiId: number; apiHash: string },
    auth: {
      password: string | ((hint?: string) => Promise<string>);
      onError?: (err: unknown) => Promise<boolean> | void;
    },
  ): Promise<unknown>;
  session: {
    save(): string;
  };
}

/**
 * Production GramJS MTProto auth client implementation.
 * Safely dynamic-imports 'telegram' client if present in the runtime environment.
 */
export class GramJsUserbotAuthClient implements UserbotAuthClientPort {
  private client: GramJsClientStub | null = null;
  private currentApiId: string | null = null;
  private currentApiHash: string | null = null;

  private async loadGramJs(): Promise<{
    TelegramClient: new (session: unknown, apiId: number, apiHash: string, options: Record<string, unknown>) => GramJsClientStub;
    StringSession: new (session: string) => unknown;
  }> {
    try {
      return await loadTelegramLibrary<GramJsClientStub>(DEFAULT_TELEGRAM_LIBRARY_SPECIFIER);
    } catch {
      throw new UserbotAuthError(
        'GramJS (telegram) client library is not installed in the environment. Please ensure telegram is installed on the host to execute live MTProto authentication.',
      );
    }
  }

  async sendCode(phoneNumber: string, apiId: string, apiHash: string): Promise<SendCodeResult> {
    const { TelegramClient, StringSession } = await this.loadGramJs();

    this.currentApiId = apiId;
    this.currentApiHash = apiHash;

    const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, {
      connectionRetries: 5,
    });

    try {
      await client.connect();
      const result = await client.sendCode(
        {
          apiId: Number(apiId),
          apiHash,
        },
        phoneNumber,
      );

      this.client = client;
      return {
        phoneCodeHash: result.phoneCodeHash,
        isCodeViaApp: result.isCodeViaApp,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('PHONE_NUMBER_BANNED')) {
        throw new PhoneNumberBannedError(phoneNumber);
      }
      throw new UserbotAuthError(`Failed to send Telegram confirmation code: ${msg}`);
    }
  }

  async signIn(params: SignInParams): Promise<SignInResult> {
    if (!this.client || !this.currentApiId || !this.currentApiHash) {
      throw new UserbotAuthError('No active authentication session. Must call sendCode first.');
    }

    try {
      await this.client.signInUser(
        {
          apiId: Number(this.currentApiId),
          apiHash: this.currentApiHash,
        },
        {
          phoneNumber: params.phoneNumber,
          phoneCodeHash: params.phoneCodeHash,
          phoneCode: typeof params.phoneCode === 'function' ? params.phoneCode : async () => params.phoneCode,
          onError: (err: unknown) => {
            throw err;
          },
        },
      );

      const sessionString = this.client.session.save();
      return { sessionString };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('SESSION_PASSWORD_NEEDED') || msg.includes('2FA enabled')) {
        return { requiresPassword: true };
      }
      if (msg.includes('PHONE_CODE_INVALID') || msg.includes('PHONE_CODE_EXPIRED')) {
        throw new InvalidPhoneCodeError(`Invalid or expired phone code: ${msg}`);
      }
      if (msg.includes('PHONE_NUMBER_BANNED')) {
        throw new PhoneNumberBannedError(params.phoneNumber);
      }
      throw new UserbotAuthError(`Failed to sign in to Telegram userbot: ${msg}`);
    }
  }

  async signInWithPassword(params: SignInWithPasswordParams): Promise<{ sessionString: string }> {
    if (!this.client || !this.currentApiId || !this.currentApiHash) {
      throw new UserbotAuthError('No active authentication session. Must call sendCode and signIn first.');
    }

    try {
      await this.client.signInWithPassword(
        {
          apiId: Number(this.currentApiId),
          apiHash: this.currentApiHash,
        },
        {
          password: typeof params.password === 'function' ? params.password : async () => params.password,
          onError: (err: unknown) => {
            throw err;
          },
        },
      );

      const sessionString = this.client.session.save();
      return { sessionString };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('PASSWORD_HASH_INVALID')) {
        throw new Invalid2FAPasswordError(`Invalid 2FA password: ${msg}`);
      }
      throw new UserbotAuthError(`Failed to sign in with 2FA password: ${msg}`);
    }
  }
}

export function createDefaultUserbotAuthClient(): UserbotAuthClientPort {
  return new GramJsUserbotAuthClient();
}
