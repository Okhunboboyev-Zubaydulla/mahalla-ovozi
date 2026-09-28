import crypto from 'node:crypto';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, and, isNull } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import { createDbClient } from '../../adapters/db/client.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  districtTelegramUserbotSessions,
  telegramIntakeRecords,
} from '../../adapters/db/schema/index.js';
import {
  withTransactionalIntake,
  TELEGRAM_BURST_DEBOUNCE_QUEUE,
  TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
  JobSingletonKeys,
  type TransactionScope,
} from '../../adapters/jobs/boss-client.js';
import { qualifyTelegramContent } from './telegram-content-qualification.js';
import { SLIDING_DEBOUNCE_WINDOW_SECONDS } from './jobs/burst-debounce-job-handler.js';
import { getTashkentCalendarDay } from './timezone-util.js';
import type { GroupTransport } from '@mahalla-ovozi/api-contracts';

import type { TelegramUpdate, TelegramMessage } from '../../adapters/telegram/telegram-types.js';
import type { CanonicalIngestEnvelope } from '../../adapters/telegram/mtproto-normalizer.js';
export type { TelegramUpdate, CanonicalIngestEnvelope };

export type AuthorizationFailureReason =
  | 'BOT_NOT_FOUND'
  | 'BOT_NOT_VALID'
  | 'DISTRICT_NOT_ACTIVE'
  | 'GROUP_NOT_APPROVED'
  | 'CROSS_DISTRICT_MISMATCH'
  | 'TRANSPORT_MISMATCH'
  | 'USERBOT_SESSION_NOT_ACTIVE';

export type AuthorizationResult =
  | {
      authorized: true;
      districtId: string;
      mahallaName: string;
      botId: string | null;
      groupId: string;
      transport: GroupTransport;
    }
  | {
      authorized: false;
      reason: AuthorizationFailureReason;
    };

export type ProcessWebhookResult =
  | {
      status: 'ACCEPTED';
      intakeId: string;
      jobId: string | null;
      districtId: string;
      mahallaName: string;
      chatId: string;
      messageId: string;
    }
  | {
      status: 'UPDATED';
      intakeId: string;
      jobId: string | null;
      districtId: string;
      mahallaName: string;
      chatId: string;
      messageId: string;
    }
  | {
      status: 'DROPPED';
      reason: string;
      chatId?: string;
      messageId?: string;
    }
  | {
      status: 'DUPLICATE';
      intakeId: null;
      jobId: null;
      districtId: string;
      mahallaName: string;
      chatId: string;
      messageId: string;
    };

/**
 * Authoritatively resolves the District identity and Mahalla mapping from server-side database
 * records based on the incoming botId and chatId. Client-supplied IDs are never trusted.
 */
export async function resolveDistrictBotAndGroup(
  db: DbClient,
  botId: string,
  chatId: string,
): Promise<AuthorizationResult> {
  // Consolidated 1-round-trip relational query (H-1 performance optimization)
  const [record] = await db
    .select({
      botId: districtTelegramBots.botId,
      botDistrictId: districtTelegramBots.districtId,
      botStatus: districtTelegramBots.status,
      districtId: districts.id,
      districtStatus: districts.status,
      districtAccessEligible: districts.accessEligible,
      groupId: districtTelegramGroups.id,
      groupDistrictId: districtTelegramGroups.districtId,
      groupStatus: districtTelegramGroups.status,
      groupTransport: districtTelegramGroups.transport,
      mahallaName: districtTelegramGroups.mahallaName,
    })
    .from(districtTelegramBots)
    .leftJoin(districts, eq(districts.id, districtTelegramBots.districtId))
    .leftJoin(
      districtTelegramGroups,
      eq(districtTelegramGroups.telegramChatId, chatId),
    )
    .where(eq(districtTelegramBots.botId, botId))
    .limit(1);

  // 1. Look up bot by public botId
  if (!record) {
    return { authorized: false, reason: 'BOT_NOT_FOUND' };
  }

  // 1.1 Verify bot is in VALID status
  if (record.botStatus !== 'VALID') {
    return { authorized: false, reason: 'BOT_NOT_VALID' };
  }

  // 2. Authoritatively verify associated District is in ACTIVE status
  if (
    !record.districtId ||
    (record.districtStatus !== 'ACTIVE' && record.districtStatus !== 'GRACE') ||
    record.districtAccessEligible === false
  ) {
    return { authorized: false, reason: 'DISTRICT_NOT_ACTIVE' };
  }

  // 3. Look up source group mapping by telegramChatId
  if (!record.groupId || !record.mahallaName) {
    return { authorized: false, reason: 'GROUP_NOT_APPROVED' };
  }

  // 4. Verify group belongs to the exact same District as the bot
  if (record.groupDistrictId !== record.botDistrictId) {
    return { authorized: false, reason: 'CROSS_DISTRICT_MISMATCH' };
  }

  // 5. Verify group is in VALID approved status
  if (record.groupStatus !== 'VALID') {
    return { authorized: false, reason: 'GROUP_NOT_APPROVED' };
  }

  // 6. Verify group transport matches BOT_API (mutual exclusivity: USERBOT group cannot be ingested via BOT_API)
  if (record.groupTransport && record.groupTransport !== 'BOT_API') {
    return { authorized: false, reason: 'TRANSPORT_MISMATCH' };
  }

  return {
    authorized: true,
    districtId: record.districtId,
    mahallaName: record.mahallaName,
    botId: record.botId,
    groupId: record.groupId,
    transport: 'BOT_API',
  };
}

