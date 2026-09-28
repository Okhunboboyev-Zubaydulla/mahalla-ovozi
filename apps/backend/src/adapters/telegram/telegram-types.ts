/**
 * Telegram Bot API webhook payload type definitions.
 *
 * These types describe the wire format of updates delivered by Telegram servers
 * to our webhook endpoints.  They belong at the adapter boundary (not inside
 * domain modules) because they are shaped entirely by an external protocol.
 *
 * Domain modules import from here — never from each other for these types.
 */

// ── Basic Entities ───────────────────────────────────────────────────────────

export interface TelegramUser {
  id: number | string;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number | string;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export type TelegramMessageOrigin =
  | { type: 'user'; date: number; sender_user: TelegramUser }
  | { type: 'hidden_user'; date: number; sender_user_name: string }
  | { type: 'chat'; date: number; sender_chat: TelegramChat; author_signature?: string }
  | { type: 'channel'; date: number; chat: TelegramChat; message_id: number; author_signature?: string };

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
  language?: string;
  custom_emoji_id?: string;
}

// ── Message ──────────────────────────────────────────────────────────────────

export interface TelegramMessage {
  message_id: number | string;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  text?: string;
  entities?: TelegramMessageEntity[];
  caption?: string;
  caption_entities?: TelegramMessageEntity[];
  photo?: unknown[];
  video?: unknown;
  document?: unknown;
  animation?: unknown;
  audio?: unknown;
  voice?: unknown;
  paid_media?: unknown;
  video_note?: unknown;
  sticker?: unknown;
  poll?: unknown;
  dice?: unknown;
  game?: unknown;
  story?: unknown;
  giveaway?: unknown;
  giveaway_created?: unknown;
  giveaway_winners?: unknown;
  giveaway_completed?: unknown;
  contact?: unknown;
  location?: unknown;
  venue?: unknown;
  forward_origin?: TelegramMessageOrigin;
  is_automatic_forward?: boolean;
  forward_date?: number;
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  forward_from_message_id?: number | string;
  forward_sender_name?: string;
  forward_signature?: string;
  via_bot?: TelegramUser;
  reply_to_message?: TelegramMessage;
  new_chat_members?: unknown[];
  left_chat_member?: unknown;
  new_chat_title?: string;
  new_chat_photo?: unknown[];
  delete_chat_photo?: boolean;
  group_chat_created?: boolean;
  supergroup_chat_created?: boolean;
  channel_chat_created?: boolean;
  message_auto_delete_timer_changed?: unknown;
  migrate_to_chat_id?: number | string;
  migrate_from_chat_id?: number | string;
  pinned_message?: unknown;
  invoice?: unknown;
  successful_payment?: unknown;
  user_shared?: unknown;
  chat_shared?: unknown;
  write_access_allowed?: unknown;
  passport_data?: unknown;
  proximity_alert_triggered?: unknown;
  boost_added?: unknown;
  forum_topic_created?: unknown;
  forum_topic_edited?: unknown;
  forum_topic_closed?: unknown;
  forum_topic_reopened?: unknown;
  general_forum_topic_hidden?: unknown;
  general_forum_topic_unhidden?: unknown;
  video_chat_scheduled?: unknown;
  video_chat_started?: unknown;
  video_chat_ended?: unknown;
  video_chat_participants_invited?: unknown;
  web_app_data?: unknown;
  [key: string]: unknown;
}

/** Alias: intake domain uses this name for incoming message payloads. */
export type TelegramIncomingMessage = TelegramMessage;

// ── Update ───────────────────────────────────────────────────────────────────

/**
 * Partial Telegram Update structure covering the fields relevant to webhook
 * message ingestion.  The full Telegram Update spec has many more fields —
 * they are captured by the index signature.
 */
export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    date?: number; // unix timestamp in seconds
    chat?: {
      id?: number | string;
      title?: string;
      type?: string;
    };
    from?: {
      id?: number | string;
      is_bot?: boolean;
      first_name?: string;
      username?: string;
    };
    text?: string;
    caption?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
