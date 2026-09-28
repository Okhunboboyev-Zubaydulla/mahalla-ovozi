/**
 * Pure domain content qualification engine for Telegram messages (Story 2.2).
 * Adheres strictly to AD-1 (Hexagonal Architecture / Pure Domain Logic),
 * AD-9 (Tenant Scope Attribution), and AD-11 (Privacy-Safe Telemetry).
 *
 * Evaluates structural validity of Telegram messages before AI semantic analysis.
 * Preserves verbatim text/captions without mutation and discards structural exclusions.
 */

import type { TelegramReplyMetadata } from '../../adapters/jobs/boss-client.js';
export type { TelegramReplyMetadata };

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

  // 1. Forward guard (AC 4)
  if (isTelegramForwarded(rawMsg)) {
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

const CIVIC_SUBJECT_REGEX =
  /(?:^|[^\p{L}\p{N}_])(svet|chiroq|elektr|tok|voltaj|napryajeni|suv|vodoprovod|kranta|gaz|musor|musr|musir|chiqindi|axlat|truba|quvur|kanalizatsiy[a-z]*|lyuk|yo['`ʻʼ]?l|ko['`ʻʼ]?cha|asfalt|transformator|hokim|xokim|hokimiyat|hokimlik|свет|чироқ|электр|ток|вольтаж|напряжени|сув|водопровод|кранта|вода|воды|газ|мусор|мусир|чиқинди|ахлат|труба|қувур|канализаци[а-я]*|люк|йўл|кўча|асфальт|трансформатор|дорог[а-я]|ҳоким|ҳокимият|ҳокимлик)(?:$|[^\p{L}\p{N}_])/iu;

const CIVIC_PREDICATE_REGEX =
  /(?:^|[^\p{L}\p{N}_])(o['`ʻʼ]?chdi|o['`ʻʼ]?chgan|yo['`ʻʼ]?q|yo['`ʻʼ]?qligi|kelmadi|kemadi|kemapti|kelmaganiga|kemaganiga|kemibdi|past|bosim|yorildi|teshildi|oqyapti|oqib|to['`ʻʼ]?lib|toshdi|yonmadi|kuydi|uzildi|buzildi|qachon|bo['`ʻʼ]?ladimi|bormi|yotibdi|[ўу]чди|[ўу]чган|йўқ|келмади|кемади|кемибди|кемаганига|келмаган[а-я]*|паст|босим|ёрилди|тешилди|оқяпти|оқиб|тўлиб|тошди|ёнмади|куйди|узилди|бузилди|йотибди|ётибди|[қк]ачон|[бўу]+ладими|борми|нет|отключили|прорвало|когда|будет|давление|не\s+горит|потух|течет|забилось)(?:$|[^\p{L}\p{N}_])/iu;

const COMPOUND_CIVIC_REGEX =
  /(?:^|[^\p{L}\p{N}_])(suvsizlik|gazsizlik|svetsizlik|chiroqsizlik|elektrsizlik|сувсизлик|газсизлик|светсизлик|чироқсизлик|электрсизлик|чиқиндилар|мусорлар|мусирлар|musirlar)/iu;

/**
 * Checks whether text contains an independent, self-contained municipal civic signal
 * (possessing both a municipal subject and a failure/inquiry predicate, or a compound term).
 */
export function hasSelfContainedCivicSignal(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (COMPOUND_CIVIC_REGEX.test(trimmed)) return true;
  return CIVIC_SUBJECT_REGEX.test(trimmed) && CIVIC_PREDICATE_REGEX.test(trimmed);
}