/**
 * Authoritatively resolves the District identity and Mahalla mapping for a USERBOT message
 * based on the incoming districtId and chatId. Client-supplied IDs are never trusted.
 * Authorizes on: (District session ACTIVE) + (group mapped to District, VALID) + (District ACTIVE/GRACE) + (group transport USERBOT), with no botId.
 */
export async function resolveDistrictUserbotAndGroup(
  db: DbClient,
  districtId: string,
  chatId: string,
): Promise<AuthorizationResult> {
  const [record] = await db
    .select({
      districtId: districts.id,
      districtStatus: districts.status,
      districtAccessEligible: districts.accessEligible,
      sessionId: districtTelegramUserbotSessions.id,
      sessionStatus: districtTelegramUserbotSessions.status,
      groupId: districtTelegramGroups.id,
      groupDistrictId: districtTelegramGroups.districtId,
      groupStatus: districtTelegramGroups.status,
      groupTransport: districtTelegramGroups.transport,
      mahallaName: districtTelegramGroups.mahallaName,
    })
    .from(districts)
    .leftJoin(
      districtTelegramUserbotSessions,
      eq(districtTelegramUserbotSessions.districtId, districts.id),
    )
    .leftJoin(
      districtTelegramGroups,
      eq(districtTelegramGroups.telegramChatId, chatId),
    )
    .where(eq(districts.id, districtId))
    .limit(1);

  // 1. Authoritatively verify associated District exists and is in ACTIVE or GRACE status
  if (
    !record ||
    (record.districtStatus !== 'ACTIVE' && record.districtStatus !== 'GRACE') ||
    record.districtAccessEligible === false
  ) {
    return { authorized: false, reason: 'DISTRICT_NOT_ACTIVE' };
  }

  // 2. Verify District has an active userbot session
  if (!record.sessionId || record.sessionStatus !== 'ACTIVE') {
    return { authorized: false, reason: 'USERBOT_SESSION_NOT_ACTIVE' };
  }

  // 3. Look up source group mapping by telegramChatId
  if (!record.groupId || !record.mahallaName) {
    return { authorized: false, reason: 'GROUP_NOT_APPROVED' };
  }

  // 4. Verify group belongs to this district (rejects cross-district chat)
  if (record.groupDistrictId !== record.districtId) {
    return { authorized: false, reason: 'CROSS_DISTRICT_MISMATCH' };
  }

  // 5. Verify group is in VALID approved status
  if (record.groupStatus !== 'VALID') {
    return { authorized: false, reason: 'GROUP_NOT_APPROVED' };
  }

  // 6. Verify group transport is USERBOT
  if (record.groupTransport !== 'USERBOT') {
    return { authorized: false, reason: 'TRANSPORT_MISMATCH' };
  }

  return {
    authorized: true,
    districtId: record.districtId,
    mahallaName: record.mahallaName,
    botId: null,
    groupId: record.groupId,
    transport: 'USERBOT',
  };
}

/**
 * Handles incoming Telegram webhook update:
 * 1. Structural update type guards (drops non-message payloads with 200 OK)
 * 2. Multi-tenant authorization check
 * 3. Atomic PostgreSQL transaction:
 *    - Inserts raw intake record (.onConflictDoNothing().returning())
 *    - Resolves duplicates idempotently without throwing
 *    - Enqueues pg-boss qualification job with deduplication singletonKey
 */
