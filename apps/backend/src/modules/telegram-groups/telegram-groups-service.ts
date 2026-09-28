import crypto from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { DbClient, mapPostgresConstraintError } from '../../adapters/db/client.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  districtTelegramUserbotSessions,
  DistrictTelegramGroup,
  GroupTransport,
} from '../../adapters/db/schema/index.js';
import {
  TelegramGroupMapping,
  TelegramGroupStatusSchema,
  CreateTelegramGroupRequest,
  UpdateTelegramGroupRequest,
} from '@mahalla-ovozi/api-contracts';
import { decryptToken } from '../../adapters/crypto/token-cipher.js';
import {
  getTelegramChat,
  verifyBotGroupMembership,
  checkGroupPrivacyMode,
} from '../../adapters/telegram/telegram-client.js';
import { TelegramIntegrationError } from '../telegram-bot/ports/telegram-client-port.js';
import { recordAuditEvent } from '../audit/audit-service.js';
import { DistrictNotFoundError } from '../districts/district-onboarding-engine.js';
import { globalTestSessionManager, TelegramTestSessionManager } from './telegram-test-session-store.js';

export class TelegramGroupNotFoundError extends Error {
  readonly code = 'TELEGRAM_GROUP_NOT_FOUND' as const;
  constructor(groupId: string) {
    super(`Маҳалла Telegram гуруҳи топилмади (ID: ${groupId}).`);
    this.name = 'TelegramGroupNotFoundError';
  }
}

export class MahallaNameAlreadyExistsError extends Error {
  readonly code = 'MAHALLA_NAME_EXISTS' as const;
  constructor(mahallaName: string) {
    super(`«${mahallaName}» номли маҳалла ушбу туманда аллақачон мавжуд.`);
    this.name = 'MahallaNameAlreadyExistsError';
  }
}

export class GroupAlreadyMappedError extends Error {
  readonly code = 'GROUP_ALREADY_MAPPED' as const;
  constructor(chatId: string) {
    super(`«${chatId}» ID рақамли Telegram гуруҳ ушбу туманда аллақачон бошқа маҳаллага бириктирилган.`);
    this.name = 'GroupAlreadyMappedError';
  }
}

export class GroupAlreadyAssignedError extends Error {
  readonly code = 'GROUP_ALREADY_ASSIGNED' as const;
  constructor(chatId: string) {
    super(`«${chatId}» ID рақамли Telegram гуруҳ бошқа туманга бириктирилган.`);
    this.name = 'GroupAlreadyAssignedError';
  }
}

export class BotNotConnectedError extends Error {
  readonly code = 'TELEGRAM_BOT_NOT_FOUND' as const;
  constructor(districtId: string) {
    super(`Гуруҳларни созлашдан аввал туман учун Telegram ботни уланг (District ID: ${districtId}).`);
    this.name = 'BotNotConnectedError';
  }
}

export class UserbotSessionNotActiveError extends Error {
  readonly code = 'USERBOT_SESSION_NOT_ACTIVE' as const;
  constructor(districtId: string, status?: string) {
    super(
      status
        ? `Туманда Userbot сессияси фаол эмас (District ID: ${districtId}, ҳолати: ${status}).`
        : `Туманда Userbot сессияси мавжуд эмас (District ID: ${districtId}).`,
    );
    this.name = 'UserbotSessionNotActiveError';
  }
}

export interface Actor {
  id: string;
  role: string;
  username?: string;
}

