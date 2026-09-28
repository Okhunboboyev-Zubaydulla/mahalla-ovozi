import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DbClient, mapPostgresConstraintError } from '../../adapters/db/client.js';
import { districts, districtTelegramBots, districtTelegramGroups, DistrictTelegramBot } from '../../adapters/db/schema/index.js';
import {
  TelegramBotInfo,
  TelegramBotStatusSchema,
} from '@mahalla-ovozi/api-contracts';
import { cryptoService } from '../../adapters/crypto/index.js';
import { validateTelegramBot } from '../../adapters/telegram/telegram-client.js';
import { recordAuditEvent } from '../audit/audit-service.js';
import { DistrictNotFoundError } from '../districts/districts-service.js';

export class DistrictCancelledError extends Error {
  readonly code = 'DISTRICT_CANCELLED' as const;
  readonly statusCode = 409;
  constructor(districtId: string) {
    super(`Ушбу туман бекор қилинган (District ID: ${districtId}).`);
    this.name = 'DistrictCancelledError';
  }
}

export class BotAlreadyAssignedError extends Error {
  readonly code = 'BOT_ALREADY_ASSIGNED' as const;
  constructor(_botId?: string) {
    super('Ушбу Telegram бот аллақачон бошқа туманга бириктирилган.');
    this.name = 'BotAlreadyAssignedError';
  }
}

export class TelegramBotNotFoundError extends Error {
  readonly code = 'TELEGRAM_BOT_NOT_FOUND' as const;
  constructor(districtId: string) {
    super(`Туманга бот бириктирилмаган (District ID: ${districtId}).`);
    this.name = 'TelegramBotNotFoundError';
  }
}

