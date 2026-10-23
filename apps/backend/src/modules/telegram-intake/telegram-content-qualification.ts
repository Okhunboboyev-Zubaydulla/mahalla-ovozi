/**
 * Pure domain content qualification engine for Telegram messages (Story 2.2).
 * Adheres strictly to AD-1 (Hexagonal Architecture / Pure Domain Logic),
 * AD-9 (Tenant Scope Attribution), and AD-11 (Privacy-Safe Telemetry).
 *
 * Evaluates structural validity of Telegram messages before AI semantic analysis.
 * Preserves verbatim text/captions without mutation and discards structural exclusions.
 */

import type { TelegramReplyMetadata, ForwardMetadata, ForwardOriginType } from '../../adapters/jobs/boss-client.js';
export type { TelegramReplyMetadata, ForwardMetadata, ForwardOriginType };

// Re-export protocol types so consumers who currently import from this module continue to compile.
export type {
  TelegramUser,
  TelegramChat,
  TelegramMessageOrigin,
  TelegramMessageEntity,
  TelegramMessage,
  TelegramIncomingMessage,
} from '../../adapters/telegram/telegram-types.js';

import type {
  TelegramMessage,
  TelegramIncomingMessage,
} from '../../adapters/telegram/telegram-types.js';
import type { TelegramIntakeSource } from '../../adapters/db/schema/telegram-intakes.js';

export type StructuralExclusionReason =
  | 'FORWARDED_MESSAGE'
  | 'BOT_MESSAGE'
  | 'BOT_COMMAND'
  | 'SERVICE_MESSAGE'
  | 'EMPTY_CONTENT'
  | 'CAPTIONLESS_MEDIA'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MALFORMED_METADATA';

export interface StructuralCandidate {
  intakeId: string;
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  telegramChatId: string;
  telegramMessageId: string;
  telegramUserId?: string;
  originalTimestamp: string; // ISO-8601 string
  contentType: 'TEXT' | 'MEDIA_CAPTION';
  verbatimText: string;
  replyMetadata: TelegramReplyMetadata | null;
  forwardMetadata: ForwardMetadata | null;
}

export type StructuralQualificationResult =
  | {
      status: 'SUPPORTED';
      candidate: StructuralCandidate;
    }
  | {
      status: 'EXCLUDED';
      reason: StructuralExclusionReason;
      districtId: string;
      mahallaName: string;
      telegramChatId: string;
      telegramMessageId: string;
    };

export interface TelegramIntakeRecordInput {
  id: string;
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  source: TelegramIntakeSource;
  telegramBotId?: string | null;
  telegramChatId: string;
  telegramMessageId: string;
  updateId?: string | null;
  telegramUserId?: string | null;
  originalTimestamp: Date | string;
  rawPayload: unknown;
}

/**
 * Evaluates whether an arbitrary timestamp is valid and converts it to ISO-8601 string.
 * Returns null if the timestamp is missing, unparseable, or an invalid Date.
 */
export function toSafeIsoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value as string | number);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return null;
  }
  return date.toISOString();
}

/**
 * Checks whether text contains meaningful characters after removing standard whitespace
 * and zero-width formatting characters (\\u200B-\\u200D, \\uFEFF, \\u2060, \\u00AD, \\u200E, \\u200F).
 */
export function hasMeaningfulText(text: unknown): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  return text.replace(/[\s\u200B-\u200D\uFEFF\u2060\u00AD\u200E\u200F]/g, '').length > 0;
}

/**
 * Evaluates whether a message is marked as forwarded via modern Bot API 7.0+
 * forward_origin, automatic forward flag, or legacy forward metadata.
 */
export function isTelegramForwarded(message: TelegramMessage): boolean {
  if (message.forward_origin != null) {
    return true;
  }
  if (message.is_automatic_forward === true) {
    return true;
  }
  if (
    message.forward_date != null ||
    message.forward_from != null ||
    message.forward_from_chat != null ||
    message.forward_from_message_id != null ||
    message.forward_sender_name != null ||
    message.forward_signature != null
  ) {
    return true;
  }
  return false;
}

/**
 * Evaluates whether a message originated directly from a bot or was sent via an inline bot.
 */
