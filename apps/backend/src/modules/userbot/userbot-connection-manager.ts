/**
 * MTProto Userbot Connection Manager (Ticket 07).
 * Holds one MTProto client per ACTIVE district session in district_telegram_userbot_sessions.
 * Handles automatic reconnection with exponential backoff, periodic last_seen_at updates,
 * ban detection and alerting, and clean teardown.
 */

import crypto from 'node:crypto';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, and, sql } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import {
  districtTelegramUserbotSessions,
  operationalIssues,
} from '../../adapters/db/schema/index.js';
import { getDecryptedUserbotSession } from '../userbot-session/userbot-session-service.js';
import { recordAuditEvent } from '../audit/audit-service.js';
import { logger } from '../../utils/logger.js';
import type {
  UserbotClientPort,
  UserbotClientFactory,
} from './userbot-client-port.js';
import { createDefaultUserbotClientFactory } from '../../adapters/telegram/userbot-client-adapter.js';
import { normalizeMtprotoUpdate } from '../../adapters/telegram/mtproto-normalizer.js';
import { processUserbotIngestEnvelope } from '../telegram-intake/telegram-intake-service.js';

export interface UserbotConnectionManagerOptions {
  db: DbClient;
  pool?: pg.Pool;
  boss?: PgBoss;
  clientFactory?: UserbotClientFactory;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  lastSeenIntervalMs?: number;
  pollIntervalMs?: number;
  maxFloodWaitMs?: number;
}

export class UserbotConnectionManager {
  private readonly db: DbClient;
  private readonly pool?: pg.Pool;
  private readonly boss?: PgBoss;
  private readonly clientFactory: UserbotClientFactory;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly lastSeenIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxFloodWaitMs?: number;

  private readonly clients: Map<string, UserbotClientPort> = new Map();
  private readonly reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly reconnectAttempts: Map<string, number> = new Map();
  private readonly floodWaitAttempts: Map<string, number> = new Map();
  private readonly bannedDistricts: Set<string> = new Set();
  private readonly authKeyDuplicatedDistricts: Set<string> = new Set();
  private readonly connectingDistricts: Set<string> = new Set();
  private readonly activeSessionKeys: Map<string, string> = new Map(); // sessionHash -> districtId
  private readonly districtToSessionHash: Map<string, string> = new Map(); // districtId -> sessionHash

  private lastSeenTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private isStopping: boolean = false;

  constructor(options: UserbotConnectionManagerOptions) {
    this.db = options.db;
    this.pool = options.pool;
    this.boss = options.boss;
    this.clientFactory = options.clientFactory ?? createDefaultUserbotClientFactory();
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30000;
    this.lastSeenIntervalMs = options.lastSeenIntervalMs ?? 60000;
    this.pollIntervalMs = options.pollIntervalMs ?? 60000;
    this.maxFloodWaitMs = options.maxFloodWaitMs;
  }


