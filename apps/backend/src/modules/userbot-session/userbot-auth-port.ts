/**
 * MTProto Userbot Authentication Port & Domain Errors (Ticket 05).
 * Adheres strictly to AD-1 (Hexagonal Architecture / Pure Domain Port),
 * explicit parameters, and pure interfaces without concrete MTProto coupling.
 */

export interface SendCodeResult {
  phoneCodeHash: string;
  isCodeViaApp?: boolean;
}

export interface SignInParams {
  phoneNumber: string;
  phoneCodeHash: string;
  phoneCode: string;
}

export type SignInResult =
  | { sessionString: string }
  | { requiresPassword: true };

export interface SignInWithPasswordParams {
  password: string;
}

export interface UserbotAuthClientPort {
  sendCode(phoneNumber: string, apiId: string, apiHash: string): Promise<SendCodeResult>;
  signIn(params: SignInParams): Promise<SignInResult>;
  signInWithPassword(params: SignInWithPasswordParams): Promise<{ sessionString: string }>;
}

export class UserbotAuthError extends Error {
  readonly code: string = 'USERBOT_AUTH_ERROR';
  readonly statusCode: number = 400;
  constructor(message: string) {
    super(message);
    this.name = 'UserbotAuthError';
  }
}

export class PhoneNumberBannedError extends UserbotAuthError {
  override readonly code = 'PHONE_NUMBER_BANNED';
  constructor(phoneNumber: string) {
    super(`Phone number ${phoneNumber} is banned from Telegram.`);
    this.name = 'PhoneNumberBannedError';
  }
}

export class InvalidPhoneCodeError extends UserbotAuthError {
  override readonly code = 'PHONE_CODE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPhoneCodeError';
  }
}

export class Invalid2FAPasswordError extends UserbotAuthError {
  override readonly code = 'PASSWORD_HASH_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'Invalid2FAPasswordError';
  }
}