export function isTelegramBotMessage(message: TelegramMessage): boolean {
  if (message.from?.is_bot === true) {
    return true;
  }
  if (message.via_bot !== undefined && message.via_bot !== null) {
    return true;
  }
  return false;
}

/**
 * Evaluates whether a message represents a bot command.
 * Commands start with `/` or have a bot_command entity at offset 0.
 */
export function isTelegramCommand(message: TelegramMessage): boolean {
  if (Array.isArray(message.entities) && message.entities.some((e) => e?.type === 'bot_command' && e?.offset === 0)) {
    return true;
  }
  if (Array.isArray(message.caption_entities) && message.caption_entities.some((e) => e?.type === 'bot_command' && e?.offset === 0)) {
    return true;
  }
  if (typeof message.text === 'string' && message.text.trimStart().startsWith('/')) {
    return true;
  }
  if (typeof message.caption === 'string' && message.caption.trimStart().startsWith('/')) {
    return true;
  }
  return false;
}

const SERVICE_MESSAGE_KEYS: readonly string[] = [
  'new_chat_members',
  'new_chat_participant',
  'left_chat_member',
  'left_chat_participant',
  'new_chat_title',
  'new_chat_photo',
  'delete_chat_photo',
  'group_chat_created',
  'supergroup_chat_created',
  'channel_chat_created',
  'message_auto_delete_timer_changed',
  'migrate_to_chat_id',
  'migrate_from_chat_id',
  'pinned_message',
  'invoice',
  'successful_payment',
  'user_shared',
  'chat_shared',
  'write_access_allowed',
  'passport_data',
  'proximity_alert_triggered',
  'boost_added',
  'forum_topic_created',
  'forum_topic_edited',
  'forum_topic_closed',
  'forum_topic_reopened',
  'general_forum_topic_hidden',
  'general_forum_topic_unhidden',
  'giveaway',
  'giveaway_created',
  'giveaway_winners',
  'giveaway_completed',
  'video_chat_scheduled',
  'video_chat_started',
  'video_chat_ended',
  'video_chat_participants_invited',
  'web_app_data',
];

/**
 * Evaluates whether a message is an automated service/event message.
 */
