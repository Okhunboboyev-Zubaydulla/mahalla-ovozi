// Error classes live in the domain port (AD-1: adapters import from domain, not the reverse).
// Imported and re-exported here so existing consumers continue to compile without changes.
import {
  TelegramIntegrationError,
  isTelegramIntegrationError,
  TelegramInvalidTokenError,
  TelegramNetworkTimeoutError,
  TelegramRateLimitError,
  TelegramApiError,
  TelegramChatNotFoundError,
  TelegramBotNotMemberError,
  TelegramBotIsAdminError,
  TelegramPrivacyModeEnabledError,
  type ValidatedTelegramBot,
  type TelegramChatInfo,
} from '../../modules/telegram-bot/ports/telegram-client-port.js';

export {
  TelegramIntegrationError,
  isTelegramIntegrationError,
  TelegramInvalidTokenError,
  TelegramNetworkTimeoutError,
  TelegramRateLimitError,
  TelegramApiError,
  TelegramChatNotFoundError,
  TelegramBotNotMemberError,
  TelegramBotIsAdminError,
  TelegramPrivacyModeEnabledError,
  type ValidatedTelegramBot,
  type TelegramChatInfo,
};

/**
 * Sanitizes Telegram API URLs and text occurrences to ensure tokens are never leaked into logs or errors.
 */
export function redactTokenFromUrl(text: string, token?: string): string {
  let result = text.replace(/\/bot[^/]+/g, '/bot[REDACTED]');
  if (token) {
    result = result.replaceAll(token, '[REDACTED]');
  }
  return result;
}

export interface ValidateTelegramBotOptions {
  timeoutMs?: number;
  baseUrl?: string;
  customFetch?: typeof fetch;
}

interface TelegramGetMeResponse {
  ok?: boolean;
  result?: {
    id?: number | string;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
  };
  description?: string;
  error_code?: number;
}

const TELEGRAM_TOKEN_REGEX = /^\d{6,16}:[a-zA-Z0-9_-]{20,50}$/;

interface TelegramApiRequestOptions {
  token: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  adapterOptions?: ValidateTelegramBotOptions;
}

/**
 * Executes a single Telegram Bot API request with timeout, token redaction,
 * and standard error mapping. Returns the raw Response and parsed JSON body.
 *
 * Throws:
 *   TelegramNetworkTimeoutError — AbortSignal/timeout fired
 *   TelegramRateLimitError      — HTTP 429
 *   TelegramApiError            — network failure or unparseable response body
 */
async function telegramApiRequest<T>(options: TelegramApiRequestOptions): Promise<{ response: Response; data: T }> {
  const { token, path, method = 'GET', body, adapterOptions = {} } = options;

  const baseUrl = (
    adapterOptions.baseUrl ??
    process.env.TELEGRAM_API_BASE_URL ??
    'https://api.telegram.org'
  ).replace(/\/+$/, '');
  const url = `${baseUrl}/bot${token}/${path}`;
  const timeoutMs = adapterOptions.timeoutMs ?? 5000;
  const fetchFn = adapterOptions.customFetch ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorName = err instanceof Error ? err.name : '';
    const isTimeout =
      errorName === 'TimeoutError' ||
      errorName === 'AbortError' ||
      /timeout|abort/i.test(errorMessage);

    if (isTimeout) {
      throw new TelegramNetworkTimeoutError();
    }

    const sanitizedMessage = redactTokenFromUrl(errorMessage, token);
    throw new TelegramApiError(`Telegram API сўрови бажарилмади: ${sanitizedMessage}`);
  }

  if (response.status === 429) {
    throw new TelegramRateLimitError();
  }

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    throw new TelegramApiError('Telegram жавобини ўқиб бўлмади.');
  }

  return { response, data };
}

/**
 * Authoritatively validates a Telegram bot token against Telegram Bot API (getMe).
 * Enforces timeout (5000ms), URL token redaction, and strict error mapping.
 * Pure HTTP execution strictly outside database transactions.
 */
export async function validateTelegramBot(
  token: string,
  options: ValidateTelegramBotOptions = {},
): Promise<ValidatedTelegramBot> {
  const trimmedToken = token?.trim() ?? '';
  if (!TELEGRAM_TOKEN_REGEX.test(trimmedToken)) {
    throw new TelegramInvalidTokenError('Telegram бот токени ҳақиқий эмас ёки формати нотўғри.');
  }

  const { response, data } = await telegramApiRequest<TelegramGetMeResponse>({
    token: trimmedToken,
    path: 'getMe',
    adapterOptions: options,
  });

  if (response.status === 400 || response.status === 401 || response.status === 404) {
    throw new TelegramInvalidTokenError();
  }

  if (!response.ok) {
    throw new TelegramApiError();
  }

  if (!data?.ok || !data?.result || !data.result.is_bot || !data.result.id) {
    throw new TelegramInvalidTokenError('Telegram ҳисоби бот эмас ёки маълумотлар тўлиқ эмас.');
  }

  return {
    botId: String(data.result.id),
    botFirstName: String(data.result.first_name || ''),
    botUsername: data.result.username ? String(data.result.username) : null,
  };
}