export async function processTelegramWebhookUpdate(
  pool: pg.Pool,
  boss: PgBoss,
  botId: string,
  update: TelegramUpdate,
): Promise<ProcessWebhookResult> {
  const isEdit = Boolean(update.edited_message || update.edited_channel_post);
  const rawMsg = (update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post) as TelegramMessage | undefined;

  // Structural Guard: only process updates containing a valid message with chat.id and message_id
  if (
    !update ||
    typeof update !== 'object' ||
    !rawMsg ||
    typeof rawMsg !== 'object' ||
    rawMsg.chat?.id === undefined ||
    rawMsg.chat?.id === null ||
    rawMsg.message_id === undefined ||
    rawMsg.message_id === null
  ) {
    return {
      status: 'DROPPED',
      reason: 'UNSUPPORTED_UPDATE_TYPE',
    };
  }

  const chatId = String(rawMsg.chat.id);
  const messageId = String(rawMsg.message_id);
  const updateId =
    update.update_id != null ? String(update.update_id) : null;
  const userId =
    rawMsg.from?.id != null ? String(rawMsg.from.id) : null;

  const db = createDbClient(pool);
  const auth = await resolveDistrictBotAndGroup(db, botId, chatId);

  if (!auth.authorized) {
    return {
      status: 'DROPPED',
      reason: auth.reason,
      chatId,
      messageId,
    };
  }

  const rawDate = rawMsg.date;
  const unixSeconds =
    typeof rawDate === 'number' && Number.isFinite(rawDate) && rawDate > 0
      ? (rawDate > 1e11 ? Math.floor(rawDate / 1000) : Math.floor(rawDate))
      : Math.floor(Date.now() / 1000);
  const originalTimestamp = new Date(unixSeconds * 1000);
  const calendarDay = getTashkentCalendarDay(unixSeconds);

  return withTransactionalIntake(pool, boss, async (scope) => {
    return ingestTelegramMessage(scope, auth, {
      chatId,
      messageId,
      userId,
      updateId,
      originalTimestamp,
      calendarDay,
      rawPayload: update,
      isEdit,
    });
  });
}

/**
 * Handles incoming Userbot canonical ingest envelope:
 * 1. Resolves District userbot session and group mapping authoritatively
 * 2. Multi-tenant authorization check: (session ACTIVE) + (group mapped, VALID) + (District ACTIVE/GRACE) + (group transport USERBOT)
 * 3. Atomic PostgreSQL transaction via withTransactionalIntake:
 *    - Delegates to ingestTelegramMessage for shared transactional ingest core
 */
export async function processUserbotIngestEnvelope(
  pool: pg.Pool,
  boss: PgBoss,
  districtId: string,
  envelope: CanonicalIngestEnvelope,
): Promise<ProcessWebhookResult> {
  const db = createDbClient(pool);
  const auth = await resolveDistrictUserbotAndGroup(db, districtId, envelope.chatId);

  if (!auth.authorized) {
    return {
      status: 'DROPPED',
      reason: auth.reason,
      chatId: envelope.chatId,
      messageId: envelope.messageId,
    };
  }

  const userId =
    envelope.normalizedMessage.from?.id != null
      ? String(envelope.normalizedMessage.from.id)
      : null;
  const updateId = null;

  const isEdit = isUserbotEnvelopeEdit(envelope);

  // Bot-API compatible payload with normalized message embedded for all downstream consumers
  const rawPayload =
    typeof envelope.rawPayload === 'object' && envelope.rawPayload !== null
      ? {
          ...(envelope.rawPayload as Record<string, unknown>),
          message: envelope.normalizedMessage,
          ...(isEdit ? { edited_message: envelope.normalizedMessage } : {}),
        }
      : {
          message: envelope.normalizedMessage,
          ...(isEdit ? { edited_message: envelope.normalizedMessage } : {}),
        };

  return withTransactionalIntake(pool, boss, async (scope) => {
    return ingestTelegramMessage(scope, auth, {
      chatId: envelope.chatId,
      messageId: envelope.messageId,
      userId,
      updateId,
      originalTimestamp: envelope.originalTimestamp,
      calendarDay: envelope.calendarDay,
      rawPayload,
      isEdit,
    });
  });
}

export interface IngestTelegramMessageAuth {
  districtId: string;
  mahallaName: string;
  groupId: string;
  transport: GroupTransport;
  botId: string | null;
}

