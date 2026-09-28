import { eq, and } from 'drizzle-orm';
import { DbClient } from '../../adapters/db/client.js';
import {
  districtTelegramBots,
  districtTelegramGroups,
} from '../../adapters/db/schema/index.js';
import {
  StartGroupTestResponse,
  GetGroupTestStatusResponse,
  SimulateTestMessageResponse,
} from '@mahalla-ovozi/api-contracts';
import {
  filterTelegramMessage,
  TelegramIncomingMessage,
} from '../telegram-intake/telegram-content-qualification.js';
import { recordAuditEvent } from '../audit/audit-service.js';
import {
  globalTestSessionManager,
  TelegramTestSessionManager,
  TestSession,
} from './telegram-test-session-store.js';
import {
  TelegramGroupNotFoundError,
  BotNotConnectedError,
  Actor,
  ClientInfo,
} from './telegram-groups-service.js';

export interface GroupEngineOptions {
  sessionManager?: TelegramTestSessionManager;
}

export type GroupTestingOptions = GroupEngineOptions;

export async function startGroupTestSession(
  db: DbClient,
  districtId: string,
  groupId: string,
  _actor?: Actor,
  options: GroupEngineOptions = {},
): Promise<StartGroupTestResponse> {
  const manager = options.sessionManager ?? globalTestSessionManager;

  const [group] = await db
    .select()
    .from(districtTelegramGroups)
    .where(
      and(
        eq(districtTelegramGroups.districtId, districtId),
        eq(districtTelegramGroups.id, groupId),
      ),
    )
    .limit(1);

  if (!group) {
    throw new TelegramGroupNotFoundError(groupId);
  }

  const [botRow] = await db
    .select()
    .from(districtTelegramBots)
    .where(eq(districtTelegramBots.districtId, districtId))
    .limit(1);

  if (!botRow || botRow.status !== 'VALID') {
    throw new BotNotConnectedError(districtId);
  }

  const session = manager.createSession({
    districtId,
    groupId,
    chatId: group.telegramChatId,
    botId: botRow.botId,
  });

  await db
    .update(districtTelegramGroups)
    .set({
      status: 'TESTING',
      updatedAt: new Date(),
    })
    .where(eq(districtTelegramGroups.id, groupId));

  return {
    session: {
      status: session.status,
      expiresAt: session.expiresAt.toISOString(),
    },
  };
}

export async function getGroupTestStatus(
  db: DbClient,
  districtId: string,
  groupId: string,
  actor?: Actor,
  clientInfo?: ClientInfo,
  options: GroupEngineOptions = {},
): Promise<GetGroupTestStatusResponse> {
  const manager = options.sessionManager ?? globalTestSessionManager;

  const [group] = await db
    .select()
    .from(districtTelegramGroups)
    .where(
      and(
        eq(districtTelegramGroups.districtId, districtId),
        eq(districtTelegramGroups.id, groupId),
      ),
    )
    .limit(1);

  if (!group) {
    throw new TelegramGroupNotFoundError(groupId);
  }

  const session = manager.getSession(districtId, groupId);

  if (session?.status === 'SUCCESS' && group.status !== 'VALID') {
    const receivedAt = session.testMessageReceivedAt || new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(districtTelegramGroups)
        .set({
          status: 'VALID',
          testMessageReceivedAt: receivedAt,
          lastValidatedAt: receivedAt,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(districtTelegramGroups.id, groupId));

      await recordAuditEvent(tx, {
        districtId,
        actorId: actor?.id || null,
        actorRole: actor?.role || null,
        action: 'DISTRICT_GROUP_VALIDATED',
        metadata: {
          districtId,
          groupId,
          mahallaName: group.mahallaName,
          telegramChatId: group.telegramChatId,
          validatedAt: receivedAt.toISOString(),
        },
        ipAddress: clientInfo?.ipAddress || null,
        userAgent: clientInfo?.userAgent || null,
      });
    });

    return {
      status: 'SUCCESS',
      testMessageReceivedAt: receivedAt.toISOString(),
      lastError: null,
    };
  }

  if (session?.status === 'TIMEOUT' && group.status === 'TESTING') {
    await db
      .update(districtTelegramGroups)
      .set({
        status: 'FAILED',
        lastError: session.lastError || 'Синов вақти тугади.',
        updatedAt: new Date(),
      })
      .where(eq(districtTelegramGroups.id, groupId));

    return {
      status: 'TIMEOUT',
      testMessageReceivedAt: null,
      lastError: session.lastError || 'Синов вақти тугади.',
    };
  }

  if (group.status === 'VALID') {
    return {
      status: 'SUCCESS',
      testMessageReceivedAt: group.testMessageReceivedAt ? group.testMessageReceivedAt.toISOString() : null,
      lastError: null,
    };
  }

  return {
    status: (session?.status as 'PENDING' | 'SUCCESS' | 'TIMEOUT' | 'FAILED') || (group.status as any),
    testMessageReceivedAt: group.testMessageReceivedAt ? group.testMessageReceivedAt.toISOString() : null,
    lastError: group.lastError || null,
  };
}

