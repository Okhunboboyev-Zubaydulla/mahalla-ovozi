import crypto from 'node:crypto';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { DbClient, mapPostgresConstraintError } from '../../adapters/db/client.js';
import {
  districts,
  districtTelegramBots,
  districtTelegramGroups,
  districtTelegramUserbotSessions,
  topics,
  DistrictTelegramGroup,
  GroupTransport,
} from '../../adapters/db/schema/index.js';
import {
  TelegramGroupMapping,
  TelegramGroupStatusSchema,
  TelegramGroupAuditAction,
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
    isPaused: row.isPaused,
    isPausedSkippedCount: row.isPausedSkippedCount,
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
      tokenKeyVersion: botRow.tokenKeyVersion,
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
        tokenKeyVersion: botRow.tokenKeyVersion,
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

export interface BulkPauseStateResult {
  groups: TelegramGroupMapping[];
}

/**
 * One of the two operator transitions over the group pause flag. A genuine discriminated union of
 * two bare tags rather than a boolean flag parameter, because the two directions differ in audit
 * action, in whether the episode's skipped count is carried into the trail, and in the target
 * state itself.
 */
type PauseStateTransition = { kind: 'PAUSE' } | { kind: 'RESUME' };

const PAUSE_TRANSITION: PauseStateTransition = { kind: 'PAUSE' };

const RESUME_TRANSITION: PauseStateTransition = { kind: 'RESUME' };

const PAUSE_AUDIT_ACTION: TelegramGroupAuditAction = 'DISTRICT_GROUP_PAUSED';

const RESUME_AUDIT_ACTION: TelegramGroupAuditAction = 'DISTRICT_GROUP_RESUMED';

function transitionAuditAction(transition: PauseStateTransition): TelegramGroupAuditAction {
  return transition.kind === 'PAUSE' ? PAUSE_AUDIT_ACTION : RESUME_AUDIT_ACTION;
}

/**
 * Builds the column patch for one transition. Pausing records the lifetime counter as the start of
 * the new episode; resuming leaves the counter alone, because it is a cumulative lifetime figure
 * that a resume must never reset.
 */
function buildPauseStateColumnPatch(
  row: DistrictTelegramGroup,
  transition: PauseStateTransition,
  now: Date,
) {
  if (transition.kind === 'PAUSE') {
    return {
      isPaused: true,
      isPausedEpisodeStartSkippedCount: row.isPausedSkippedCount,
      updatedAt: now,
    };
  }
  return { isPaused: false, updatedAt: now };
}

/**
 * Builds the audit metadata for one transition. The skipped count of the episode that just ended is
 * carried on resume only, as the difference between the lifetime counter and the value captured
 * when the episode began, so a second cycle reports its own episode rather than the lifetime total.
 */
function buildTransitionAuditMetadata(
  row: DistrictTelegramGroup,
  transition: PauseStateTransition,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    districtId: row.districtId,
    groupId: row.id,
    mahallaName: row.mahallaName,
    previousIsPaused: row.isPaused,
    newIsPaused: transition.kind === 'PAUSE',
  };
  if (transition.kind === 'RESUME') {
    metadata.skippedMessageCount = row.isPausedSkippedCount - row.isPausedEpisodeStartSkippedCount;
  }
  return metadata;
}

/**
 * Applies one pause-state transition to an explicit list of group identifiers within a single
 * District, all-or-nothing.
 *
 * The whole request is resolved before anything is written: every identifier must resolve to a
 * group row owned by the target District, so a stale identifier or a cross-Tuman identifier
 * fails the request as a whole and no state changes for the valid identifiers either. The rows
 * are then locked for the duration of the transaction, so two concurrent bulk requests cannot
 * interleave their reads and writes.
 *
 * The transition is idempotent by construction: a group already in the target state is returned
 * unchanged, its cumulative skipped counter untouched, and no audit record is written, because a
 * repeat that changed nothing must not overstate the trail as a transition.
 */