export function formatTelegramBotInfo(row: DistrictTelegramBot): TelegramBotInfo {
  return {
    id: row.id,
    districtId: row.districtId,
    botId: row.botId,
    botUsername: row.botUsername || null,
    botFirstName: row.botFirstName,
    tokenMasked: row.tokenMasked,
    status: TelegramBotStatusSchema.parse(row.status),
    lastValidatedAt: row.lastValidatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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

export interface ConnectBotOptions {
  validateBotFn?: typeof validateTelegramBot;
}

/**
 * Retrieves the configured Telegram Bot for a given District.
 * Never exposes plaintext tokens, encryption keys, IVs, or auth tags.
 */
export async function getDistrictTelegramBot(
  db: DbClient,
  districtId: string,
): Promise<TelegramBotInfo | null> {
  const [district] = await db
    .select({ id: districts.id })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  const [botRow] = await db
    .select()
    .from(districtTelegramBots)
    .where(eq(districtTelegramBots.districtId, districtId))
    .limit(1);

  if (!botRow) {
    return null;
  }

  return formatTelegramBotInfo(botRow);
}

/**
 * Connects or replaces a Telegram bot for a District.
 * 1. Verifies District existence & SETUP_INCOMPLETE status.
 * 2. Authoritatively validates bot identity via getMe STRICTLY OUTSIDE open DB transactions.
 * 3. Encrypts token under AES-256-GCM.
 * 4. Atomically persists ciphertext & writes privacy-safe audit record.
 */
export async function connectDistrictTelegramBot(
  db: DbClient,
  districtId: string,
  rawToken: string,
  actor?: Actor,
  clientInfo?: ClientInfo,
  options: ConnectBotOptions = {},
): Promise<TelegramBotInfo> {
  const [district] = await db
    .select({ id: districts.id, status: districts.status })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  if (district.status === 'CANCELLED') {
    throw new DistrictCancelledError(districtId);
  }

  // Pure HTTP execution outside DB transaction (AD-6)
  const validateFn = options.validateBotFn ?? validateTelegramBot;
  const validatedBot = await validateFn(rawToken);

  // Authenticated ciphertext encryption at rest (AD-6, AD-9)
  const encryptedPayload = cryptoService.tokens.encrypt(rawToken, 'v1');

  const now = new Date();
  const botRowId = `dtb_${crypto.randomUUID()}`;

  let savedRow: DistrictTelegramBot | undefined;

  try {
    await db.transaction(async (tx) => {
      const [districtInTx] = await tx
        .select({ id: districts.id, status: districts.status })
        .from(districts)
        .where(eq(districts.id, districtId))
        .limit(1);

      if (!districtInTx) {
        throw new DistrictNotFoundError(districtId);
      }

      if (districtInTx.status === 'CANCELLED') {
        throw new DistrictCancelledError(districtId);
      }

      const [existingForDistrict] = await tx
        .select()
        .from(districtTelegramBots)
        .where(eq(districtTelegramBots.districtId, districtId))
        .limit(1);

      if (existingForDistrict) {
        const isBotChanged = existingForDistrict.botId !== validatedBot.botId;
        const [updated] = await tx
          .update(districtTelegramBots)
          .set({
            botId: validatedBot.botId,
            botUsername: validatedBot.botUsername,
            botFirstName: validatedBot.botFirstName,
            encryptedToken: encryptedPayload.encryptedToken,
            tokenIv: encryptedPayload.tokenIv,
            tokenTag: encryptedPayload.tokenTag,
            tokenKeyVersion: encryptedPayload.tokenKeyVersion,
            tokenMasked: encryptedPayload.tokenMasked,
            status: 'VALID',
            lastValidatedAt: now,
            updatedAt: now,
          })
          .where(eq(districtTelegramBots.id, existingForDistrict.id))
          .returning();
        savedRow = updated;

        // Reset existing group mappings to PENDING if bot identity changed
        if (isBotChanged) {
          await tx
            .update(districtTelegramGroups)
            .set({
              status: 'PENDING',
              testMessageReceivedAt: null,
              lastValidatedAt: null,
              lastError: null,
              updatedAt: now,
            })
            .where(eq(districtTelegramGroups.districtId, districtId));
        }
      } else {
        const [inserted] = await tx
          .insert(districtTelegramBots)
          .values({
            id: botRowId,
            districtId,
            botId: validatedBot.botId,
            botUsername: validatedBot.botUsername,
            botFirstName: validatedBot.botFirstName,
            encryptedToken: encryptedPayload.encryptedToken,
            tokenIv: encryptedPayload.tokenIv,
            tokenTag: encryptedPayload.tokenTag,
            tokenKeyVersion: encryptedPayload.tokenKeyVersion,
            tokenMasked: encryptedPayload.tokenMasked,
            status: 'VALID',
            lastValidatedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        savedRow = inserted;
      }

      // Privacy-safe audit log (AD-9: Explicit districtId & Zero secrets/ciphertexts)
      await recordAuditEvent(tx, {
        districtId,
        actorId: actor?.id || null,
        actorRole: actor?.role || null,
        action: 'DISTRICT_TELEGRAM_BOT_CONNECTED',
        metadata: {
          districtId,
          botId: validatedBot.botId,
          botUsername: validatedBot.botUsername,
          keyVersion: encryptedPayload.tokenKeyVersion,
        },
        ipAddress: clientInfo?.ipAddress || null,
        userAgent: clientInfo?.userAgent || null,
      });
    });
  } catch (err: unknown) {
    if (
      err instanceof DistrictNotFoundError ||
      err instanceof DistrictCancelledError ||
      err instanceof BotAlreadyAssignedError
    ) {
      throw err;
    }
    mapPostgresConstraintError(
      err,
      {
        district_telegram_bots_bot_id_idx: () => new BotAlreadyAssignedError(validatedBot.botId),
        bot_id: () => new BotAlreadyAssignedError(validatedBot.botId),
        district_telegram_bots_district_id_idx: () => new BotAlreadyAssignedError(validatedBot.botId),
        district_id: () => new BotAlreadyAssignedError(validatedBot.botId),
      },
      () => new BotAlreadyAssignedError(validatedBot.botId),
    );
    throw err;
  }

  if (!savedRow) {
    throw new Error('Failed to persist telegram bot record.');
  }

  return formatTelegramBotInfo(savedRow);
}

/**
 * Disconnects and deletes a Telegram Bot credential from a District.
 * 1. Verifies District existence & active/incomplete status.
 * 2. Deletes bot record & records privacy-safe audit event.
 */
export async function disconnectDistrictTelegramBot(
  db: DbClient,
  districtId: string,
  actor?: Actor,
  clientInfo?: ClientInfo,
): Promise<{ disconnectedBotId: string }> {
  const [district] = await db
    .select({ id: districts.id, status: districts.status })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!district) {
    throw new DistrictNotFoundError(districtId);
  }

  if (district.status === 'CANCELLED') {
    throw new DistrictCancelledError(districtId);
  }

  const [existingBot] = await db
    .select()
    .from(districtTelegramBots)
    .where(eq(districtTelegramBots.districtId, districtId))
    .limit(1);

  if (!existingBot) {
    throw new TelegramBotNotFoundError(districtId);
  }

  await db.transaction(async (tx) => {
    const [districtInTx] = await tx
      .select({ id: districts.id, status: districts.status })
      .from(districts)
      .where(eq(districts.id, districtId))
      .limit(1);

    if (!districtInTx) {
      throw new DistrictNotFoundError(districtId);
    }

    if (districtInTx.status === 'CANCELLED') {
      throw new DistrictCancelledError(districtId);
    }

    const [deleted] = await tx
      .delete(districtTelegramBots)
      .where(eq(districtTelegramBots.id, existingBot.id))
      .returning();

    if (!deleted) {
      throw new TelegramBotNotFoundError(districtId);
    }

    // Invalidate group mappings for this district upon bot disconnect
    await tx
      .update(districtTelegramGroups)
      .set({
        status: 'PENDING',
        testMessageReceivedAt: null,
        lastValidatedAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(districtTelegramGroups.districtId, districtId));

    await recordAuditEvent(tx, {
      districtId,
      actorId: actor?.id || null,
      actorRole: actor?.role || null,
      action: 'DISTRICT_TELEGRAM_BOT_DISCONNECTED',
      metadata: {
        districtId,
        botId: existingBot.botId,
        botUsername: existingBot.botUsername,
      },
      ipAddress: clientInfo?.ipAddress || null,
      userAgent: clientInfo?.userAgent || null,
    });
  });

  return { disconnectedBotId: existingBot.botId };
}