export function isTelegramServiceMessage(message: TelegramMessage): boolean {
  for (const key of SERVICE_MESSAGE_KEYS) {
    if (message[key] !== undefined && message[key] !== null) {
      if (Array.isArray(message[key])) {
        if ((message[key] as unknown[]).length > 0) return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

const UNSUPPORTED_MEDIA_KEYS: readonly string[] = [
  'sticker',
  'video_note',
  'poll',
  'dice',
  'game',
  'story',
  'contact',
  'location',
  'venue',
];

function isMediaPresent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return typeof value === 'object';
}

/**
 * Evaluates whether a message contains media that never supports human topic discussion.
 */
function hasUnsupportedMediaType(message: TelegramMessage): boolean {
  for (const key of UNSUPPORTED_MEDIA_KEYS) {
    if (isMediaPresent(message[key])) {
      return true;
    }
  }
  return false;
}

const CAPTIONABLE_MEDIA_KEYS: readonly string[] = [
  'photo',
  'video',
  'document',
  'animation',
  'audio',
  'voice',
  'paid_media',
];

/**
 * Evaluates whether a message contains caption-capable media.
 */
function hasCaptionableMedia(message: TelegramMessage): boolean {
  for (const key of CAPTIONABLE_MEDIA_KEYS) {
    if (isMediaPresent(message[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts relationship metadata from reply_to_message if present.
 */
export function extractReplyMetadata(message: TelegramMessage): TelegramReplyMetadata | null {
  const reply = message.reply_to_message;
  if (!reply || typeof reply !== 'object') {
    return null;
  }

  const replyToMessageId = reply.message_id != null ? String(reply.message_id) : '';
  if (!replyToMessageId) {
    return null;
  }

  return {
    replyToMessageId,
    replyToUserId: reply.from?.id != null ? String(reply.from.id) : undefined,
    replyToIsForwarded: isTelegramForwarded(reply),
    replyToIsBot: isTelegramBotMessage(reply),
  };
}

/**
 * Extracts origin metadata from forwarded Telegram messages (modern Bot API 7.0+
 * forward_origin or legacy forward fields).
 * Returns null if the message has no forward origin information.
 */
export function extractForwardOriginMetadata(message: TelegramMessage): ForwardMetadata | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  // Modern Bot API 7.0+ forward_origin
  const origin = message.forward_origin;
  if (origin != null && typeof origin === 'object') {
    if (origin.type === 'channel') {
      const chatId = origin.chat?.id !== undefined && origin.chat?.id !== null ? String(origin.chat.id) : null;
      const messageId =
        origin.message_id !== undefined && origin.message_id !== null ? String(origin.message_id) : null;
      return {
        originChatId: chatId,
        originMessageId: messageId,
        originTitle: origin.chat?.title ?? null,
        originType: 'channel',
      };
    }

    if (origin.type === 'chat') {
      const chatId =
        origin.sender_chat?.id !== undefined && origin.sender_chat?.id !== null
          ? String(origin.sender_chat.id)
          : null;
      return {
        originChatId: chatId,
        originMessageId: null,
        originTitle: origin.sender_chat?.title ?? null,
        originType: 'chat',
      };
    }

    if (origin.type === 'user') {
      const parts = [origin.sender_user?.first_name, origin.sender_user?.last_name].filter(Boolean);
      return {
        originChatId: null,
        originMessageId: null,
        originTitle: parts.length > 0 ? parts.join(' ') : null,
        originType: 'user',
      };
    }

    if (origin.type === 'hidden_user') {
      return {
        originChatId: null,
        originMessageId: null,
        originTitle: origin.sender_user_name ?? null,
        originType: 'hidden_user',
      };
    }

    return {
      originChatId: null,
      originMessageId: null,
      originTitle: null,
      originType: null,
    };
  }

  // Legacy Bot API forward fields
  if (message.forward_from_chat != null && typeof message.forward_from_chat === 'object') {
    const chat = message.forward_from_chat;
    const chatId = chat.id !== undefined && chat.id !== null ? String(chat.id) : null;
    const messageId =
      message.forward_from_message_id !== undefined && message.forward_from_message_id !== null
        ? String(message.forward_from_message_id)
        : null;
    const originType: ForwardOriginType =
      chat.type === 'group' || chat.type === 'supergroup' ? 'chat' : 'channel';
    return {
      originChatId: chatId,
      originMessageId: messageId,
      originTitle: chat.title ?? null,
      originType,
    };
  }

  if (message.forward_from != null && typeof message.forward_from === 'object') {
    const user = message.forward_from;
    const parts = [user.first_name, user.last_name].filter(Boolean);
    const messageId =
      message.forward_from_message_id !== undefined && message.forward_from_message_id !== null
        ? String(message.forward_from_message_id)
        : null;
    return {
      originChatId: null,
      originMessageId: messageId,
      originTitle: parts.length > 0 ? parts.join(' ') : null,
      originType: 'user',
    };
  }

  if (typeof message.forward_sender_name === 'string') {
    return {
      originChatId: null,
      originMessageId: null,
      originTitle: message.forward_sender_name,
      originType: 'hidden_user',
    };
  }

  if (
    (message.forward_date !== undefined && message.forward_date !== null) ||
    (message.forward_from_message_id !== undefined && message.forward_from_message_id !== null) ||
    typeof message.forward_signature === 'string'
  ) {
    const messageId =
      message.forward_from_message_id !== undefined && message.forward_from_message_id !== null
        ? String(message.forward_from_message_id)
        : null;
    return {
      originChatId: null,
      originMessageId: messageId,
      originTitle: null,
      originType: null,
    };
  }

  return null;
}

/**
 * Pure qualification engine function.
 * Evaluates intake record and Telegram payload against structural rules in strict deterministic order.
 */
export function qualifyTelegramContent(
  record: TelegramIntakeRecordInput,
): StructuralQualificationResult {
  const baseExclusion = (reason: StructuralExclusionReason): StructuralQualificationResult => ({
    status: 'EXCLUDED',
    reason,
    districtId: record?.districtId ?? '',
    mahallaName: record?.mahallaName ?? '',
    telegramChatId: record?.telegramChatId ?? '',
    telegramMessageId: record?.telegramMessageId ?? '',
  });

  // Guard against malformed or missing record / payload
  if (!record || typeof record !== 'object' || !record.rawPayload || typeof record.rawPayload !== 'object') {
    return baseExclusion('MALFORMED_METADATA');
  }

  const payload = record.rawPayload as Record<string, unknown>;
  const rawMsg = (
    payload.message ??
    payload.channel_post ??
    payload.edited_message ??
    payload.edited_channel_post ??
    payload.business_message ??
    payload.edited_business_message ??
    payload
  ) as TelegramMessage;

  if (
    !rawMsg ||
    typeof rawMsg !== 'object' ||
    rawMsg.message_id === undefined ||
    rawMsg.message_id === null ||
    !rawMsg.chat ||
    typeof rawMsg.chat !== 'object'
  ) {
    return baseExclusion('MALFORMED_METADATA');
  }

  // 1. Automatic forward guard
  if (rawMsg.is_automatic_forward === true) {
    return baseExclusion('FORWARDED_MESSAGE');
  }

  // 2. Bot guard (AC 3)
  if (isTelegramBotMessage(rawMsg)) {
    return baseExclusion('BOT_MESSAGE');
  }

  // 3. Command guard (AC 3)
  if (isTelegramCommand(rawMsg)) {
    return baseExclusion('BOT_COMMAND');
  }

  // 4. Service message guard (AC 3)
  if (isTelegramServiceMessage(rawMsg)) {
    return baseExclusion('SERVICE_MESSAGE');
  }

  // 5. Unsupported media type guard (AC 3)
  if (hasUnsupportedMediaType(rawMsg)) {
    return baseExclusion('UNSUPPORTED_MEDIA_TYPE');
  }

  const isoTimestamp = toSafeIsoTimestamp(record.originalTimestamp);
  if (!isoTimestamp) {
    return baseExclusion('MALFORMED_METADATA');
  }

  const telegramUserId =
    record.telegramUserId != null && record.telegramUserId !== ''
      ? record.telegramUserId
      : (rawMsg.from?.id != null ? String(rawMsg.from.id) : undefined);

  // 6. Captionable media evaluation (AC 2 & AC 3)
  if (hasCaptionableMedia(rawMsg)) {
    if (typeof rawMsg.caption === 'string' && hasMeaningfulText(rawMsg.caption)) {
      return {
        status: 'SUPPORTED',
        candidate: {
          intakeId: record.id,
          districtId: record.districtId,
          mahallaName: record.mahallaName,
          calendarDay: record.calendarDay,
          telegramChatId: record.telegramChatId,
          telegramMessageId: record.telegramMessageId,
          telegramUserId,
          originalTimestamp: isoTimestamp,
          contentType: 'MEDIA_CAPTION',
          verbatimText: rawMsg.caption,
          replyMetadata: extractReplyMetadata(rawMsg),
          forwardMetadata: extractForwardOriginMetadata(rawMsg),
        },
      };
    }
    return baseExclusion('CAPTIONLESS_MEDIA');
  }

  // 7. Human text message evaluation (AC 1 & AC 3)
  if (typeof rawMsg.text === 'string') {
    if (hasMeaningfulText(rawMsg.text)) {
      return {
        status: 'SUPPORTED',
        candidate: {
          intakeId: record.id,
          districtId: record.districtId,
          mahallaName: record.mahallaName,
          calendarDay: record.calendarDay,
          telegramChatId: record.telegramChatId,
          telegramMessageId: record.telegramMessageId,
          telegramUserId,
          originalTimestamp: isoTimestamp,
          contentType: 'TEXT',
          verbatimText: rawMsg.text,
          replyMetadata: extractReplyMetadata(rawMsg),
          forwardMetadata: extractForwardOriginMetadata(rawMsg),
        },
      };
    }
    return baseExclusion('EMPTY_CONTENT');
  }

  // 8. Fallback for unhandled/malformed structure (AC 10)
  return baseExclusion('MALFORMED_METADATA');
}


export interface MessageFilterResult {
  accepted: boolean;
  reason?: 'BOT_SENDER' | 'FORWARDED_MESSAGE' | 'BOT_COMMAND' | 'EMPTY_CONTENT' | 'NON_TEXT';
  text?: string;
}

/**
 * Pure predicate enforcing strict message eligibility criteria (AC 7, FR-20):
 * - Rejects bot senders (`from.is_bot === true` or presence of `sender_chat`)
 * - Rejects forwarded messages (`forward_origin`, `forward_date`, `forward_from`, `forward_from_chat`)
 * - Rejects bot commands (starts with `/` or has `bot_command` entity)
 * - Extracts text or caption; rejects empty/whitespace content
 */
export function filterTelegramMessage(
  message: TelegramIncomingMessage | null | undefined,
): MessageFilterResult {
  if (!message) {
    return { accepted: false, reason: 'EMPTY_CONTENT' };
  }

  // 1. Rejects bot senders or channel author
  if (message.from?.is_bot || message.sender_chat) {
    return { accepted: false, reason: 'BOT_SENDER' };
  }

  // 2. Rejects forwarded messages (modern Bot API 7.0+ origin and legacy fields)
  if (isTelegramForwarded(message)) {
    return { accepted: false, reason: 'FORWARDED_MESSAGE' };
  }

  // 3. Extract text / caption
  const rawText = (message.text || message.caption || '').trim();
  if (!rawText || !hasMeaningfulText(rawText)) {
    return { accepted: false, reason: 'EMPTY_CONTENT' };
  }

  // 4. Rejects slash-command text (/start, /help)
  if (rawText.startsWith('/')) {
    return { accepted: false, reason: 'BOT_COMMAND' };
  }

  // 5. Rejects bot command entities
  const allEntities = [...(message.entities || []), ...(message.caption_entities || [])];
  if (allEntities.some((entity) => entity?.type === 'bot_command')) {
    return { accepted: false, reason: 'BOT_COMMAND' };
  }

  return { accepted: true, text: rawText };
}

/**
 * Canonical Uzbek script normalizer for matching routines:
 * - Unifies quote/apostrophe variants to single quote `'`
 * - Normalizes Uzbek mobile keyboard diacritics/breves:
 *   ŏ, ō, ö -> o'
 *   ğ -> g'
 *   yŭq, yūq, yüq -> yo'q
 *   bŏpti, bōpti, böpti -> bo'pti
 *   ŭ, ū, ü -> u
 * - Normalizes colloquial SMS contractions (yuq/yoq -> yo'q, bopti -> bo'pti, uchdi/ucdi/ochdi -> o'chdi, etc.)
 * - Normalizes multiple spaces and lowercases text
 */
export function normalizeUzbekScript(text: string): string {
  if (!text || typeof text !== 'string') return '';
  let normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0060\u00B4\u02B9\u02BA\u02BB\u02BC\u02BD\u02C8\u02CA\u2018\u2019\u201B\u2032\u2035]/g, "'");

  // Mobile keyboard breves / umlauts / macrons
  normalized = normalized.replace(/[ŏōö]/g, "o'");
  normalized = normalized.replace(/[ğ]/g, "g'");
  normalized = normalized.replace(/\by[ŭūü]q\b/g, "yo'q");
  normalized = normalized.replace(/\bb[ŏōö]pti\b/g, "bo'pti");
  normalized = normalized.replace(/[ŭūü]/g, 'u');

  // SMS contractions & colloquial spellings
  normalized = normalized.replace(/(?<![\p{L}\p{N}'])(?:yuq|yoq)(?![\p{L}\p{N}'])/gu, "yo'q");
  normalized = normalized.replace(/(?<![\p{L}\p{N}'])(?:bopti)(?![\p{L}\p{N}'])/gu, "bo'pti");
  normalized = normalized.replace(/(?<![\p{L}\p{N}'])(?:uch|uc|och)di(?![\p{L}\p{N}'])/gu, "o'chdi");
  normalized = normalized.replace(/(?<![\p{L}\p{N}'])(?:uch|uc|och)ipti(?![\p{L}\p{N}'])/gu, "o'chipti");

  // Cyrillic colloquial spellings
  normalized = normalized.replace(/(?<![\p{L}\p{N}'])(?:уч|уш)ди(?![\p{L}\p{N}'])/gu, "ўчди");
  normalized = normalized.replace(/(?<![\p{L}\p{N}'])(?:уч|уш)ипти(?![\p{L}\p{N}'])/gu, "ўчипти");
  normalized = normalized.replace(/(?<![\p{L}\p{N}'])(?:йук|йок)(?![\p{L}\p{N}'])/gu, "йўқ");
  normalized = normalized.replace(/(?<![\p{L}\p{N}'])(?:бупти)(?![\p{L}\p{N}'])/gu, "бўпти");

  // Whitespace normalization
  return normalized.replace(/\s+/g, ' ').trim();
}

export const CIVIC_LANE_KEYWORD_REGEX =
  /(?<![\p{L}\p{N}'])(?:raygaz|hududgaz|mingaz|gaz(?!el|on|et|in)[a-z']*|райгаз|ҳудудгаз|мингаз|газ(?!ель|он|ет|ин)[а-яёўқғҳ]*|svet(?!ofor)[a-z']*|свет(?!офор)[а-яёўқғҳ]*|svyet[a-z']*|свьет[а-яёўқғҳ]*|svit[a-z']*|свит[а-яёўқғҳ]*|chiro[qg][a-z']*|чиро[қк][а-яёўқғҳ]*|elektr[a-z']*|электр[а-яёўқғҳ]*|tok|ток|voltaj|вольтаж|napryajen[a-z']*|напряжен[а-яёўқғҳ]*|transformator[a-z']*|трансформатор[а-яёўқғҳ]*|suv(?!oq|arak)[a-z']*|сув(?!оқ|арак)[а-яёўқғҳ]*|vodoprovod[a-z']*|водопровод[а-яёўқғҳ]*|vodokanal[a-z']*|водоканал[а-яёўқғҳ]*|vodovoz[a-z']*|водовоз[а-яёўқғҳ]*|voda|вод[аыеуой][а-яёўқғҳ]*|kranta[a-z']*|кранта[а-яёўқғҳ]*|quvur[a-z']*|қувур[а-яёўқғҳ]*|truba[a-z']*|труба[а-яёўқғҳ]*|kanalizats[a-z']*|канализаци[а-яёўқғҳ]*|lyuk[a-z']*|люк[а-яёўқғҳ]*|nasos[a-z']*|насос[а-яёўқғҳ]*|musor[a-z']*|мусор[а-яёўқғҳ]*|musr[a-z']*|муср[а-яёўқғҳ]*|musir[a-z']*|мусир[а-яёўқғҳ]*|chiqindi[a-z']*|чиқинди[а-яёўқғҳ]*|axlat[a-z']*|ахлат[а-яёўқғҳ]*|svalka[a-z']*|свалка[а-яёўқғҳ]*|toza\s+hudud|тоза\s+ҳудуд|maxsustrans[a-z']*|махсустранс[а-яёўқғҳ]*|asfalt[a-z']*|асфальт[а-яёўқғҳ]*|ko'cha[a-z']*|кўча[а-яёўқғҳ]*|yo'l[a-z']*|йўл[а-яёўқғҳ]*|дорог[а-яёўқғҳ]*|hokim[a-z']*|ҳоким[а-яёўқғҳ]*|хоким[а-яёўқғҳ]*|xokim[a-z']*|hokimiyat[a-z']*|ҳокимият[а-яёўқғҳ]*|hokimlik[a-z']*|ҳокимлик[а-яёўқғҳ]*|tepadagilar[a-z']*|тепадагилар[а-яёўқғҳ]*|yuqoridagilar[a-z']*|юқоридагилар[а-яёўқғҳ]*|mas'ul[a-z']*|масъул[а-яёўқғҳ]*)(?![\p{L}\p{N}'])/iu;

/**
 * Pure domain predicate evaluating whether text contains at least one keyword matching
 * any of the 5 canonical civic lanes (Gaz, Elektr, Suv, Chiqindi, Hokimiyat) across
 * Uzbek Latin, Uzbek Cyrillic, and basic Russian equivalents.
 *
 * Uses Unicode boundary matching and canonical script normalization to eliminate
 * false-positive substring collisions while matching open roots and inflected suffixes.
 */
export function matchesCivicLaneKeyword(text: string): boolean {
  if (!text || typeof text !== 'string') {
    return false;
  }
  const normalized = normalizeUzbekScript(text);
  if (normalized.length === 0) {
    return false;
  }
  return CIVIC_LANE_KEYWORD_REGEX.test(normalized);
}

export const CONTEXTUAL_FOLLOW_UP_REGEX =
  /(?<![\p{L}\p{N}'])(?:remont[a-z']*|ta'mir[a-z']*|profilaktik[a-z']*|avariy[a-z']*|uchipti|ochipti|o'chipti|o'chibdi|o'chyapti|o'chdi|o'chgan|yo'q|past|bosim|siz[a-z']*|oqyapti|oqib|qachon|nega|nimaga|qayerda|qaysi|yonadimi|beradimi|keladimi|berishadi|bopti|bo'pti|bo'lyapti|bo'ldi|nima\s+bo'|bizdayam|bizda\s+ham|ремонт[а-яёўқғҳ]*|таъмир[а-яёўқғҳ]*|профилактик[а-яёўқғҳ]*|авария[а-яёўқғҳ]*|ўчипти|ўчибди|ўчяпти|ўчди|ўчган|йўқ|паст|босим|сиз[а-яёўқғҳ]*|оқяпти|оқиб|қачон|нега|нимага|қаерда|қайси|ёнадими|берадими|келадими|беришади|бўпти|бўляпти|бўлди|нима\s+бў|биздаям|бизда\s+ҳам)(?![\p{L}\p{N}'])/iu;

/**
 * Evaluates whether text contains a conversational follow-up signal that describes
 * outage causes or asks about repairs/restorations without repeating the utility noun.
 */
export function hasContextualFollowUpSignal(text: string): boolean {
  if (!text || typeof text !== 'string') {
    return false;
  }
  const normalized = normalizeUzbekScript(text);
  if (normalized.length === 0) {
    return false;
  }
  return CONTEXTUAL_FOLLOW_UP_REGEX.test(normalized);
}

const CIVIC_SUBJECT_REGEX =
  /(?<![\p{L}\p{N}'])(?:raygaz|hududgaz|mingaz|gaz(?!el|on|et|in)[a-z']*|райгаз|ҳудудгаз|мингаз|газ(?!ель|он|ет|ин)[а-яёўқғҳ]*|svet(?!ofor)[a-z']*|свет(?!офор)[а-яёўқғҳ]*|svyet[a-z']*|свьет[а-яёўқғҳ]*|svit[a-z']*|свит[а-яёўқғҳ]*|chiro[qg][a-z']*|чиро[қк][а-яёўқғҳ]*|elektr[a-z']*|электр[а-яёўқғҳ]*|tok|ток|voltaj|вольтаж|napryajen[a-z']*|напряжен[а-яёўқғҳ]*|transformator[a-z']*|трансформатор[а-яёўқғҳ]*|suv(?!oq|arak)[a-z']*|сув(?!оқ|арак)[а-яёўқғҳ]*|vodoprovod[a-z']*|водопровод[а-яёўқғҳ]*|vodokanal[a-z']*|водоканал[а-яёўқғҳ]*|vodovoz[a-z']*|водовоз[а-яёўқғҳ]*|voda|вод[аыеуой][а-яёўқғҳ]*|kranta[a-z']*|кранта[а-яёўқғҳ]*|quvur[a-z']*|қувур[а-яёўқғҳ]*|truba[a-z']*|труба[а-яёўқғҳ]*|kanalizats[a-z']*|канализаци[а-яёўқғҳ]*|lyuk[a-z']*|люк[а-яёўқғҳ]*|nasos[a-z']*|насос[а-яёўқғҳ]*|musor[a-z']*|мусор[а-яёўқғҳ]*|musr[a-z']*|муср[а-яёўқғҳ]*|musir[a-z']*|мусир[а-яёўқғҳ]*|chiqindi[a-z']*|чиқинди[а-яёўқғҳ]*|axlat[a-z']*|ахлат[а-яёўқғҳ]*|svalka[a-z']*|свалка[а-яёўқғҳ]*|toza\s+hudud|тоза\s+ҳудуд|maxsustrans[a-z']*|махсустранс[а-яёўқғҳ]*|asfalt[a-z']*|асфальт[а-яёўқғҳ]*|ko'cha[a-z']*|кўча[а-яёўқғҳ]*|yo'l[a-z']*|йўл[а-яёўқғҳ]*|дорог[а-яёўқғҳ]*|hokim[a-z']*|ҳоким[а-яёўқғҳ]*|хоким[а-яёўқғҳ]*|xokim[a-z']*|hokimiyat[a-z']*|ҳокимият[а-яёўқғҳ]*|hokimlik[a-z']*|ҳокимлик[а-яёўқғҳ]*|tepadagilar[a-z']*|тепадагилар[а-яёўқғҳ]*|yuqoridagilar[a-z']*|юқоридагилар[а-яёўқғҳ]*|mas'ul[a-z']*|масъул[а-яёўқғҳ]*)(?![\p{L}\p{N}'])/iu;

const CIVIC_PREDICATE_REGEX =
  /(?<![\p{L}\p{N}'])(?:remont[a-z']*|ta'mir[a-z']*|profilaktik[a-z']*|avariy[a-z']*|uchipti|ochipti|o'chipt[a-z']*|o'chibd[a-z']*|o'chyapt[a-z']*|o'chd[a-z']*|o'chgan[a-z']*|yo'q|yo'qligi|kelmadi|kemadi|kemapti|kelmaganiga|kemaganiga|kemibdi|past|bosim|siz[a-z']*|chiq(?:a?yapt[a-z']*|ib[a-z']*|d[a-z']+|ipt[a-z']*|madi|mayapt[a-z']*)|oqyapti|oqib|yorildi|teshildi|portladi|to'xtab|to'lib|toshdi|yonmadi|kuydi|uzildi|buzildi|qachon|nega|nimaga|qayerda|qaysi|yonadimi|beradimi|keladimi|berishadi|bo'ladimi|bormi|yotibdi|bopti|bo'pti|bo'lyapti|bo'ldi|nima\s+bo'|bizdayam|bizda\s+ham|ремонт[а-яёўқғҳ]*|таъмир[а-яёўқғҳ]*|профилактик[а-яёўқғҳ]*|авария[а-яёўқғҳ]*|[ўу]чипт[а-яёўқғҳ]*|[ўу]чибд[а-яёўқғҳ]*|[ўу]чяпт[а-яёўқғҳ]*|[ўу]чд[а-яёўқғҳ]*|[ўу]чган[а-яёўқғҳ]*|йўқ|келмади|кемади|кемибди|кемаганига|келмаган[а-я]*|паст|босим|сиз[а-яёўқғҳ]*|чиқ(?:а?япт[а-яёўқғҳ]*|иб[а-яёўқғҳ]*|д[а-яёўқғҳ]+|ипт[а-яёўқғҳ]*|мади|маяпт[а-яёўқғҳ]*)|оқяпти|оқиб|ёрилди|тешилди|портлади|тўхтаб|тўлиб|тошди|ёнмади|куйди|узилди|бузилди|йотибди|ётибди|[қк]ачон|нега|нимага|[қк]аерда|[қк]айси|ёнадими|берадими|келадими|беришади|[бўу]+ладими|борми|бўпти|бўляпти|бўлди|нима\s+бў|биздаям|бизда\s+ҳам|нет|отключили|прорвало|когда|будет|давление|не\s+горит|потух|течет|забилось)(?![\p{L}\p{N}'])/iu;

const COMPOUND_CIVIC_REGEX =
  /(?<![\p{L}\p{N}'])(?:suvsizlik|gazsizlik|svetsizlik|chiroqsizlik|elektrsizlik|сувсизлик|газсизлик|светсизлик|чироқсизлик|электрсизлик|чиқиндилар|мусорлар|мусирлар|musirlar)[a-zа-яёўқғҳ']*(?![\p{L}\p{N}'])/iu;

/**
 * Checks whether text contains an independent, self-contained municipal civic signal
 * (possessing both a municipal subject and a failure/inquiry predicate, or a compound term).
 */
export function hasSelfContainedCivicSignal(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const normalized = normalizeUzbekScript(text);
  if (normalized.length === 0) return false;
  if (COMPOUND_CIVIC_REGEX.test(normalized)) return true;
  return CIVIC_SUBJECT_REGEX.test(normalized) && CIVIC_PREDICATE_REGEX.test(normalized);
}