export interface IngestTelegramMessagePayload {
  chatId: string;
  messageId: string;
  userId: string | null;
  updateId: string | null;
  originalTimestamp: Date;
  calendarDay: string;
  rawPayload: unknown;
  isEdit: boolean;
}

export type IngestTelegramMessageResult = ProcessWebhookResult;
export type IngestTelegramMessageContext = TransactionScope;

/**
 * Shared transactional ingest core for all Telegram transports (BOT_API and USERBOT).
 * Handles:
 * 1. In-buffer edited message updates and post-AI edit drop detection (Decision 1, 2, 3, 5).
 * 2. Idempotent raw intake record insert with onConflictDoNothing.
 * 3. Duplicate detection collapsing to DUPLICATE without throwing.
 * 4. Passive group testMessageReceivedAt timestamp recording.
 * 5. Content qualification pre-check and atomic pg-boss job dispatch (burst-debounce or exclusion logging).
 */
export async function ingestTelegramMessage(
  scope: TransactionScope,
  auth: IngestTelegramMessageAuth,
  payload: IngestTelegramMessagePayload,
): Promise<IngestTelegramMessageResult> {
  const { tx, enqueueJob } = scope;

  // Edited message detection:
  // If isEdit: check existing record for (district_id, telegram_chat_id, telegram_message_id)
  if (payload.isEdit) {
    const [existing] = await tx
      .select({
        id: telegramIntakeRecords.id,
        processedAt: telegramIntakeRecords.processedAt,
        calendarDay: telegramIntakeRecords.calendarDay,
        originalTimestamp: telegramIntakeRecords.originalTimestamp,
      })
      .from(telegramIntakeRecords)
      .where(
        and(
          eq(telegramIntakeRecords.districtId, auth.districtId),
          eq(telegramIntakeRecords.telegramChatId, payload.chatId),
          eq(telegramIntakeRecords.telegramMessageId, payload.messageId),
        ),
      )
      .limit(1);

    if (existing) {
      if (existing.processedAt) {
        // Already processed through debounce into AI pipeline -> ignore post-AI edit (Decision 1 & 2)
        return {
          status: 'DROPPED',
          reason: 'ALREADY_PROCESSED',
          chatId: payload.chatId,
          messageId: payload.messageId,
        };
      }

      // In-buffer edit (Decision 2 & 3): update raw_payload in place with latest edit
      await tx
        .update(telegramIntakeRecords)
        .set({
          rawPayload: payload.rawPayload,
          updatedAt: new Date(),
        })
        .where(eq(telegramIntakeRecords.id, existing.id));

      // Reschedule / extend the debounce timer (Decision 2 Option A)
      let jobId: string | null = null;
      if (payload.userId) {
        const singletonKey = JobSingletonKeys.forBurstDebounce(
          auth.districtId,
          payload.chatId,
          payload.userId,
        );
        jobId = await enqueueJob(
          TELEGRAM_BURST_DEBOUNCE_QUEUE,
          {
            districtId: auth.districtId,
            mahallaName: auth.mahallaName,
            calendarDay: existing.calendarDay,
            telegramChatId: payload.chatId,
            telegramUserId: payload.userId,
            source: auth.transport,
            telegramBotId: auth.botId,
            firstMessageTimestamp: existing.originalTimestamp.toISOString(),
          },
          {
            singletonKey,
            startAfter: SLIDING_DEBOUNCE_WINDOW_SECONDS,
            retryLimit: 3,
            retryDelay: 5,
            retryBackoff: true,
          },
        );
      }

      return {
        status: 'UPDATED',
        intakeId: existing.id,
        jobId,
        districtId: auth.districtId,
        mahallaName: auth.mahallaName,
        chatId: payload.chatId,
        messageId: payload.messageId,
      };
    }
    // If not existing: fall through to insert as a new message (Decision 5 Option A)
  }

  const intakeId = crypto.randomUUID();

  const insertedRows = await tx
    .insert(telegramIntakeRecords)
    .values({
      id: intakeId,
      districtId: auth.districtId,
      mahallaName: auth.mahallaName,
      source: auth.transport,
      telegramBotId: auth.botId,
      telegramChatId: payload.chatId,
      telegramMessageId: payload.messageId,
      updateId: payload.updateId,
      telegramUserId: payload.userId,
      originalTimestamp: payload.originalTimestamp,
      calendarDay: payload.calendarDay,
      rawPayload: payload.rawPayload,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        telegramIntakeRecords.districtId,
        telegramIntakeRecords.telegramChatId,
        telegramIntakeRecords.telegramMessageId,
      ],
    })
    .returning();

  const record = insertedRows?.[0];

  // Duplicate detection: If onConflictDoNothing returned 0 rows, intake was already recorded
  if (!record) {
    return {
      status: 'DUPLICATE',
      intakeId: null,
      jobId: null,
      districtId: auth.districtId,
      mahallaName: auth.mahallaName,
      chatId: payload.chatId,
      messageId: payload.messageId,
    };
  }

  // Passively record first evidence timestamp on group if not yet set (Spec Line 24 & 61)
  await tx
    .update(districtTelegramGroups)
    .set({
      testMessageReceivedAt: payload.originalTimestamp,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(districtTelegramGroups.id, auth.groupId),
        isNull(districtTelegramGroups.testMessageReceivedAt),
      ),
    );

  // Structural pre-check for debouncing vs direct exclusion
  const qualResult = qualifyTelegramContent({
    id: record.id,
    districtId: auth.districtId,
    mahallaName: auth.mahallaName,
    calendarDay: record.calendarDay,
    source: auth.transport,
    telegramBotId: auth.botId,
    telegramChatId: payload.chatId,
    telegramMessageId: payload.messageId,
    updateId: payload.updateId,
    telegramUserId: payload.userId,
    originalTimestamp: record.originalTimestamp,
    rawPayload: payload.rawPayload,
  });

  let jobId: string | null = null;
  if (qualResult.status === 'SUPPORTED') {
    // Schedule burst debouncing (25 seconds sliding window)
    const singletonKey = JobSingletonKeys.forBurstDebounce(
      auth.districtId,
      payload.chatId,
      payload.userId,
    );
    jobId = await enqueueJob(
      TELEGRAM_BURST_DEBOUNCE_QUEUE,
      {
        districtId: auth.districtId,
        mahallaName: auth.mahallaName,
        calendarDay: record.calendarDay,
        telegramChatId: record.telegramChatId,
        telegramUserId: record.telegramUserId,
        source: auth.transport,
        telegramBotId: auth.botId,
        firstMessageTimestamp: record.originalTimestamp.toISOString(),
      },
      {
        singletonKey,
        startAfter: SLIDING_DEBOUNCE_WINDOW_SECONDS,
        retryLimit: 3,
        retryDelay: 5,
        retryBackoff: true,
      },
    );
  } else {
    // Enqueue standard qualification job to log structural exclusion cleanly
    const singletonKey = JobSingletonKeys.forContentQualification(
      auth.districtId,
      payload.chatId,
      payload.messageId,
    );
    jobId = await enqueueJob(
      TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
      {
        intakeId: record.id,
        districtId: auth.districtId,
        mahallaName: auth.mahallaName,
        calendarDay: record.calendarDay,
        telegramChatId: record.telegramChatId,
        telegramMessageId: record.telegramMessageId,
        originalTimestamp: record.originalTimestamp.toISOString(),
      },
      {
        singletonKey,
        retryLimit: 3,
        retryDelay: 5,
        retryBackoff: true,
      },
    );
  }

  return {
    status: 'ACCEPTED',
    intakeId: record.id,
    jobId,
    districtId: auth.districtId,
    mahallaName: auth.mahallaName,
    chatId: payload.chatId,
    messageId: payload.messageId,
  };
}

/**
 * Pure helper detecting whether a CanonicalIngestEnvelope represents an edited message.
 */
function isUserbotEnvelopeEdit(envelope: CanonicalIngestEnvelope): boolean {
  if ((envelope as { isEdit?: boolean }).isEdit === true) {
    return true;
  }
  const normMsg = envelope.normalizedMessage as Record<string, unknown> | undefined;
  if (normMsg && (normMsg.edit_date != null || normMsg.editDate != null)) {
    return true;
  }
  if (envelope.rawPayload && typeof envelope.rawPayload === 'object') {
    const raw = envelope.rawPayload as Record<string, unknown>;
    if (
      raw._ === 'UpdateEditChannelMessage' ||
      raw._ === 'UpdateEditMessage' ||
      raw.className === 'UpdateEditChannelMessage' ||
      raw.className === 'UpdateEditMessage' ||
      raw.edited_message != null ||
      raw.edited_channel_post != null
    ) {
      return true;
    }
    const innerMsg = raw.message as Record<string, unknown> | undefined;
    if (innerMsg && (innerMsg.edit_date != null || innerMsg.editDate != null)) {
      return true;
    }
  }
  return false;
}