  /**
   * Starts the connection manager:
   * Queries active sessions, connects each client, and starts background timers.
   */
  async start(): Promise<void> {
    this.isStopping = false;
    logger.info('Starting UserbotConnectionManager...');

    await this.syncSessions();

    if (this.lastSeenIntervalMs > 0) {
      this.lastSeenTimer = setInterval(() => {
        this.refreshLastSeen().catch((err: unknown) => {
          logger.error({ err }, 'Failed to refresh userbot last_seen_at');
        });
      }, this.lastSeenIntervalMs);
      this.lastSeenTimer.unref();
    }

    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        this.syncSessions().catch((err: unknown) => {
          logger.error({ err }, 'Failed to sync userbot sessions');
        });
      }, this.pollIntervalMs);
      this.pollTimer.unref();
    }

    logger.info(
      { activeDistricts: Array.from(this.clients.keys()) },
      'UserbotConnectionManager started successfully',
    );
  }

  /**
   * Synchronizes managed clients with the database:
   * - Connects sessions currently marked ACTIVE.
   * - Ignores PENDING, DISABLED, and BANNED sessions.
   * - Disconnects and unmanages sessions that are no longer ACTIVE.
   */
  async syncSessions(): Promise<void> {
    if (this.isStopping) {
      return;
    }

    const activeRows = await this.db
      .select({
        districtId: districtTelegramUserbotSessions.districtId,
        status: districtTelegramUserbotSessions.status,
      })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.status, 'ACTIVE'));

    const activeDistrictIds = new Set(activeRows.map((row) => row.districtId));

    // 1. Teardown any managed clients no longer ACTIVE in the database
    for (const districtId of Array.from(this.clients.keys())) {
      if (!activeDistrictIds.has(districtId)) {
        logger.info(
          { districtId },
          'Userbot session no longer ACTIVE in database; disconnecting client',
        );
        await this.disconnectDistrict(districtId);
      }
    }

    // 2. Connect new ACTIVE sessions
    for (const row of activeRows) {
      const districtId = row.districtId;
      if (this.bannedDistricts.has(districtId) || this.authKeyDuplicatedDistricts.has(districtId)) {
        continue;
      }
      if (this.clients.has(districtId)) {
        continue;
      }
      await this.connectDistrict(districtId);
    }
  }

  /**
   * Connects a single district session with single-main-session guard:
   * - Prevents overlapping connection attempts for the same district.
   * - Prevents overlapping connections sharing the same auth key / sessionString.
   */
  private async connectDistrict(districtId: string): Promise<void> {
    if (
      this.isStopping ||
      this.bannedDistricts.has(districtId) ||
      this.authKeyDuplicatedDistricts.has(districtId)
    ) {
      return;
    }

    if (this.connectingDistricts.has(districtId)) {
      logger.info({ districtId }, 'Single-main-session guard: connection already in progress');
      return;
    }

    const existingClient = this.clients.get(districtId);
    if (existingClient && existingClient.isConnected()) {
      logger.info({ districtId }, 'Single-main-session guard: client already connected');
      return;
    }

    this.connectingDistricts.add(districtId);

    try {
      const session = await getDecryptedUserbotSession(this.db, districtId);
      if (!session || !session.sessionString) {
        logger.warn(
          { districtId },
          'Cannot connect userbot: missing decrypted session string',
        );
        return;
      }

      if (session.status !== 'ACTIVE') {
        logger.warn(
          { districtId, status: session.status },
          'Cannot connect userbot: session status is not ACTIVE',
        );
        return;
      }

      // Single-main-session guard: prevent overlapping connections for one auth key
      const sessionHash = crypto.createHash('sha256').update(session.sessionString).digest('hex');
      const activeDistrict = this.activeSessionKeys.get(sessionHash);
      if (activeDistrict && activeDistrict !== districtId) {
        logger.error(
          { districtId, activeDistrict },
          'Single-main-session guard: auth key already in active use by another district; connection rejected',
        );
        return;
      }

      if (existingClient) {
        try {
          await existingClient.disconnect();
        } catch {
          // ignore
        }
        this.clients.delete(districtId);
      }

      const client = this.clientFactory({
        districtId,
        sessionString: session.sessionString,
        apiId: session.apiId,
        apiHash: session.apiHash,
        phoneNumber: session.phoneNumber,
      });

      this.attachClientListeners(districtId, client);
      this.clients.set(districtId, client);
      this.activeSessionKeys.set(sessionHash, districtId);
      this.districtToSessionHash.set(districtId, sessionHash);

      try {
        await client.connect();
        this.reconnectAttempts.set(districtId, 0);
        this.floodWaitAttempts.delete(districtId);
        logger.info({ districtId }, 'Userbot client connected successfully');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.isAuthKeyDuplicated(err)) {
          await this.handleAuthKeyDuplicated(districtId, err);
        } else if (
          msg.includes('PHONE_NUMBER_BANNED') ||
          (err as { code?: string })?.code === 'PHONE_NUMBER_BANNED'
        ) {
          await this.handleBan(districtId, err);
        } else {
          const abnormal = this.detectAbnormalSignal(err);
          if (abnormal) {
            await this.handleAbnormalSignal(districtId, abnormal);
            if (abnormal.signalType === 'FLOOD_WAIT') {
              this.scheduleFloodWaitRetry(districtId, abnormal.waitSeconds ?? 60);
              return;
            }
          }
          logger.error(
            { districtId, err: msg },
            'Initial connection failed for userbot client; scheduling reconnection',
          );
          this.scheduleReconnection(districtId);
        }
      }
    } finally {
      this.connectingDistricts.delete(districtId);
    }
  }

  /**
   * Binds lifecycle and error listeners to an MTProto client.
   */
  private attachClientListeners(districtId: string, client: UserbotClientPort): void {
    client.on('disconnect', (err?: unknown) => {
      logger.warn({ districtId, err }, 'Userbot client disconnected');
      if (
        !this.isStopping &&
        !this.bannedDistricts.has(districtId) &&
        !this.authKeyDuplicatedDistricts.has(districtId)
      ) {
        this.scheduleReconnection(districtId);
      }
    });

    client.on('reconnect', () => {
      logger.info({ districtId }, 'Userbot client reconnected');
      this.reconnectAttempts.set(districtId, 0);
      this.floodWaitAttempts.delete(districtId);
    });

    client.on('error', async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ districtId, err: msg }, 'Userbot client error event');

      if (this.isAuthKeyDuplicated(err)) {
        await this.handleAuthKeyDuplicated(districtId, err).catch((authErr: unknown) => {
          logger.error({ districtId, authErr }, 'Failed to handle auth key duplicated event');
        });
      } else if (
        msg.includes('PHONE_NUMBER_BANNED') ||
        (err as { code?: string })?.code === 'PHONE_NUMBER_BANNED'
      ) {
        await this.handleBan(districtId, err).catch((banErr: unknown) => {
          logger.error({ districtId, banErr }, 'Failed to handle userbot ban event');
        });
      } else {
        const abnormal = this.detectAbnormalSignal(err);
        if (abnormal) {
          await this.handleAbnormalSignal(districtId, abnormal).catch((abErr: unknown) => {
            logger.error({ districtId, abErr }, 'Failed to handle abnormal signal');
          });
          if (abnormal.signalType === 'FLOOD_WAIT') {
            this.scheduleFloodWaitRetry(districtId, abnormal.waitSeconds ?? 60);
            return;
          }
        }
        if (
          !client.isConnected() &&
          !this.isStopping &&
          !this.bannedDistricts.has(districtId) &&
          !this.authKeyDuplicatedDistricts.has(districtId)
        ) {
          this.scheduleReconnection(districtId);
        }
      }
    });

    client.on('ban', (err?: unknown) => {
      logger.error({ districtId, err }, 'Userbot client ban event received');
      this.handleBan(districtId, err).catch((banErr: unknown) => {
        logger.error({ districtId, banErr }, 'Failed to handle userbot ban event');
      });
    });


    client.on('message', async (update: unknown) => {
      try {
        const result = normalizeMtprotoUpdate(update);
        if (result.status === 'NORMALIZED') {
          if (!this.pool || !this.boss) {
            logger.warn(
              { districtId, chatId: result.envelope.chatId, messageId: result.envelope.messageId },
              'Userbot message received but pool or boss is not configured on UserbotConnectionManager',
            );
            return;
          }
          await processUserbotIngestEnvelope(
            this.pool,
            this.boss,
            districtId,
            result.envelope,
          );
        } else {
          logger.debug(
            { districtId, reason: result.reason },
            'Dropped incoming MTProto update during normalization',
          );
        }
      } catch (err: unknown) {
        logger.error(
          { districtId, err },
          'Error processing incoming userbot message event',
        );
      }
    });
  }

  /**
   * Schedules automatic reconnection with exponential backoff.
   */
  private scheduleReconnection(districtId: string): void {
    if (
      this.isStopping ||
      this.bannedDistricts.has(districtId) ||
      this.authKeyDuplicatedDistricts.has(districtId)
    ) {
      return;
    }

    if (this.reconnectTimers.has(districtId)) {
      return;
    }

    const attempts = this.reconnectAttempts.get(districtId) ?? 0;
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * Math.pow(2, attempts),
    );
    this.reconnectAttempts.set(districtId, attempts + 1);

    logger.info(
      { districtId, attempt: attempts + 1, delayMs: delay },
      'Scheduling userbot client reconnection',
    );

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(districtId);

      if (
        this.isStopping ||
        this.bannedDistricts.has(districtId) ||
        this.authKeyDuplicatedDistricts.has(districtId)
      ) {
        return;
      }

      const client = this.clients.get(districtId);
      if (!client) {
        return;
      }

      try {
        logger.info({ districtId, attempt: attempts + 1 }, 'Executing userbot reconnection attempt');
        await client.connect();
        this.reconnectAttempts.set(districtId, 0);
        this.floodWaitAttempts.delete(districtId);
        logger.info({ districtId }, 'Userbot client reconnected successfully');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.isAuthKeyDuplicated(err)) {
          await this.handleAuthKeyDuplicated(districtId, err);
        } else if (
          msg.includes('PHONE_NUMBER_BANNED') ||
          (err as { code?: string })?.code === 'PHONE_NUMBER_BANNED'
        ) {
          await this.handleBan(districtId, err);
        } else {
          const abnormal = this.detectAbnormalSignal(err);
          if (abnormal) {
            await this.handleAbnormalSignal(districtId, abnormal);
            if (abnormal.signalType === 'FLOOD_WAIT') {
              this.scheduleFloodWaitRetry(districtId, abnormal.waitSeconds ?? 60);
              return;
            }
          }
          logger.warn(
            { districtId, err: msg, nextAttempt: attempts + 2 },
            'Userbot reconnection attempt failed; rescheduling',
          );
          this.scheduleReconnection(districtId);
        }
      }
    }, delay);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.reconnectTimers.set(districtId, timer);
  }

  /**
   * Handles Telegram account ban:
   * - Marks district as banned and aborts all future reconnection.
   * - Disconnects client.
   * - Updates session status in DB to BANNED.
   * - Emits USERBOT_SESSION_BANNED audit log.
   * - Creates an active Operational Issue in operational_issues scoped to DISTRICT with component: 'USERBOT', severity: 'Critical', status: 'ACTIVE'.
   */
  async handleBan(districtId: string, error?: unknown): Promise<void> {
    this.bannedDistricts.add(districtId);

    // Cancel pending reconnection timer
    const timer = this.reconnectTimers.get(districtId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(districtId);
    }
    this.reconnectAttempts.delete(districtId);
    this.floodWaitAttempts.delete(districtId);

    // Deregister auth key
    const sessionHash = this.districtToSessionHash.get(districtId);
    if (sessionHash) {
      this.activeSessionKeys.delete(sessionHash);
      this.districtToSessionHash.delete(districtId);
    }

    // Disconnect and remove client
    const client = this.clients.get(districtId);
    if (client) {
      this.clients.delete(districtId);
      try {
        await client.disconnect();
      } catch (err: unknown) {
        logger.warn({ districtId, err }, 'Error disconnecting banned client');
      }
    }

    // 1. Update session status to BANNED in DB
    await this.db
      .update(districtTelegramUserbotSessions)
      .set({
        status: 'BANNED',
        updatedAt: new Date(),
      })
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    // 2. Emit audit event
    await recordAuditEvent(this.db, {
      districtId,
      actorId: 'system:userbot-manager',
      actorRole: 'SYSTEM',
      action: 'USERBOT_SESSION_BANNED',
      metadata: {
        districtId,
        reason: 'PHONE_NUMBER_BANNED',
        error: error instanceof Error ? error.message : String(error ?? 'PHONE_NUMBER_BANNED'),
      },
    });

    // 3. Create active Operational Issue
    const now = new Date();
    const logicalKey = `DISTRICT:${districtId}:USERBOT:USERBOT_SESSION_BANNED`;

    await this.db
      .insert(operationalIssues)
      .values({
        id: `iss_${crypto.randomUUID()}`,
        logicalKey,
        scope: 'DISTRICT',
        districtId,
        component: 'USERBOT',
        issueCategory: 'USERBOT_SESSION_BANNED',
        severity: 'Critical',
        status: 'ACTIVE',
        healthStatus: 'Unavailable',
        sanitizedTitle: 'Telegram userbot сессияси блокланди (PHONE_NUMBER_BANNED)',
        sanitizedDescription: 'Туман Telegram userbot сессияси Telegram томонидан блокланди (PHONE_NUMBER_BANNED).',
        recommendedAction: 'Янги телефон рақами билан янги сессия яратинг.',
        targetRoute: `/telegram-setup?districtId=${districtId}`,
        metadata: {
          errorCode: 'PHONE_NUMBER_BANNED',
          districtId,
        },
        startedAt: now,
        latestCheckAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: operationalIssues.logicalKey,
        targetWhere: sql`${operationalIssues.status} = 'ACTIVE'`,
        set: {
          latestCheckAt: now,
          updatedAt: now,
          metadata: sql`COALESCE(${operationalIssues.metadata}, '{}'::jsonb) || '{"errorCode": "PHONE_NUMBER_BANNED"}'::jsonb`,
        },
      });

    logger.error(
      { districtId },
      'Userbot session banned: status transitioned to BANNED, audit log emitted, operational issue created, and reconnection stopped.',
    );
  }

  /**
   * Handles Telegram AUTH_KEY_DUPLICATED:
   * - Halts reconnection immediately.
   * - Disconnects client and deregisters auth key.
   * - Transitions session status in DB to PENDING (requiring re-login).
   * - Emits USERBOT_SESSION_AUTH_KEY_DUPLICATED audit log.
   * - Creates an active Operational Issue in operational_issues scoped to DISTRICT.
   */
  async handleAuthKeyDuplicated(districtId: string, error?: unknown): Promise<void> {
    this.authKeyDuplicatedDistricts.add(districtId);

    // Cancel pending reconnection timer
    const timer = this.reconnectTimers.get(districtId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(districtId);
    }
    this.reconnectAttempts.delete(districtId);
    this.floodWaitAttempts.delete(districtId);

    // Deregister auth key
    const sessionHash = this.districtToSessionHash.get(districtId);
    if (sessionHash) {
      this.activeSessionKeys.delete(sessionHash);
      this.districtToSessionHash.delete(districtId);
    }

    // Disconnect and remove client
    const client = this.clients.get(districtId);
    if (client) {
      this.clients.delete(districtId);
      try {
        await client.disconnect();
      } catch (err: unknown) {
        logger.warn({ districtId, err }, 'Error disconnecting client on AUTH_KEY_DUPLICATED');
      }
    }

    // 1. Transition session status to PENDING (requires re-login)
    await this.db
      .update(districtTelegramUserbotSessions)
      .set({
        status: 'PENDING',
        updatedAt: new Date(),
      })
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    // 2. Emit audit event
    await recordAuditEvent(this.db, {
      districtId,
      actorId: 'system:userbot-manager',
      actorRole: 'SYSTEM',
      action: 'USERBOT_SESSION_AUTH_KEY_DUPLICATED',
      metadata: {
        districtId,
        reason: 'AUTH_KEY_DUPLICATED',
        error: error instanceof Error ? error.message : String(error ?? 'AUTH_KEY_DUPLICATED'),
      },
    });

    // 3. Create active Operational Issue
    const now = new Date();
    const logicalKey = `DISTRICT:${districtId}:USERBOT:AUTH_KEY_DUPLICATED`;

    await this.db
      .insert(operationalIssues)
      .values({
        id: `iss_${crypto.randomUUID()}`,
        logicalKey,
        scope: 'DISTRICT',
        districtId,
        component: 'USERBOT',
        issueCategory: 'AUTH_KEY_DUPLICATED',
        severity: 'Critical',
        status: 'ACTIVE',
        healthStatus: 'Unavailable',
        sanitizedTitle: 'Telegram userbot сессияси бекор қилинди (AUTH_KEY_DUPLICATED)',
        sanitizedDescription: 'Туман Telegram userbot auth key бошқа сессия томонидан ишлатилди ёки бекор қилинди. Қайта кириш талаб этилади.',
        recommendedAction: 'VPS да CLI орқали сессияга қайта киринг (re-login).',
        targetRoute: `/telegram-setup?districtId=${districtId}`,
        metadata: {
          errorCode: 'AUTH_KEY_DUPLICATED',
          districtId,
        },
        startedAt: now,
        latestCheckAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: operationalIssues.logicalKey,
        targetWhere: sql`${operationalIssues.status} = 'ACTIVE'`,
        set: {
          latestCheckAt: now,
          updatedAt: now,
          metadata: sql`COALESCE(${operationalIssues.metadata}, '{}'::jsonb) || '{"errorCode": "AUTH_KEY_DUPLICATED"}'::jsonb`,
        },
      });

    logger.error(
      { districtId },
      'Userbot auth key duplicated: status transitioned to PENDING, audit log emitted, operational issue created, reconnection halted.',
    );
  }

  /**
   * Handles first abnormal signal (FLOOD_WAIT, PEER_FLOOD, account restrictions):
   * Raises a District-scoped Operational Issue alert before ban.
   */
  async handleAbnormalSignal(
    districtId: string,
    signal: { signalType: string; message: string; waitSeconds?: number },
  ): Promise<void> {
    // 1. Emit audit event
    await recordAuditEvent(this.db, {
      districtId,
      actorId: 'system:userbot-manager',
      actorRole: 'SYSTEM',
      action: 'USERBOT_ABNORMAL_SIGNAL',
      metadata: {
        districtId,
        signalType: signal.signalType,
        message: signal.message,
        waitSeconds: signal.waitSeconds,
      },
    });

    // 2. Create or update active Operational Issue
    const now = new Date();
    const logicalKey = `DISTRICT:${districtId}:USERBOT:${signal.signalType}`;

    await this.db
      .insert(operationalIssues)
      .values({
        id: `iss_${crypto.randomUUID()}`,
        logicalKey,
        scope: 'DISTRICT',
        districtId,
        component: 'USERBOT',
        issueCategory: signal.signalType,
        severity: 'Warning',
        status: 'ACTIVE',
        healthStatus: 'Degraded',
        sanitizedTitle: `Telegram userbot ноодатий ҳолат (${signal.signalType})`,
        sanitizedDescription: `Userbot сессиясида ноодатий ҳолат кузатилди (${signal.signalType}): ${signal.message.slice(0, 200)}`,
        recommendedAction: 'Телеграм чекловлари тугашини кутинг ёки фаолиятни текширинг.',
        targetRoute: `/telegram-setup?districtId=${districtId}`,
        metadata: {
          signalType: signal.signalType,
          waitSeconds: signal.waitSeconds,
          districtId,
        },
        startedAt: now,
        latestCheckAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: operationalIssues.logicalKey,
        targetWhere: sql`${operationalIssues.status} = 'ACTIVE'`,
        set: {
          latestCheckAt: now,
          updatedAt: now,
          metadata: sql`COALESCE(${operationalIssues.metadata}, '{}'::jsonb) || jsonb_build_object('signalType', ${signal.signalType}::text, 'latestSignalAt', ${now.toISOString()}::text)`,
        },
      });

    logger.warn(
      { districtId, signalType: signal.signalType, waitSeconds: signal.waitSeconds },
      'Abnormal signal recorded: District-scoped operational issue created before ban.',
    );
  }

  /**
   * Honors sleep X, retries once, never hammers.
   */
  private scheduleFloodWaitRetry(districtId: string, waitSeconds: number): void {
    if (
      this.isStopping ||
      this.bannedDistricts.has(districtId) ||
      this.authKeyDuplicatedDistricts.has(districtId)
    ) {
      return;
    }

    const attempts = this.floodWaitAttempts.get(districtId) ?? 0;
    if (attempts >= 1) {
      logger.warn(
        { districtId, attempts },
        'FLOOD_WAIT retry already attempted once; halting automatic retry to avoid hammering',
      );
      return;
    }

    this.floodWaitAttempts.set(districtId, attempts + 1);

    // Cancel any existing reconnection timer
    const existingTimer = this.reconnectTimers.get(districtId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.reconnectTimers.delete(districtId);
    }

    const delayMs =
      this.maxFloodWaitMs !== undefined
        ? Math.min(this.maxFloodWaitMs, waitSeconds * 1000)
        : Math.max(1000, waitSeconds * 1000);

    logger.info(
      { districtId, waitSeconds, delayMs },
      'Scheduling single FLOOD_WAIT retry after sleep duration',
    );

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(districtId);
      if (
        this.isStopping ||
        this.bannedDistricts.has(districtId) ||
        this.authKeyDuplicatedDistricts.has(districtId)
      ) {
        return;
      }

      const client = this.clients.get(districtId);
      if (!client) {
        return;
      }

      try {
        logger.info({ districtId }, 'Executing single FLOOD_WAIT retry');
        await client.connect();
        this.reconnectAttempts.set(districtId, 0);
        logger.info({ districtId }, 'Userbot client reconnected successfully after FLOOD_WAIT');

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.isAuthKeyDuplicated(err)) {
          await this.handleAuthKeyDuplicated(districtId, err);
        } else if (
          msg.includes('PHONE_NUMBER_BANNED') ||
          (err as { code?: string })?.code === 'PHONE_NUMBER_BANNED'
        ) {
          await this.handleBan(districtId, err);
        } else {
          const abnormal = this.detectAbnormalSignal(err);
          if (abnormal) {
            await this.handleAbnormalSignal(districtId, abnormal);
            if (abnormal.signalType === 'FLOOD_WAIT') {
              this.scheduleFloodWaitRetry(districtId, abnormal.waitSeconds ?? 60);
              return;
            }
          }
          logger.warn(
            { districtId, err: msg },
            'Userbot FLOOD_WAIT retry failed; halting to prevent hammering',
          );
        }
      }
    }, delayMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.reconnectTimers.set(districtId, timer);
  }

  private isAuthKeyDuplicated(err: unknown): boolean {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code;
    return msg.includes('AUTH_KEY_DUPLICATED') || code === 'AUTH_KEY_DUPLICATED';
  }

  private extractFloodWaitSeconds(err: unknown): number | null {
    if (!err) return null;
    if (typeof err === 'object' && 'seconds' in err && typeof (err as { seconds: unknown }).seconds === 'number') {
      return (err as { seconds: number }).seconds;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const match = msg.match(/FLOOD_WAIT_(\d+)/i) || msg.match(/wait of (\d+) seconds/i);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
    return null;
  }

  private detectAbnormalSignal(
    err: unknown,
  ): { isAbnormal: boolean; signalType: string; message: string; waitSeconds?: number } | null {
    if (!err) return null;
    const msg = err instanceof Error ? err.message : String(err);
    const waitSeconds = this.extractFloodWaitSeconds(err);
    if (waitSeconds !== null || /FLOOD_WAIT/i.test(msg)) {
      return {
        isAbnormal: true,
        signalType: 'FLOOD_WAIT',
        message: msg,
        waitSeconds: waitSeconds ?? 60,
      };
    }
    if (/PEER_FLOOD/i.test(msg)) {
      return {
        isAbnormal: true,
        signalType: 'PEER_FLOOD',
        message: msg,
      };
    }
    if (
      /USER_RESTRICTED/i.test(msg) ||
      /CHAT_WRITE_FORBIDDEN/i.test(msg) ||
      /ACCOUNT_RESTRICTED/i.test(msg)
    ) {
      return {
        isAbnormal: true,
        signalType: 'ACCOUNT_RESTRICTION',
        message: msg,
      };
    }
    return null;
  }


  /**
   * Refreshes last_seen_at for all actively connected sessions in the database.
   */
  async refreshLastSeen(): Promise<void> {
    if (this.isStopping) {
      return;
    }

    const now = new Date();
    const connectedDistricts: string[] = [];

    for (const [districtId, client] of this.clients.entries()) {
      if (client.isConnected()) {
        connectedDistricts.push(districtId);
      }
    }

    if (connectedDistricts.length === 0) {
      return;
    }

    for (const districtId of connectedDistricts) {
      await this.db
        .update(districtTelegramUserbotSessions)
        .set({
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(districtTelegramUserbotSessions.districtId, districtId),
            eq(districtTelegramUserbotSessions.status, 'ACTIVE'),
          ),
        );
    }

    logger.debug(
      { count: connectedDistricts.length, districts: connectedDistricts },
      'Refreshed userbot last_seen_at timestamps in database',
    );
  }

  /**
   * Disconnects a single district cleanly and removes it from management.
   */
  private async disconnectDistrict(districtId: string): Promise<void> {
    const timer = this.reconnectTimers.get(districtId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(districtId);
    }
    this.reconnectAttempts.delete(districtId);
    this.floodWaitAttempts.delete(districtId);

    const sessionHash = this.districtToSessionHash.get(districtId);
    if (sessionHash) {
      this.activeSessionKeys.delete(sessionHash);
      this.districtToSessionHash.delete(districtId);
    }

    const client = this.clients.get(districtId);
    if (client) {
      this.clients.delete(districtId);
      try {
        await client.disconnect();
      } catch (err: unknown) {
        logger.warn({ districtId, err }, 'Error disconnecting userbot client');
      }
    }
  }

  /**
   * Gracefully shuts down the connection manager:
   * Clears timers, stops reconnection attempts, and disconnects all clients cleanly.
   */
  async stop(): Promise<void> {
    this.isStopping = true;
    logger.info('Stopping UserbotConnectionManager gracefully...');

    if (this.lastSeenTimer) {
      clearInterval(this.lastSeenTimer);
      this.lastSeenTimer = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const [districtId, timer] of this.reconnectTimers.entries()) {
      clearTimeout(timer);
      this.reconnectTimers.delete(districtId);
    }
    this.reconnectAttempts.clear();
    this.floodWaitAttempts.clear();
    this.connectingDistricts.clear();
    this.activeSessionKeys.clear();
    this.districtToSessionHash.clear();

    const disconnectPromises: Promise<void>[] = [];
    for (const [districtId, client] of this.clients.entries()) {
      disconnectPromises.push(
        client.disconnect().catch((err: unknown) => {
          logger.warn({ districtId, err }, 'Error disconnecting userbot client during stop');
        }),
      );
    }

    await Promise.allSettled(disconnectPromises);
    this.clients.clear();
    logger.info('UserbotConnectionManager stopped cleanly');
  }

  // Accessor methods for testing & diagnostics
  getClient(districtId: string): UserbotClientPort | undefined {
    return this.clients.get(districtId);
  }

  getConnectedDistricts(): string[] {
    const connected: string[] = [];
    for (const [districtId, client] of this.clients.entries()) {
      if (client.isConnected()) {
        connected.push(districtId);
      }
    }
    return connected;
  }

  getManagedDistricts(): string[] {
    return Array.from(this.clients.keys());
  }

  isDistrictBanned(districtId: string): boolean {
    return this.bannedDistricts.has(districtId);
  }

  isDistrictAuthKeyDuplicated(districtId: string): boolean {
    return this.authKeyDuplicatedDistricts.has(districtId);
  }
}

