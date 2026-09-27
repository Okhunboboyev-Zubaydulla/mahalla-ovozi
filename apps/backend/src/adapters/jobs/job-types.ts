/**
 * Canonical job type registry for the pg-boss queue system.
 *
 * Ownership rule: job payload interfaces belong here, NOT in boss-client.ts.
 * boss-client.ts is adapter infrastructure; job-types.ts is the contract layer
 * that both the adapter and domain job handlers share.
 *
 * Queue name constants are co-located so payload interfaces can reference them
 * in BossQueueMap without a circular import.
 */
import type { QualifyingLane, TelegramReplyMetadata } from '@mahalla-ovozi/api-contracts';
import type { TelegramIntakeSource } from '../db/schema/telegram-intakes.js';

export type { TelegramReplyMetadata, TelegramIntakeSource };

// ---------------------------------------------------------------------------
// Queue name constants
// ---------------------------------------------------------------------------

export const TELEGRAM_BURST_DEBOUNCE_QUEUE = 'telegram-burst-debounce';
export const TELEGRAM_CONTENT_QUALIFICATION_QUEUE = 'telegram-content-qualification';
export const TELEGRAM_SEMANTIC_RELEVANCE_QUEUE = 'telegram-semantic-relevance';
export const TELEGRAM_TOPIC_ASSIGNMENT_QUEUE = 'telegram-topic-assignment';
export const TELEGRAM_TOPIC_PROJECTION_QUEUE = 'telegram-topic-projection';
export const TELEGRAM_TOPIC_PROJECTION_RECONCILE_CRON_QUEUE = 'telegram-topic-projection-reconcile-cron';
export const TELEGRAM_TOPIC_RETENTION_QUEUE = 'telegram-topic-retention';
export const DISTRICT_SUBSCRIPTION_EXPIRY_QUEUE = 'district-subscription-expiry';
export const DISTRICT_SUBSCRIPTION_EXPIRY_CRON_QUEUE = 'district-subscription-expiry-cron';
export const DISTRICT_LIVE_DELETION_QUEUE = 'district-live-deletion';
export const DISTRICT_LIVE_DELETION_CRON_QUEUE = 'district-live-deletion-cron';
export const DISTRICT_BACKUP_EXPIRY_QUEUE = 'district-backup-expiry';
export const DISTRICT_BACKUP_EXPIRY_CRON_QUEUE = 'district-backup-expiry-cron';

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

/** A single message item inside a burst batch — used by debounce and relevance jobs. */
export interface SenderProfileMetadata {
  telegramUserId?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Safely extracts user identity attributes from various Telegram update wire shapes.
 * Privacy-safe: strictly extracts id, username, first_name, last_name only.
 */
export function extractTelegramUserMetadata(
  rawPayload: unknown,
  fallbackUserId?: string | null,
): SenderProfileMetadata | null {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return fallbackUserId ? { telegramUserId: fallbackUserId } : null;
  }
  const payload = rawPayload as Record<string, any>;
  const rawMsg =
    payload.message ??
    payload.edited_message ??
    payload.channel_post ??
    payload.edited_channel_post ??
    payload.business_message ??
    payload.edited_business_message ??
    payload;

  const fromUser = rawMsg?.from ?? payload.from;

  if (fromUser && typeof fromUser === 'object') {
    return {
      telegramUserId: fromUser.id != null ? String(fromUser.id) : (fallbackUserId || undefined),
      username:
        typeof fromUser.username === 'string' && fromUser.username.trim().length > 0
          ? fromUser.username.trim()
          : undefined,
      firstName:
        typeof fromUser.first_name === 'string' && fromUser.first_name.trim().length > 0
          ? fromUser.first_name.trim()
          : undefined,
      lastName:
        typeof fromUser.last_name === 'string' && fromUser.last_name.trim().length > 0
          ? fromUser.last_name.trim()
          : undefined,
    };
  }

  return fallbackUserId ? { telegramUserId: fallbackUserId } : null;
}

/** A single message item inside a burst batch — used by debounce and relevance jobs. */
export interface BurstMessageItem {
  intakeId: string;
  telegramMessageId: string;
  originalTimestamp: string;
  verbatimText: string;
  contentType: 'TEXT' | 'MEDIA_CAPTION';
  replyMetadata?: TelegramReplyMetadata | null;
  userMetadata?: SenderProfileMetadata | null;
}

// ---------------------------------------------------------------------------
// Job payload interfaces — one per queue
// ---------------------------------------------------------------------------

/** Telegram burst-debounce aggregation job. */
export interface TelegramBurstDebounceJobData {
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  telegramChatId: string;
  telegramUserId?: string | null;
  source: TelegramIntakeSource;
  telegramBotId?: string | null;
  firstMessageTimestamp: string;
  issueId?: string;
}

/** Telegram message content-qualification AI pipeline job. */
export interface TelegramContentQualificationJobData {
  intakeId: string;
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  telegramChatId: string;
  telegramMessageId: string;
  originalTimestamp: string;
  issueId?: string;
}

/** Telegram semantic-relevance AI evaluation job. */
export interface TelegramSemanticRelevanceJobData {
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
  userMetadata?: SenderProfileMetadata | null;
  burstMessages?: BurstMessageItem[];
  issueId?: string;
}

/** Telegram topic-assignment AI evaluation job. */
export interface TelegramTopicAssignmentJobData {
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
  userMetadata?: SenderProfileMetadata | null;
  aiOperationId: string;
  relevantLanes: QualifyingLane[];
  reasoning: string;
  burstMessages?: BurstMessageItem[];
  issueId?: string;
}

/** Topic projection recalculation job (AD-7 coalescing). */
export interface TelegramTopicProjectionJobData {
  topicId: string;
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  generation: number;
  issueId?: string;
}

/** Topic retention scan job (global or district-scoped). */
export interface TelegramTopicRetentionJobData {
  districtId?: string;
  issueId?: string;
}

/** District subscription grace-expiry lifecycle job. */
export interface DistrictSubscriptionExpiryJobData {
  districtId: string;
}

/** District permanent live-deletion job. */
export interface DistrictLiveDeletionJobData {
  districtId: string;
  issueId?: string;
}

/** District protected-backup expiry verification job. */
export interface DistrictBackupExpiryJobData {
  districtId: string;
  issueId?: string;
}

// ---------------------------------------------------------------------------
// Type-safe queue → payload registry
// ---------------------------------------------------------------------------

/** Maps each queue name to its canonical payload type. Used by sendQueueJob and worker handlers. */
export interface BossQueueMap {
  [TELEGRAM_BURST_DEBOUNCE_QUEUE]: TelegramBurstDebounceJobData;
  [TELEGRAM_CONTENT_QUALIFICATION_QUEUE]: TelegramContentQualificationJobData;
  [TELEGRAM_SEMANTIC_RELEVANCE_QUEUE]: TelegramSemanticRelevanceJobData;
  [TELEGRAM_TOPIC_ASSIGNMENT_QUEUE]: TelegramTopicAssignmentJobData;
  [TELEGRAM_TOPIC_PROJECTION_QUEUE]: TelegramTopicProjectionJobData;
  [TELEGRAM_TOPIC_RETENTION_QUEUE]: TelegramTopicRetentionJobData;
  [DISTRICT_SUBSCRIPTION_EXPIRY_QUEUE]: DistrictSubscriptionExpiryJobData;
  [DISTRICT_LIVE_DELETION_QUEUE]: DistrictLiveDeletionJobData;
  [DISTRICT_BACKUP_EXPIRY_QUEUE]: DistrictBackupExpiryJobData;
}

export type BossQueueName = keyof BossQueueMap;