export async function handleIncomingWebhookMessage(
  db: DbClient,
  _botId: string,
  rawUpdate: unknown,
  options: GroupEngineOptions = {},
): Promise<{ handled: boolean; accepted: boolean; reason?: string }> {
  const manager = options.sessionManager ?? globalTestSessionManager;
  const update = rawUpdate as { message?: TelegramIncomingMessage; channel_post?: TelegramIncomingMessage };
  const incoming = update?.message || update?.channel_post;

  if (!incoming) {
    return { handled: false, accepted: false, reason: 'NO_MESSAGE' };
  }

  const filterResult = filterTelegramMessage(incoming);
  if (!filterResult.accepted) {
    return { handled: true, accepted: false, reason: filterResult.reason };
  }

  const chatId = String(incoming.chat?.id || '');
  const activeSession = manager.findActiveSessionByChatId(chatId);

  if (!activeSession) {
    return { handled: true, accepted: false, reason: 'NO_ACTIVE_SESSION' };
  }

  if (activeSession.botId !== _botId) {
    return { handled: true, accepted: false, reason: 'BOT_MISMATCH' };
  }

  const now = new Date();
  manager.resolveSessionSuccess(activeSession.districtId, activeSession.groupId, now);

  await db.transaction(async (tx) => {
    await tx
      .update(districtTelegramGroups)
      .set({
        status: 'VALID',
        testMessageReceivedAt: now,
        lastValidatedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(districtTelegramGroups.id, activeSession.groupId));

    await recordAuditEvent(tx, {
      districtId: activeSession.districtId,
      actorId: 'system:telegram-webhook',
      actorRole: 'system',
      action: 'DISTRICT_GROUP_VALIDATED',
      metadata: {
        districtId: activeSession.districtId,
        groupId: activeSession.groupId,
        telegramChatId: chatId,
        validatedAt: now.toISOString(),
      },
      ipAddress: null,
      userAgent: null,
    });
  });

  return { handled: true, accepted: true };
}

export async function simulateGroupTestMessage(
  db: DbClient,
  districtId: string,
  groupId: string,
  messagePayload: unknown,
  actor?: Actor,
  clientInfo?: ClientInfo,
  options: GroupEngineOptions = {},
): Promise<SimulateTestMessageResponse> {
  const manager = options.sessionManager ?? globalTestSessionManager;

  const [group] = await db
    .select()
    .from(districtTelegramGroups)
    .where(
      and(
        eq(districtTelegramGroups.districtId, districtId),
        eq(districtTelegramGroups.id, groupId),
      ),
    )
    .limit(1);

  if (!group) {
    throw new TelegramGroupNotFoundError(groupId);
  }

  const incoming = messagePayload as TelegramIncomingMessage;
  const filterResult = filterTelegramMessage(incoming);

  if (!filterResult.accepted) {
    return {
      success: true,
      accepted: false,
      reason: filterResult.reason,
    };
  }

  const now = new Date();
  manager.resolveSessionSuccess(districtId, groupId, now);

  await db.transaction(async (tx) => {
    await tx
      .update(districtTelegramGroups)
      .set({
        status: 'VALID',
        testMessageReceivedAt: now,
        lastValidatedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(districtTelegramGroups.id, groupId));

    await recordAuditEvent(tx, {
      districtId,
      actorId: actor?.id || 'system:simulator',
      actorRole: actor?.role || 'system',
      action: 'DISTRICT_GROUP_VALIDATED',
      metadata: {
        districtId,
        groupId,
        mahallaName: group.mahallaName,
        telegramChatId: group.telegramChatId,
        simulated: true,
        validatedAt: now.toISOString(),
      },
      ipAddress: clientInfo?.ipAddress || null,
      userAgent: clientInfo?.userAgent || null,
    });
  });

  return {
    success: true,
    accepted: true,
  };
}

export { globalTestSessionManager, TelegramTestSessionManager };
export type { TestSession };
