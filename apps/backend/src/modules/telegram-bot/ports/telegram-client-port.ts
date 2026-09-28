/**
 * Domain port defining the Telegram Bot API contract.
 *
 * Error classes live here (domain boundary) rather than in the adapter so that
 * domain services and route handlers depend only on this port — never on a
 * concrete adapter implementation.  The adapter imports from here and
 * re-exports for backward-compat shims during migration.
 *
 * AD-1: Hexagonal Architecture — adapters import from domain, not the reverse.
 */

// ── Telegram Integration Error Hierarchy ────────────────────────────────────

export class TelegramIntegrationError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  constructor(message: string, code: string, httpStatus: number) {
    super(message);
    this.name = 'TelegramIntegrationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Type-guard predicate for TelegramIntegrationError. */
export function isTelegramIntegrationError(err: unknown): err is TelegramIntegrationError {
  return err instanceof TelegramIntegrationError;
}

export class TelegramInvalidTokenError extends TelegramIntegrationError {
  constructor(message = 'Telegram бот токени ҳақиқий эмас ёки бот топилмади.') {
    super(message, 'TELEGRAM_INVALID_TOKEN', 400);
    this.name = 'TelegramInvalidTokenError';
  }
}

export class TelegramNetworkTimeoutError extends TelegramIntegrationError {
  constructor(message = 'Telegram сервери билан боғланиш вақти тугади (5 сония).') {
    super(message, 'TELEGRAM_TIMEOUT', 504);
    this.name = 'TelegramNetworkTimeoutError';
  }
}

export class TelegramRateLimitError extends TelegramIntegrationError {
  constructor(
    message = 'Telegram сўровлар сони чекланди. Бироздан сўнг қайта уриниб кўринг.',
  ) {
    super(message, 'TELEGRAM_RATE_LIMITED', 429);
    this.name = 'TelegramRateLimitError';
  }
}

export class TelegramApiError extends TelegramIntegrationError {
  constructor(message = 'Telegram серверига уланишда хатолик юз берди.') {
    super(message, 'TELEGRAM_API_ERROR', 502);
    this.name = 'TelegramApiError';
  }
}

export class TelegramChatNotFoundError extends TelegramIntegrationError {
  constructor(message = 'Telegram гуруҳи топилмади ёки бот ушбу гуруҳга қўшилмаган.') {
    super(message, 'BOT_NOT_IN_GROUP', 400);
    this.name = 'TelegramChatNotFoundError';
  }
}

export class TelegramBotNotMemberError extends TelegramIntegrationError {
  constructor(message = 'Telegram бот мазкур гуруҳга аъзо эмас.') {
    super(message, 'BOT_NOT_IN_GROUP', 400);
    this.name = 'TelegramBotNotMemberError';
  }
}

export class TelegramBotIsAdminError extends TelegramIntegrationError {
  constructor(
    message = 'Хавфсизлик талаби: Бот Telegram гуруҳда администратор бўлмаслиги керак, фақат оддий аъзо бўлиши шарт.',
  ) {
    super(message, 'BOT_IS_ADMIN_FORBIDDEN', 400);
    this.name = 'TelegramBotIsAdminError';
  }
}

export class TelegramPrivacyModeEnabledError extends TelegramIntegrationError {
  constructor(
    message = 'Telegram ботда гуруҳ махфийлик режими фаол. @BotFather орқали махфийлик режимини ўчиринг (/setprivacy -> Disable).',
  ) {
    super(message, 'TELEGRAM_PRIVACY_MODE_ENABLED', 400);
    this.name = 'TelegramPrivacyModeEnabledError';
  }
}

// ── Shared Value Types ───────────────────────────────────────────────────────

export interface ValidatedTelegramBot {
  botId: string;
  botFirstName: string;
  botUsername: string | null;
}

export interface TelegramChatInfo {
  chatId: string;
  chatTitle: string;
  chatType: string;
  chatUsername: string | null;
}

export interface TelegramClientOptions {
  timeoutMs?: number;
  baseUrl?: string;
  customFetch?: typeof fetch;
}

// ── Port Interface ───────────────────────────────────────────────────────────

/**
 * Technology-agnostic contract for interacting with the Telegram Bot API.
 * Domain services depend only on this interface; adapters implement it.
 */
export interface TelegramClientPort {
  validateBot(token: string, options?: TelegramClientOptions): Promise<ValidatedTelegramBot>;
  getChatInfo(token: string, chatId: string, options?: TelegramClientOptions): Promise<TelegramChatInfo>;
  verifyMembership(token: string, chatId: string, botId: string, options?: TelegramClientOptions): Promise<{ status: 'member' }>;
  checkPrivacyMode(token: string, options?: TelegramClientOptions): Promise<boolean>;
}