async function applyGroupPauseStateTransition(
  db: DbClient,
  districtId: string,
  groupIds: string[],
  transition: PauseStateTransition,
  actor?: Actor,
  clientInfo?: ClientInfo,
): Promise<BulkPauseStateResult> {
  const [district] = await db
    .select({ id: districts.id })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  // De-duplicate so a client that repeats an identifier neither double-writes an audit record
  // nor inflates the response beyond the set of groups the request actually named.
  const requestedGroupIds = Array.from(new Set(groupIds));
  const now = new Date();
  const results = new Map<string, DistrictTelegramGroup>();

  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(districtTelegramGroups)
      .where(
        and(
          eq(districtTelegramGroups.districtId, districtId),
          inArray(districtTelegramGroups.id, requestedGroupIds),
        ),
      )
      .for('update');

    // A cross-Tuman identifier and an unknown identifier are deliberately indistinguishable here:
    // both are simply absent from the District-scoped result set, and both fail the whole request.
    if (rows.length !== requestedGroupIds.length) {
      const foundIds = new Set(rows.map((row) => row.id));
      const missingId = requestedGroupIds.find((id) => !foundIds.has(id));
      throw new TelegramGroupNotFoundError(missingId ?? 'unknown');
    }

    for (const row of rows) {
      if (row.isPaused === (transition.kind === 'PAUSE')) {
        results.set(row.id, row);
        continue;
      }

      const [updated] = await tx
        .update(districtTelegramGroups)
        .set(buildPauseStateColumnPatch(row, transition, now))
        .where(eq(districtTelegramGroups.id, row.id))
        .returning();

      if (!updated) {
        throw new TelegramGroupNotFoundError(row.id);
      }

      results.set(row.id, updated);

      await recordAuditEvent(tx, {
        districtId,
        actorId: actor?.id || null,
        actorRole: actor?.role || null,
        action: transitionAuditAction(transition),
        metadata: buildTransitionAuditMetadata(row, transition),
        ipAddress: clientInfo?.ipAddress || null,
        userAgent: clientInfo?.userAgent || null,
      });
    }
  });

  // Preserve request order in the response, resolved back to the de-duplicated identifier list.
  const orderedRows = requestedGroupIds.map((id) => {
    const row = results.get(id);
    if (!row) {
      throw new TelegramGroupNotFoundError(id);
    }
    return row;
  });

  return { groups: orderedRows.map(formatTelegramGroup) };
}

export async function pauseDistrictTelegramGroups(
  db: DbClient,
  districtId: string,
  groupIds: string[],
  actor?: Actor,
  clientInfo?: ClientInfo,
): Promise<BulkPauseStateResult> {
  return applyGroupPauseStateTransition(db, districtId, groupIds, PAUSE_TRANSITION, actor, clientInfo);
}

export async function resumeDistrictTelegramGroups(
  db: DbClient,
  districtId: string,
  groupIds: string[],
  actor?: Actor,
  clientInfo?: ClientInfo,
): Promise<BulkPauseStateResult> {
  return applyGroupPauseStateTransition(db, districtId, groupIds, RESUME_TRANSITION, actor, clientInfo);
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

    // Archive the now-orphaned ACTIVE topics for this mahalla (non-destructive).
    // The group row is the only remaining anchor for the mahalla name, so its
    // removal must not leave topics ACTIVE forever. Case-insensitive matching
    // mirrors district_telegram_groups_district_mahalla_lower_idx, guaranteeing
    // no live sibling group can be orphaned by this update.
    await tx
      .update(topics)
      .set({ status: 'ARCHIVED' })
      .where(
        and(
          eq(topics.districtId, deleted.districtId),
          sql`LOWER(${topics.mahallaName}) = LOWER(${deleted.mahallaName})`,
          eq(topics.status, 'ACTIVE'),
        ),
      );
  });

  return { success: true, deletedGroupId: groupId };
}