interface TelegramGetChatResponse {
  ok?: boolean;
  result?: {
    id?: number | string;
    title?: string;
    type?: string;
    username?: string;
  };
  description?: string;
  error_code?: number;
}

interface TelegramGetChatMemberResponse {
  ok?: boolean;
  result?: {
    status?: string;
    user?: {
      id?: number | string;
      is_bot?: boolean;
      first_name?: string;
    };
  };
  description?: string;
  error_code?: number;
}

interface TelegramPrivacyResponse {
  ok?: boolean;
  result?: {
    id?: number | string;
    can_read_all_group_messages?: boolean;
  };
  description?: string;
  error_code?: number;
}


/**
 * Authoritatively retrieves Telegram chat/group details via getChat.
 */
export async function getTelegramChat(
  token: string,
  chatId: string,
  options: ValidateTelegramBotOptions = {},
): Promise<TelegramChatInfo> {
  const trimmedToken = token?.trim() ?? '';
  const trimmedChatId = chatId?.trim() ?? '';
  if (!trimmedToken || !trimmedChatId) {
    throw new TelegramChatNotFoundError('Telegram токени ёки гуруҳ ID киритилмаган.');
  }

  const { response, data } = await telegramApiRequest<TelegramGetChatResponse>({
    token: trimmedToken,
    path: 'getChat',
    method: 'POST',
    body: { chat_id: trimmedChatId },
    adapterOptions: options,
  });

  if (
    response.status === 400 ||
    response.status === 404 ||
    !data?.ok ||
    !data.result ||
    !data.result.id
  ) {
    throw new TelegramChatNotFoundError(
      data?.description ? `Telegram гуруҳи топилмади: ${data.description}` : undefined,
    );
  }

  return {
    chatId: String(data.result.id),
    chatTitle: String(data.result.title || ''),
    chatType: String(data.result.type || ''),
    chatUsername: data.result.username ? String(data.result.username) : null,
  };
}

/**
 * Authoritatively verifies that the bot is an ordinary non-admin member in the specified chat.
 * Strictly enforces passive non-admin security boundary (FR-1, AC 4).
 */
export async function verifyBotGroupMembership(
  token: string,
  chatId: string,
  botId: string,
  options: ValidateTelegramBotOptions = {},
): Promise<{ status: 'member' }> {
  const trimmedToken = token?.trim() ?? '';
  const trimmedChatId = chatId?.trim() ?? '';
  const trimmedBotId = botId?.trim() ?? '';

  const { response, data } = await telegramApiRequest<TelegramGetChatMemberResponse>({
    token: trimmedToken,
    path: 'getChatMember',
    method: 'POST',
    body: { chat_id: trimmedChatId, user_id: trimmedBotId },
    adapterOptions: options,
  });

  if (response.status === 400 || response.status === 404 || !data?.ok || !data.result) {
    throw new TelegramBotNotMemberError(
      data?.description ? `Бот гуруҳ аъзоси эмас: ${data.description}` : undefined,
    );
  }

  const membershipStatus = data.result.status;
  if (membershipStatus === 'administrator' || membershipStatus === 'creator') {
    throw new TelegramBotIsAdminError();
  }

  if (membershipStatus !== 'member') {
    throw new TelegramBotNotMemberError();
  }

  return { status: 'member' };
}

/**
 * Evaluates whether Telegram Group Privacy Mode is disabled (AC 5).
 * Returns true if can_read_all_group_messages is true, false otherwise.
 */
export async function checkGroupPrivacyMode(
  token: string,
  options: ValidateTelegramBotOptions = {},
): Promise<boolean> {
  const trimmedToken = token?.trim() ?? '';

  const { response, data } = await telegramApiRequest<TelegramPrivacyResponse>({
    token: trimmedToken,
    path: 'getMe',
    adapterOptions: options,
  });

  if (!response.ok) {
    throw new TelegramApiError('Бот маълумотларини олиб бўлмади.');
  }

  return Boolean(data?.ok && data?.result?.can_read_all_group_messages === true);
}