export interface ClientInfo {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface GroupServiceOptions {
  sessionManager?: TelegramTestSessionManager;
}

/**
 * Validates a Telegram group chat via the Bot API and returns resolved chat metadata.
 * Enforces group/supergroup type, passive non-admin membership (AD-6), and privacy mode (AD-6).
 * Used by both createDistrictTelegramGroup and updateDistrictTelegramGroup.
 */
async function validateGroupChatWithTelegram(
  token: string,
  chatId: string,
  botId: string,
): Promise<{ chatTitle: string; chatUsername: string | null; isPrivacyDisabled: boolean }> {
  const chatInfo = await getTelegramChat(token, chatId);
  if (chatInfo.chatType !== 'group' && chatInfo.chatType !== 'supergroup') {
    throw new TelegramIntegrationError(
      'Фақат Telegram гуруҳларини (гуруҳ ёки супергуруҳ) бириктириш мумкин. Канал ёки шахсий ёзишмалар қабул қилинмайди.',
      'INVALID_CHAT_TYPE',
      400,
    );
  }
  await verifyBotGroupMembership(token, chatId, botId);
  const isPrivacyDisabled = await checkGroupPrivacyMode(token);
  return {
    chatTitle: chatInfo.chatTitle,
    chatUsername: chatInfo.chatUsername,
    isPrivacyDisabled,
  };
}

export function formatTelegramGroup(row: DistrictTelegramGroup): TelegramGroupMapping {
  return {
    id: row.id,
    districtId: row.districtId,
    mahallaName: row.mahallaName,
    telegramChatId: row.telegramChatId,
    telegramChatTitle: row.telegramChatTitle,
    telegramChatUsername: row.telegramChatUsername || null,
    status: TelegramGroupStatusSchema.parse(row.status),
    transport: row.transport,
    botMembershipStatus: row.botMembershipStatus || null,
    privacyModeDisabled: row.privacyModeDisabled,
    testMessageReceivedAt: row.testMessageReceivedAt ? row.testMessageReceivedAt.toISOString() : null,
    lastValidatedAt: row.lastValidatedAt ? row.lastValidatedAt.toISOString() : null,
    lastError: row.lastError || null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listDistrictTelegramGroups(
  db: DbClient,
  districtId: string,
): Promise<TelegramGroupMapping[]> {
  const [district] = await db
    .select({ id: districts.id })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  const rows = await db
    .select()
    .from(districtTelegramGroups)
    .where(eq(districtTelegramGroups.districtId, districtId))
    .orderBy(districtTelegramGroups.createdAt);

  return rows.map(formatTelegramGroup);
}

export async function getDistrictTelegramGroup(
  db: DbClient,
  districtId: string,
  groupId: string,
): Promise<TelegramGroupMapping> {
  const [district] = await db
    .select({ id: districts.id })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  const [row] = await db
    .select()
    .from(districtTelegramGroups)
    .where(
      and(
        eq(districtTelegramGroups.districtId, districtId),
        eq(districtTelegramGroups.id, groupId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new TelegramGroupNotFoundError(groupId);
  }

  return formatTelegramGroup(row);
}

export async function createDistrictTelegramGroup(
  db: DbClient,
  districtId: string,
  input: CreateTelegramGroupRequest,
  actor?: Actor,
  clientInfo?: ClientInfo,
): Promise<TelegramGroupMapping> {
  const [district] = await db
    .select({ id: districts.id, name: districts.name })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  const trimmedChatId = input.telegramChatId.trim();
  const trimmedMahalla = input.mahallaName.trim();
  const transport: GroupTransport = input.transport ?? 'BOT_API';

  let chatTitle = trimmedMahalla;
  let chatUsername: string | null = null;
  let isPrivacyDisabled = false;
  let botMembershipStatus: string | null = null;

  if (transport === 'USERBOT') {
    const [session] = await db
      .select({ id: districtTelegramUserbotSessions.id, status: districtTelegramUserbotSessions.status })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    if (!session || session.status !== 'ACTIVE') {
      throw new UserbotSessionNotActiveError(districtId, session?.status);
    }
  } else {
    const [botRow] = await db
      .select()
      .from(districtTelegramBots)
      .where(eq(districtTelegramBots.districtId, districtId))
      .limit(1);

    if (!botRow || botRow.status !== 'VALID') {
      throw new BotNotConnectedError(districtId);
    }

    const token = decryptToken({
      encryptedToken: botRow.encryptedToken,
      tokenIv: botRow.tokenIv,
      tokenTag: botRow.tokenTag,
    });

    const validated = await validateGroupChatWithTelegram(
      token,
      trimmedChatId,
      botRow.botId,
    );
    chatTitle = validated.chatTitle;
    chatUsername = validated.chatUsername;
    isPrivacyDisabled = validated.isPrivacyDisabled;
    botMembershipStatus = 'member';
  }

  const groupId = `dtg_${crypto.randomUUID()}`;
  const now = new Date();

  let savedRow: DistrictTelegramGroup | undefined;

  try {
    await db.transaction(async (tx) => {
      const [existingMahalla] = await tx
        .select({ id: districtTelegramGroups.id })
        .from(districtTelegramGroups)
        .where(
          and(
            eq(districtTelegramGroups.districtId, districtId),
            sql`LOWER(${districtTelegramGroups.mahallaName}) = LOWER(${trimmedMahalla})`,
          ),
        )
        .limit(1);

      if (existingMahalla) {
        throw new MahallaNameAlreadyExistsError(trimmedMahalla);
      }

      const [existingChat] = await tx
        .select({ id: districtTelegramGroups.id, districtId: districtTelegramGroups.districtId })
        .from(districtTelegramGroups)
        .where(eq(districtTelegramGroups.telegramChatId, trimmedChatId))
        .limit(1);

      if (existingChat) {
        if (existingChat.districtId === districtId) {
          throw new GroupAlreadyMappedError(trimmedChatId);
        } else {
          throw new GroupAlreadyAssignedError(trimmedChatId);
        }
      }

      const [inserted] = await tx
        .insert(districtTelegramGroups)
        .values({
          id: groupId,
          districtId,
          mahallaName: trimmedMahalla,
          telegramChatId: trimmedChatId,
          telegramChatTitle: chatTitle,
          telegramChatUsername: chatUsername,
          status: 'VALID',
          transport,
          botMembershipStatus,
          privacyModeDisabled: isPrivacyDisabled,
          lastValidatedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      savedRow = inserted;

      await recordAuditEvent(tx, {
        districtId,
        actorId: actor?.id || null,
        actorRole: actor?.role || null,
        action: 'DISTRICT_GROUP_MAPPED',
        metadata: {
          districtId,
          groupId,
          mahallaName: trimmedMahalla,
          telegramChatId: trimmedChatId,
          telegramChatTitle: chatTitle,
          transport,
        },
        ipAddress: clientInfo?.ipAddress || null,
        userAgent: clientInfo?.userAgent || null,
      });
    });
  } catch (err: unknown) {
    if (
      err instanceof MahallaNameAlreadyExistsError ||
      err instanceof GroupAlreadyMappedError ||
      err instanceof GroupAlreadyAssignedError
    ) {
      throw err;
    }

    mapPostgresConstraintError(err, {
      district_telegram_groups_district_mahalla_lower_idx: () => new MahallaNameAlreadyExistsError(trimmedMahalla),
      mahalla_name: () => new MahallaNameAlreadyExistsError(trimmedMahalla),
      district_telegram_groups_chat_id_idx: () => new GroupAlreadyAssignedError(trimmedChatId),
      telegram_chat_id: () => new GroupAlreadyAssignedError(trimmedChatId),
    });
    throw err;
  }

  if (!savedRow) {
    throw new Error('Failed to create telegram group mapping.');
  }

  return formatTelegramGroup(savedRow);
}

export async function updateDistrictTelegramGroup(
  db: DbClient,
  districtId: string,
  groupId: string,
  input: UpdateTelegramGroupRequest,
  actor?: Actor,
  clientInfo?: ClientInfo,
  _options: GroupServiceOptions = {},
): Promise<TelegramGroupMapping> {
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

  const newMahallaName = input.mahallaName ? input.mahallaName.trim() : group.mahallaName;
  const newChatId = input.telegramChatId ? input.telegramChatId.trim() : group.telegramChatId;
  const newTransport = input.transport !== undefined ? input.transport : group.transport;
  const isChatChanged = newChatId !== group.telegramChatId;
  const isMahallaChanged = newMahallaName.toLowerCase() !== group.mahallaName.toLowerCase();
  const isTransportChanged = newTransport !== group.transport;

  if (
    !isChatChanged &&
    !isMahallaChanged &&
    !isTransportChanged &&
    input.mahallaName === undefined &&
    input.telegramChatId === undefined &&
    input.transport === undefined
  ) {
    return formatTelegramGroup(group);
  }

  // When setting/switching transport to 'USERBOT', verify that the District has an active userbot session
  if ((isTransportChanged || input.transport === 'USERBOT') && newTransport === 'USERBOT') {
    const [session] = await db
      .select({ id: districtTelegramUserbotSessions.id, status: districtTelegramUserbotSessions.status })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    if (!session || session.status !== 'ACTIVE') {
      throw new UserbotSessionNotActiveError(districtId, session?.status);
    }
  }

  const [botRow] = await db
    .select()
    .from(districtTelegramBots)
    .where(eq(districtTelegramBots.districtId, districtId))
    .limit(1);

  if ((isChatChanged && newTransport === 'BOT_API') || (isTransportChanged && newTransport === 'BOT_API')) {
    if (!botRow || botRow.status !== 'VALID') {
      throw new BotNotConnectedError(districtId);
    }
  }

  let chatInfo = {
    chatTitle: group.telegramChatTitle,
    chatUsername: group.telegramChatUsername,
  };
  let isPrivacyDisabled = group.privacyModeDisabled;
  let botMembershipStatus = group.botMembershipStatus;

  if (isChatChanged) {
    if (newTransport === 'BOT_API') {
      if (!botRow || botRow.status !== 'VALID') {
        throw new BotNotConnectedError(districtId);
      }
      const token = decryptToken({
        encryptedToken: botRow.encryptedToken,
        tokenIv: botRow.tokenIv,
        tokenTag: botRow.tokenTag,
      });

      const validated = await validateGroupChatWithTelegram(token, newChatId, botRow.botId);
      isPrivacyDisabled = validated.isPrivacyDisabled;
      chatInfo = {
        chatTitle: validated.chatTitle,
        chatUsername: validated.chatUsername,
      };
      botMembershipStatus = 'member';
    } else {
      chatInfo = {
        chatTitle: newMahallaName,
        chatUsername: null,
      };
      isPrivacyDisabled = false;
      botMembershipStatus = null;
    }
  } else if (isTransportChanged) {
    if (newTransport === 'USERBOT') {
      botMembershipStatus = null;
      isPrivacyDisabled = false;
    }
  }

  const now = new Date();
  let updatedRow: DistrictTelegramGroup | undefined;

  await db.transaction(async (tx) => {
    if (newMahallaName.toLowerCase() !== group.mahallaName.toLowerCase()) {
      const [existingMahalla] = await tx
        .select({ id: districtTelegramGroups.id })
        .from(districtTelegramGroups)
        .where(
          and(
            eq(districtTelegramGroups.districtId, districtId),
            sql`LOWER(${districtTelegramGroups.mahallaName}) = LOWER(${newMahallaName})`,
          ),
        )
        .limit(1);

      if (existingMahalla) {
        throw new MahallaNameAlreadyExistsError(newMahallaName);
      }
    }

    if (isChatChanged) {
      const [existingChat] = await tx
        .select({ id: districtTelegramGroups.id, districtId: districtTelegramGroups.districtId })
        .from(districtTelegramGroups)
        .where(eq(districtTelegramGroups.telegramChatId, newChatId))
        .limit(1);

      if (existingChat && existingChat.id !== groupId) {
        if (existingChat.districtId === districtId) {
          throw new GroupAlreadyMappedError(newChatId);
        } else {
          throw new GroupAlreadyAssignedError(newChatId);
        }
      }
    }

    const [updated] = await tx
      .update(districtTelegramGroups)
      .set({
        mahallaName: newMahallaName,
        telegramChatId: newChatId,
        telegramChatTitle: chatInfo.chatTitle,
        telegramChatUsername: chatInfo.chatUsername,
        transport: newTransport,
        status: isChatChanged ? 'VALID' : group.status,
        botMembershipStatus: isChatChanged || isTransportChanged ? botMembershipStatus : group.botMembershipStatus,
        privacyModeDisabled: isPrivacyDisabled,
        testMessageReceivedAt: isChatChanged ? null : group.testMessageReceivedAt,
        lastValidatedAt: isChatChanged ? now : group.lastValidatedAt,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(districtTelegramGroups.id, groupId))
      .returning();

    updatedRow = updated;

    if (isChatChanged || isMahallaChanged) {
      await recordAuditEvent(tx, {
        districtId,
        actorId: actor?.id || null,
        actorRole: actor?.role || null,
        action: 'DISTRICT_GROUP_REMAPPED',
        metadata: {
          districtId,
          groupId,
          mahallaName: newMahallaName,
          telegramChatId: newChatId,
          isChatChanged,
        },
        ipAddress: clientInfo?.ipAddress || null,
        userAgent: clientInfo?.userAgent || null,
      });
    }

    if (isTransportChanged) {
      await recordAuditEvent(tx, {
        districtId,
        actorId: actor?.id || null,
        actorRole: actor?.role || null,
        action: 'GROUP_TRANSPORT_CHANGED',
        metadata: {
          districtId,
          groupId,
          mahallaName: newMahallaName,
          previousTransport: group.transport,
          newTransport,
        },
        ipAddress: clientInfo?.ipAddress || null,
        userAgent: clientInfo?.userAgent || null,
      });
    }
  });

  if (!updatedRow) {
    throw new TelegramGroupNotFoundError(groupId);
  }

  return formatTelegramGroup(updatedRow);
}

export async function switchDistrictTelegramGroupTransport(
  db: DbClient,
  districtId: string,
  groupId: string,
  transport: GroupTransport,
  actor?: Actor,
  clientInfo?: ClientInfo,
): Promise<TelegramGroupMapping> {
  return updateDistrictTelegramGroup(
    db,
    districtId,
    groupId,
    { transport },
    actor,
    clientInfo,
  );
}

export async function deleteDistrictTelegramGroup(
  db: DbClient,
  districtId: string,
  groupId: string,
  actor?: Actor,
  clientInfo?: ClientInfo,
  options: GroupServiceOptions = {},
): Promise<{ success: boolean; deletedGroupId: string }> {
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

  (options.sessionManager ?? globalTestSessionManager).resolveSessionFailure(
    districtId,
    groupId,
    'Гуруҳ ўчирилди',
  );

  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(districtTelegramGroups)
      .where(eq(districtTelegramGroups.id, groupId))
      .returning();

    if (!deleted) {
      throw new TelegramGroupNotFoundError(groupId);
    }

    await recordAuditEvent(tx, {
      actorId: actor?.id || null,
      actorRole: actor?.role || null,
      action: 'DISTRICT_GROUP_UNMAPPED',
      metadata: {
        districtId,
        groupId,
        mahallaName: group.mahallaName,
        telegramChatId: group.telegramChatId,
      },
      ipAddress: clientInfo?.ipAddress || null,
      userAgent: clientInfo?.userAgent || null,
    });
  });

  return { success: true, deletedGroupId: groupId };
}
