/**
 * MTProto Userbot Connection Manager (Ticket 07).
 * Holds one MTProto client per ACTIVE district session in district_telegram_userbot_sessions.
 * Handles automatic reconnection with exponential backoff, periodic last_seen_at updates,
 * ban detection and alerting, and clean teardown.
 */

import crypto from 'node:crypto';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, and, or, sql, asc } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import {
  districtTelegramUserbotSessions,
  districts,
  operationalIssues,
} from '../../adapters/db/schema/index.js';
import {
  getDecryptedUserbotSession,
  UserbotApiHashEnvelopeCorruptError,
  UserbotSessionEnvelopeCorruptError,
  type DecryptedUserbotSession,
} from '../userbot-session/userbot-session-service.js';
import { isUserbotSessionEnvelopeComplete } from '../userbot-session/userbot-credential-envelope.js';

// The predicate now lives in the neutral envelope module (see userbot-credential-envelope.ts) so
// the session service, the preflight CLI and this manager share one implementation of the
// three-state rule. It is re-exported here because it has long been part of this module's surface.
export { isUserbotSessionEnvelopeComplete };
import { recordAuditEvent } from '../audit/audit-service.js';
import { logger } from '../../utils/logger.js';
import type {
  UserbotClientPort,
  UserbotClientFactory,
  ClassifiedUserbotSignal,
} from './userbot-client-port.js';
import { createDefaultUserbotClientFactory } from '../../adapters/telegram/userbot-client-adapter.js';
import { classifyTelegramSignal } from '../../adapters/telegram/telegram-signal-classifier.js';
import type { UserbotAuditAction } from '@mahalla-ovozi/api-contracts';
import { UserbotRuntimeCompositionError } from './userbot-runtime-composition.js';
import { normalizeMtprotoUpdate } from '../../adapters/telegram/mtproto-normalizer.js';
import { processUserbotIngestEnvelope } from '../telegram-intake/telegram-intake-service.js';
import {
  parseUserbotUpdatePosition,
  isNewerUserbotUpdatePosition,
} from './update-position.js';

export interface UserbotConnectionManagerOptions {
  db: DbClient;
  /**
   * The database pool the intake path writes through. Optional in the type only so a test can
   * construct the guard's trigger state honestly; the runtime composition guard in
   * userbot-runtime-composition.ts refuses to start a process without it, and the message
   * handler below escalates instead of dropping when it is absent.
   */
  pool?: pg.Pool;
  /** The job-queue client the intake path enqueues through. See `pool` for why it is optional. */
  boss?: PgBoss;
  /**
   * Escalation hook for an unrecoverable runtime-composition failure. The userbot entrypoint
   * supplies a process-fatal handler here; the failure is rethrown regardless, so a caller that
   * supplies no hook still cannot lose it.
   */
  onFatalRuntimeError?: (err: unknown) => void;
  clientFactory?: UserbotClientFactory;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  lastSeenIntervalMs?: number;
  pollIntervalMs?: number;
  maxFloodWaitMs?: number;
  staleThresholdMs?: number;
}

export interface UserbotSessionHealthReport {
  isHealthy: boolean;
  isConnected: boolean;
  isStale: boolean;
  status: string;
  inboundUpdateCounter: number;
  lastSuccessfulConnectionAt: Date | null;
  lastSeenAt: Date | null;
  reason?: string;
}

export interface GapNotice {
  districtId: string;
  discardedPosition: string;
  recordedAt: Date;
}

/**
 * Checks whether an update position was written by an older library (e.g. GramJS)
 * rather than the current teleproto runtime.
 * Older library positions are treated as absent, wiped in DB, and recorded as gap notices.
 */
export function isOlderLibraryPosition(raw: string | null): boolean {
  if (!raw || typeof raw !== 'string') {
    return false;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.toLowerCase().includes('gramjs')) {
    return true;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      if (parsed.version && parsed.version !== 'teleproto-v1') {
        return true;
      }
      if (parsed.library && parsed.library !== 'teleproto') {
        return true;
      }
      if (typeof parsed.pts !== 'number' && !parsed.version) {
        return true;
      }
    } else {
      return true;
    }
  } catch (parseErr: unknown) {
    // A position that cannot be parsed is treated as an older-library position (the caller then
    // discards it and records a gap notice), but the parse failure is logged rather than silently
    // swallowed so an unexpected stored shape is still observable. Control flow is unchanged.
    logger.warn(
      { err: parseErr, rawPosition: raw },
      'Stored userbot update position is not valid JSON; treating it as an older-library position',
    );
    return true;
  }
  return false;
}

/**
 * Checks whether an error represents an unrecoverable update gap from MTProto.
 * Delegated to the adapter signal classifier to preserve encapsulation.
 */
export function isUnrecoverableGap(err: unknown): boolean {
  return classifyTelegramSignal(err).category === 'UNRECOVERABLE_GAP';
}

export class UserbotConnectionManager {
  private readonly db: DbClient;
  private readonly pool?: pg.Pool;
  private readonly boss?: PgBoss;
  private readonly clientFactory: UserbotClientFactory;
  private readonly onFatalRuntimeError?: (err: unknown) => void;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly lastSeenIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxFloodWaitMs?: number;
  private readonly staleThresholdMs: number;

  private readonly clients: Map<string, UserbotClientPort> = new Map();
  private readonly reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly reconnectAttempts: Map<string, number> = new Map();
  private readonly floodWaitAttempts: Map<string, number> = new Map();
  private readonly bannedDistricts: Set<string> = new Set();
  private readonly authKeyDuplicatedDistricts: Set<string> = new Set();
  private readonly deletedAccountDistricts: Set<string> = new Set();
  private readonly sessionRevokedDistricts: Set<string> = new Set();
  private readonly activeDistrictIds: Set<string> = new Set();
  private readonly connectingDistricts: Set<string> = new Set();
  private readonly activeSessionKeys: Map<string, string> = new Map(); // sessionHash -> districtId
  private readonly districtToSessionHash: Map<string, string> = new Map(); // districtId -> sessionHash
  private readonly gapNotices: Map<string, GapNotice> = new Map();
  private readonly unrecoverableGapDistricts: Set<string> = new Set();
  /**
   * Districts whose message handler is currently awaiting persistence. The client's live update
   * position is only safe to capture while this set does not contain the district, because an
   * outstanding await is exactly the window in which the live position can run ahead of the
   * updates that have actually been persisted.
   */
  private readonly districtsCapturingAtReceive: Set<string> = new Set();

  private lastSeenTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private isStopping: boolean = false;

  constructor(options: UserbotConnectionManagerOptions) {
    this.db = options.db;
    this.pool = options.pool;
    this.boss = options.boss;
    this.clientFactory = options.clientFactory ?? createDefaultUserbotClientFactory();
    this.onFatalRuntimeError = options.onFatalRuntimeError;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30000;
    this.lastSeenIntervalMs = options.lastSeenIntervalMs ?? 60000;
    this.pollIntervalMs = options.pollIntervalMs ?? 60000;
    this.maxFloodWaitMs = options.maxFloodWaitMs;
    this.staleThresholdMs = options.staleThresholdMs ?? 30 * 60 * 1000;
  }


  /**
   * Starts the connection manager:
   * Queries active sessions, connects each client, and starts background timers.
   */
  async start(): Promise<void> {
    this.isStopping = false;
    logger.info('Starting UserbotConnectionManager...');

    logger.info(
      {
        hasDatabasePool: Boolean(this.pool),
        hasJobQueueClient: Boolean(this.boss),
      },
      'Userbot runtime composition: database pool and job-queue client status',
    );

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
      .innerJoin(districts, eq(districtTelegramUserbotSessions.districtId, districts.id))
      .where(
        and(
          eq(districtTelegramUserbotSessions.status, 'ACTIVE'),
          or(eq(districts.status, 'ACTIVE'), eq(districts.status, 'GRACE')),
          eq(districts.accessEligible, true),
        ),
      )
      .orderBy(asc(districtTelegramUserbotSessions.createdAt));

    const activeDistrictIds = new Set(activeRows.map((row) => row.districtId));

    // Revocation recoverability, worker-local: a revoked district is unblocked only when THIS
    // process observes its stored session legitimately re-established (complete envelope on a row
    // that is ACTIVE again after a successful re-login/bootstrap). The guard is cleared here and
    // nowhere else: the API process that performs the re-login holds no reference to this Set, so
    // clearing it from there would be cross-process dead code that only ever passed in tests.
    //
    // Asymmetry with the sibling guards: banned, auth-key-duplicated and deleted-account districts
    // are terminal and must stay blocked forever, so they are deliberately never cleared. A revoked
    // session is the one terminal-looking state an operator can genuinely repair by re-login, so
    // only this set becomes recoverable. Do not 'fix' the siblings into consistency with it.
    await this.clearReestablishedRevocations();

    // 1. Teardown any managed clients no longer active or eligible in the database
    const trackedDistricts = new Set([
      ...this.clients.keys(),
      ...this.reconnectTimers.keys(),
      ...this.activeDistrictIds,
    ]);
    for (const districtId of trackedDistricts) {
      if (!activeDistrictIds.has(districtId)) {
        logger.info(
          { districtId },
          'Userbot session no longer active or eligible in database; disconnecting client',
        );
        await this.disconnectDistrict(districtId);
      }
    }

    // 2. Connect new ACTIVE sessions
    for (const row of activeRows) {
      const districtId = row.districtId;
      if (
        this.bannedDistricts.has(districtId) ||
        this.authKeyDuplicatedDistricts.has(districtId) ||
        this.deletedAccountDistricts.has(districtId) ||
        this.sessionRevokedDistricts.has(districtId)
      ) {
        continue;
      }
      if (this.clients.has(districtId)) {
        continue;
      }
      await this.connectDistrict(districtId);
    }
  }

  /**
   * Clears the revocation guard for every district whose stored session has been legitimately
   * re-established, so reconnection becomes possible again without a process restart.
   *
   * A district stays guarded while its stored session is still invalid: a missing row, a
   * non-ACTIVE status (the revocation handler leaves it PENDING), an all-NULL credential envelope,
   * or a partially populated one. Only a complete envelope on an ACTIVE row counts as recovered.
   */
  private async clearReestablishedRevocations(): Promise<void> {
    if (this.sessionRevokedDistricts.size === 0) {
      return;
    }

    for (const districtId of Array.from(this.sessionRevokedDistricts)) {
      const [row] = await this.db
        .select({
          status: districtTelegramUserbotSessions.status,
          sessionEncrypted: districtTelegramUserbotSessions.sessionEncrypted,
          sessionIv: districtTelegramUserbotSessions.sessionIv,
          sessionTag: districtTelegramUserbotSessions.sessionTag,
          apiHashEncrypted: districtTelegramUserbotSessions.apiHashEncrypted,
          apiHashIv: districtTelegramUserbotSessions.apiHashIv,
          apiHashTag: districtTelegramUserbotSessions.apiHashTag,
        })
        .from(districtTelegramUserbotSessions)
        .where(eq(districtTelegramUserbotSessions.districtId, districtId))
        .limit(1);

      if (!row || row.status !== 'ACTIVE' || !isUserbotSessionEnvelopeComplete(row)) {
        continue;
      }

      this.sessionRevokedDistricts.delete(districtId);
      logger.info(
        { districtId },
        'Userbot session re-established in the database; revocation guard cleared so reconnection can resume',
      );
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
      this.authKeyDuplicatedDistricts.has(districtId) ||
      this.deletedAccountDistricts.has(districtId) ||
      this.sessionRevokedDistricts.has(districtId)
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
      // Subscription eligibility gating: verify district is active/grace and accessEligible
      const [district] = await this.db
        .select({
          id: districts.id,
          status: districts.status,
          accessEligible: districts.accessEligible,
        })
        .from(districts)
        .where(eq(districts.id, districtId))
        .limit(1);

      if (
        !district ||
        (district.status !== 'ACTIVE' && district.status !== 'GRACE') ||
        !district.accessEligible
      ) {
        logger.warn(
          { districtId, status: district?.status, accessEligible: district?.accessEligible },
          'Cannot connect userbot: district is not active/grace or not access eligible',
        );
        if (existingClient) {
          await this.disconnectDistrict(districtId);
        }
        return;
      }

      // A corrupt stored credential envelope is a per-district data fault, so it must not abort the
      // connection cycle for every other district. Both envelope faults are caught here because
      // getDecryptedUserbotSession now reads the session triple as well as the apiHash triple; an
      // uncaught session-envelope fault would take down the whole cycle. Each is logged loudly,
      // naming which credential is corrupt, and the district is skipped; every other error still
      // propagates unchanged.
      //
      // Scope: those catches cover PARTIAL envelopes only, which is all getDecryptedUserbotSession
      // raises. An all-whitespace triple classifies as ABSENT there, so it is not an error at this
      // layer: the session simply decrypts to null and the missing-session branch below returns.
      let session: DecryptedUserbotSession | null;
      try {
        session = await getDecryptedUserbotSession(this.db, districtId);
      } catch (decryptErr: unknown) {
        if (decryptErr instanceof UserbotApiHashEnvelopeCorruptError) {
          logger.error(
            { districtId, err: decryptErr },
            'Cannot connect userbot: stored apiHash credential envelope is corrupt; district skipped',
          );
          return;
        }
        if (decryptErr instanceof UserbotSessionEnvelopeCorruptError) {
          logger.error(
            { districtId, err: decryptErr },
            'Cannot connect userbot: stored session credential envelope is corrupt; district skipped',
          );
          return;
        }
        throw decryptErr;
      }

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

      let initialUpdatePosition: string | null = session.updatePosition;
      if (this.isOlderLibraryPosition(initialUpdatePosition)) {
        const discardedPosition = initialUpdatePosition!;
        const now = new Date();
        this.gapNotices.set(districtId, {
          districtId,
          discardedPosition,
          recordedAt: now,
        });
        logger.warn(
          { districtId, discardedPosition },
          'Older library update position discarded; starting from current state with diagnostic gap notice',
        );
        initialUpdatePosition = null;
        try {
          await this.db
            .update(districtTelegramUserbotSessions)
            .set({
              updatePosition: null,
              updatePositionAdvancedAt: null,
              updatedAt: now,
            })
            .where(eq(districtTelegramUserbotSessions.districtId, districtId));
        } catch (wipeErr: unknown) {
          logger.error({ districtId, err: wipeErr }, 'Failed to wipe older library update position in database');
        }
      }

      const client = this.clientFactory({
        districtId,
        sessionString: session.sessionString,
        apiId: session.apiId,
        apiHash: session.apiHash,
        phoneNumber: session.phoneNumber,
        initialUpdatePosition,
      });

      this.attachClientListeners(districtId, client);
      this.clients.set(districtId, client);
      this.activeSessionKeys.set(sessionHash, districtId);
      this.districtToSessionHash.set(districtId, sessionHash);

      try {
        await client.connect();
        const now = new Date();
        this.activeDistrictIds.add(districtId);
        this.reconnectAttempts.set(districtId, 0);
        this.floodWaitAttempts.delete(districtId);
        logger.info({ districtId }, 'Userbot client connected successfully');

        await this.db
          .update(districtTelegramUserbotSessions)
          .set({
            lastSuccessfulConnectionAt: now,
            lastSeenAt: now,
            isStale: false,
            updatedAt: now,
          })
          .where(eq(districtTelegramUserbotSessions.districtId, districtId));
      } catch (err: unknown) {
        const signal = classifyTelegramSignal(err);
        await this.handleSignal(districtId, signal, { isConnected: false });
      }
    } finally {
      this.connectingDistricts.delete(districtId);
    }
  }

  /**
   * Binds lifecycle and error listeners to an MTProto client.
   */
  private attachClientListeners(districtId: string, client: UserbotClientPort): void {
    client.on('disconnect', async (err?: unknown) => {
      logger.warn({ districtId, err }, 'Userbot client disconnected');
      this.activeDistrictIds.delete(districtId);

      if (err) {
        const signal = classifyTelegramSignal(err);
        await this.handleSignal(districtId, signal, { isConnected: false });
      } else {
        if (
          !this.isStopping &&
          !this.bannedDistricts.has(districtId) &&
          !this.authKeyDuplicatedDistricts.has(districtId) &&
          !this.deletedAccountDistricts.has(districtId) &&
          !this.sessionRevokedDistricts.has(districtId)
        ) {
          this.scheduleReconnection(districtId);
        }
      }
    });

    client.on('reconnect', async () => {
      logger.info({ districtId }, 'Userbot client reconnected');
      this.activeDistrictIds.add(districtId);
      this.reconnectAttempts.set(districtId, 0);
      this.floodWaitAttempts.delete(districtId);

      const now = new Date();
      try {
        await this.db
          .update(districtTelegramUserbotSessions)
          .set({
            lastSuccessfulConnectionAt: now,
            lastSeenAt: now,
            isStale: false,
            updatedAt: now,
          })
          .where(
            and(
              eq(districtTelegramUserbotSessions.districtId, districtId),
              eq(districtTelegramUserbotSessions.status, 'ACTIVE'),
            ),
          );
      } catch (dbErr: unknown) {
        logger.error({ districtId, err: dbErr }, 'Failed to update last_successful_connection_at on reconnect');
      }
    });

    client.on('error', async (err: unknown) => {
      const signal = classifyTelegramSignal(err);
      logger.error({ districtId, signal: signal.category, err: signal.reason }, 'Userbot client error event');
      await this.handleSignal(districtId, signal, { isConnected: client.isConnected() });
    });

    try {
      client.on('signal', async (signal: ClassifiedUserbotSignal) => {
        logger.info({ districtId, category: signal.category }, 'Userbot client typed signal event');
        await this.handleSignal(districtId, signal, { isConnected: client.isConnected() });
      });
    } catch (subscribeErr: unknown) {
      // Mock clients may not implement the signal event; that is expected and benign,
      // but the failure is logged so a real client silently missing the subscription is visible.
      logger.debug(
        { districtId, err: subscribeErr },
        'Userbot client does not implement signal event subscription',
      );
    }

    client.on('ban', (err?: unknown) => {
      logger.error({ districtId, err }, 'Userbot client ban event received');
      this.handleBan(districtId, err).catch((banErr: unknown) => {
        logger.error({ districtId, banErr }, 'Failed to handle userbot ban event');
      });
    });

    try {
      client.on('gap', (details?: { reason?: string; lastKnownPosition?: string | null; error?: Error }) => {
        logger.warn({ districtId, details }, 'Userbot client gap event received');
        this.handleUnrecoverableGap(districtId, details).catch((gapErr: unknown) => {
          logger.error({ districtId, gapErr }, 'Failed to handle userbot client gap event');
        });
      });
    } catch (err: unknown) {
      logger.debug({ districtId, err }, 'Userbot client does not implement gap event subscription');
    }

    client.on('message', async (update: unknown) => {
      // Captured synchronously, before this handler's first await, and only while no other
      // update for this district is already in flight. The client's live position is captured
      // in the same synchronous step in which it hands over the update, so it covers exactly
      // this update and never a later one.
      let receivePosition: string | null = null;
      let positionCaptured = false;
      if (!this.districtsCapturingAtReceive.has(districtId)) {
        receivePosition = client.getUpdatePosition?.() ?? null;
        positionCaptured = receivePosition !== null;
      }
      this.districtsCapturingAtReceive.add(districtId);
      try {
        await this.recordInboundUpdate(districtId);
        const rawType = (update as Record<string, unknown>)?._ || (update as Record<string, unknown>)?.className;
        const signal = classifyTelegramSignal(rawType || update);
        // A gap carried by this update cannot be raised here: whether this pass recovers is not
        // known until the ingest below has run, and the recovery decision lives after that. Raising
        // now would be undone by a recovering pass and immediately re-instated by the recovery
        // block, while a gap arriving on an already-flagged District must still refresh its
        // Operational Issue. The raise is therefore deferred to the end of this pass.
        const pendingGapSignal: ClassifiedUserbotSignal | null =
          signal.category === 'UNRECOVERABLE_GAP' ? signal : null;
        // Set below, and only by the proven-successful ingest block. It records THIS pass's
        // outcome, which is the only thing the deferred raise may consult: the in-memory flag is
        // not equivalent, because a pass that recovers a never-flagged District leaves that flag
        // false for the whole pass and would otherwise be mistaken for a non-recovering one.
        let recoveredThisPass = false;
        // Guards the single exit point below so the deferred raise happens exactly once per pass.
        let deferredGapRaiseDone = false;
        // The deferred raise must survive the throwing regions of this pass: normalizeMtprotoUpdate,
        // processUserbotIngestEnvelope, and a rethrown UserbotRuntimeCompositionError would otherwise
        // drop a legitimate gap signal carried by this update without ever raising it. The finally on
        // this try is the single exit point, so the raise always runs when the pass did not recover.
        try {
          const result = normalizeMtprotoUpdate(update);
          if (result.status === 'NORMALIZED') {
            // Defensive boundary check. The runtime composition guard makes this unreachable in a
            // correctly composed process, but if the invariant is ever violated the failure must
            // be loud and immediate: silently returning here is the silent-loss mechanism this
            // transport exists to remove.
            if (!this.pool || !this.boss) {
              throw new UserbotRuntimeCompositionError(
                `Userbot message for district ${districtId} cannot be ingested: ` +
                  'the database pool or the job-queue client is not configured on UserbotConnectionManager.',
              );
            }
            const ingestResult = await processUserbotIngestEnvelope(
              this.pool,
              this.boss,
              districtId,
              result.envelope,
            );

            const persisted =
              ingestResult.status === 'ACCEPTED' ||
              ingestResult.status === 'UPDATED' ||
              ingestResult.status === 'DUPLICATE';

            // A paused drop is a deliberate application-side decision on a message that will
            // never be acted on, and update_position is stored per District session rather than
            // per chat. Withholding the advance for it would stall the whole session: a Tuman
            // whose every group is paused would freeze its cursor and replay the paused backlog
            // on reconnect, and a later accepted sibling message would silently skip past the
            // paused group. So the advance is shared by the persisted outcomes and the PAUSED
            // drop, and by nothing else. An ordinary unauthorized update is untouched and does
            // not move the cursor, exactly as before.
            const pausedDrop =
              ingestResult.status === 'DROPPED' && ingestResult.reason === 'GROUP_PAUSED';

            if (persisted || pausedDrop) {
              if (persisted) {
                recoveredThisPass = true;
              }

              try {
                // The position persisted is the one captured when this update arrived, never the
                // client's live position at this later point: the live value can already cover
                // updates that have not been persisted, and advancing to it would make Telegram
                // skip them forever after a restart.
                if (positionCaptured && receivePosition !== null) {
                  await this.advanceUpdatePosition(districtId, receivePosition, new Date());
                }
              } catch (advanceErr: unknown) {
                logger.error(
                  { districtId, err: advanceErr },
                  'Failed to advance userbot update position after message persistence',
                );
              }
            }

            if (persisted) {
              // This is the first point in the pass where the ingest is PROVEN successful, so an
              // unrecoverable gap recorded earlier is no longer the current truth: the stream is
              // demonstrably delivering and persisting updates again. Resolving the operational-issue
              // row is what actually clears DEGRADED, not dropping the in-memory flag: the health
              // check falls back to the ACTIVE row and would immediately rehydrate the flag from it.
              try {
                if (this.hasUnrecoverableGap(districtId)) {
                  await this.clearUnrecoverableGap(districtId);
                  logger.info(
                    { districtId },
                    'Unrecoverable gap cleared after a successful userbot ingest; awareness is complete again.',
                  );
                }
              } catch (recoveryErr: unknown) {
                logger.error(
                  { districtId, err: recoveryErr },
                  'Failed to clear the unrecoverable gap after a successful userbot ingest',
                );
              }
            }
          } else {
            logger.debug(
              { districtId, reason: result.reason },
              'Dropped incoming MTProto update during normalization',
            );
          }
        } finally {
          // Deferred raise for this pass, decided by the outcome that has just been established.
          // A pass that recovered -- it reached the proven-successful ingest block, which is the
          // single owner of recovery -- must not raise, or it would immediately contradict the clear
          // that block just performed. Every other pass raises exactly as before, whether or not the
          // District was already flagged, and whether the pass completed or threw. The stream-level
          // signal/error/disconnect paths are untouched and remain unconditionally raising.
          if (pendingGapSignal !== null && !recoveredThisPass && !deferredGapRaiseDone) {
            deferredGapRaiseDone = true;
            try {
              await this.handleUnrecoverableGap(districtId, {
                reason: pendingGapSignal.reason,
                lastKnownPosition: client.getUpdatePosition?.(),
              });
            } catch (gapRaiseErr: unknown) {
              // A failure to raise must never mask the pass's own error, which propagates from the
              // try above: the raise is reported and the original outcome is left intact.
              logger.error(
                { districtId, err: gapRaiseErr },
                'Failed to raise the unrecoverable gap for this pass',
              );
            }
          }
        }
      } catch (err: unknown) {
        // A broken runtime composition is not a per-message failure: the process cannot ingest
        // anything at all. It is escalated on the process-fatal channel and then rethrown, so it
        // can never be absorbed into a log-and-continue path.
        if (err instanceof UserbotRuntimeCompositionError) {
          logger.error(
            { districtId, err },
            'Userbot runtime composition is broken; escalating as fatal',
          );
          if (this.onFatalRuntimeError) {
            this.onFatalRuntimeError(err);
          }
          throw err;
        }

        // An ordinary failure of one update stays non-fatal: the transport survives it and keeps
        // the stream alive. This branch must never be reachable from a composition error.
        logger.error(
          { districtId, err },
          'Error processing incoming userbot message event',
        );
      } finally {
        // Released on every path, including the rethrown composition error, so a district can
        // never be left permanently unable to capture a position at receive time.
        this.districtsCapturingAtReceive.delete(districtId);
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
      this.authKeyDuplicatedDistricts.has(districtId) ||
      this.deletedAccountDistricts.has(districtId) ||
      this.sessionRevokedDistricts.has(districtId)
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
        this.authKeyDuplicatedDistricts.has(districtId) ||
        this.deletedAccountDistricts.has(districtId) ||
        this.sessionRevokedDistricts.has(districtId)
      ) {
        return;
      }

      const client = this.clients.get(districtId);
      if (!client) {
        return;
      }

      // Verify district eligibility before reconnecting
      const [district] = await this.db
        .select({
          id: districts.id,
          status: districts.status,
          accessEligible: districts.accessEligible,
        })
        .from(districts)
        .where(eq(districts.id, districtId))
        .limit(1);

      if (
        !district ||
        (district.status !== 'ACTIVE' && district.status !== 'GRACE') ||
        !district.accessEligible
      ) {
        logger.warn(
          { districtId, status: district?.status, accessEligible: district?.accessEligible },
          'Cannot reconnect userbot: district is not active/grace or not access eligible',
        );
        await this.disconnectDistrict(districtId);
        return;
      }

      try {
        logger.info({ districtId, attempt: attempts + 1 }, 'Executing userbot reconnection attempt');
        await client.connect();
        const now = new Date();
        this.activeDistrictIds.add(districtId);
        this.reconnectAttempts.set(districtId, 0);
        this.floodWaitAttempts.delete(districtId);
        logger.info({ districtId }, 'Userbot client reconnected successfully');

        await this.db
          .update(districtTelegramUserbotSessions)
          .set({
            lastSuccessfulConnectionAt: now,
            lastSeenAt: now,
            isStale: false,
            updatedAt: now,
          })
          .where(
            and(
              eq(districtTelegramUserbotSessions.districtId, districtId),
              eq(districtTelegramUserbotSessions.status, 'ACTIVE'),
            ),
          );
      } catch (err: unknown) {
        const signal = classifyTelegramSignal(err);
        await this.handleSignal(districtId, signal, { isConnected: false });
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

    // Query current session row from DB
    const [existing] = await this.db
      .select({ status: districtTelegramUserbotSessions.status })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    if (existing?.status === 'BANNED') {
      return;
    }
    const previousStatus = existing?.status ?? null;

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
      action: 'USERBOT_SESSION_BANNED' satisfies UserbotAuditAction,
      metadata: {
        districtId,
        previousStatus,
        newStatus: 'BANNED',
        reason: 'ACCOUNT_BANNED',
        error: error instanceof Error ? error.message : String(error ?? 'ACCOUNT_BANNED'),
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
        sanitizedTitle: 'Telegram userbot сессияси блокланди (ACCOUNT_BANNED)',
        sanitizedDescription: 'Туман Telegram userbot сессияси Telegram томонидан блокланди (ACCOUNT_BANNED).',
        recommendedAction: 'Янги телефон рақами билан янги сессия яратинг.',
        targetRoute: `/telegram-setup?districtId=${districtId}`,
        metadata: {
          errorCode: 'ACCOUNT_BANNED',
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
          metadata: sql`COALESCE(${operationalIssues.metadata}, '{}'::jsonb) || '{"errorCode": "ACCOUNT_BANNED"}'::jsonb`,
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

    // Query current session row from DB
    const [existing] = await this.db
      .select({ status: districtTelegramUserbotSessions.status })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    const previousStatus = existing?.status ?? null;

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
      action: 'USERBOT_SESSION_AUTH_KEY_DUPLICATED' satisfies UserbotAuditAction,
      metadata: {
        districtId,
        previousStatus,
        newStatus: 'PENDING',
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
   * Handles Telegram SESSION_REVOKED (session invalidated, authorised elsewhere, or auth key unregistered):
   * - Halts reconnection immediately; a revoked session can never be restored by retrying.
   * - Idempotent: a repeat delivery for the same district is a cheap no-op.
   * - Disconnects client and deregisters auth key.
   * - Transitions session status in DB to PENDING (requiring re-login).
   * - Emits USERBOT_SESSION_REVOKED audit log.
   * - Creates an active Operational Issue in operational_issues scoped to DISTRICT.
   */
  async handleSessionRevoked(districtId: string, error?: unknown): Promise<void> {
    // Idempotency guard: the adapter emits both a typed 'signal' event and an 'error' event for
    // the same failure, and connectDistrict's own catch also routes here. Every arrival after
    // the first must be a no-op so no duplicate issue is raised and no state is reset.
    if (this.sessionRevokedDistricts.has(districtId)) {
      return;
    }
    this.sessionRevokedDistricts.add(districtId);

    // Cancel pending reconnection timer
    const timer = this.reconnectTimers.get(districtId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(districtId);
    }
    this.reconnectAttempts.delete(districtId);
    this.floodWaitAttempts.delete(districtId);
    // Mirrors handleAccountDeleted and disconnectDistrict: the district is no longer managed here,
    // so the active-registry entry must go too rather than lingering as stale state.
    this.activeDistrictIds.delete(districtId);

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
        logger.warn({ districtId, err }, 'Error disconnecting client on session revoked');
      }
    }

    // Query current session row from DB
    const [existing] = await this.db
      .select({ status: districtTelegramUserbotSessions.status })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    const previousStatus = existing?.status ?? null;

    // 1. Transition session status to PENDING (requires re-login).
    //
    // The session ciphertext triple and the apiHash envelope are deliberately LEFT INTACT here.
    // The revocation guard is cleared only when clearReestablishedRevocations observes a complete
    // envelope on a row that is ACTIVE again, so wiping the stored envelope would make the row
    // permanently unrecoverable: the re-login the operator is told to perform could never satisfy
    // the recovery predicate. Clearing the credentials is the kill switch's job
    // (disableDistrictUserbotSession), not revocation's - do not add clearing here.
    await this.db
      .update(districtTelegramUserbotSessions)
      .set({
        status: 'PENDING',
        updatedAt: new Date(),
      })
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    // 2. Emit audit event.
    await recordAuditEvent(this.db, {
      districtId,
      actorId: 'system:userbot-manager',
      actorRole: 'SYSTEM',
      action: 'USERBOT_SESSION_REVOKED' satisfies UserbotAuditAction,
      metadata: {
        districtId,
        previousStatus,
        newStatus: 'PENDING',
        reason: 'USERBOT_SESSION_REVOKED',
        error: error instanceof Error ? error.message : String(error ?? 'USERBOT_SESSION_REVOKED'),
      },
    });

    // 3. Create active Operational Issue
    const now = new Date();
    const logicalKey = `DISTRICT:${districtId}:USERBOT:USERBOT_SESSION_REVOKED`;
    const metadata: Record<string, unknown> = {
      errorCode: 'USERBOT_SESSION_REVOKED',
      districtId,
    };

    await this.db
      .insert(operationalIssues)
      .values({
        id: `iss_${crypto.randomUUID()}`,
        logicalKey,
        scope: 'DISTRICT',
        districtId,
        component: 'USERBOT',
        issueCategory: 'USERBOT_SESSION_REVOKED',
        severity: 'Critical',
        status: 'ACTIVE',
        healthStatus: 'Unavailable',
        sanitizedTitle: 'Telegram userbot сессияси бекор қилинди (сессия ўчирилган)',
        sanitizedDescription: 'Туман Telegram userbot сессияси Telegram томонидан бекор қилинди: сессия ўчирилган, бошқа жойда тасдиқланган ёки auth key рўйхатдан чиқарилган. Қайта кириш талаб этилади.',
        recommendedAction: 'VPS да CLI орқали сессияга қайта киринг (re-login).',
        targetRoute: `/telegram-setup?districtId=${districtId}`,
        metadata,
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
          metadata: sql`COALESCE(${operationalIssues.metadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
        },
      });

    logger.error(
      { districtId },
      'Userbot session revoked: status transitioned to PENDING, audit log emitted, operational issue created, reconnection halted.',
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
      action: 'USERBOT_ABNORMAL_SIGNAL' satisfies UserbotAuditAction,
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
      this.authKeyDuplicatedDistricts.has(districtId) ||
      this.deletedAccountDistricts.has(districtId) ||
      this.sessionRevokedDistricts.has(districtId)
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
        this.authKeyDuplicatedDistricts.has(districtId) ||
        this.deletedAccountDistricts.has(districtId) ||
        this.sessionRevokedDistricts.has(districtId)
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
        const now = new Date();
        this.activeDistrictIds.add(districtId);
        this.reconnectAttempts.set(districtId, 0);
        logger.info({ districtId }, 'Userbot client reconnected successfully after FLOOD_WAIT');

        await this.db
          .update(districtTelegramUserbotSessions)
          .set({
            lastSuccessfulConnectionAt: now,
            lastSeenAt: now,
            isStale: false,
            updatedAt: now,
          })
          .where(
            and(
              eq(districtTelegramUserbotSessions.districtId, districtId),
              eq(districtTelegramUserbotSessions.status, 'ACTIVE'),
            ),
          );
      } catch (err: unknown) {
        const signal = classifyTelegramSignal(err);
        await this.handleSignal(districtId, signal, { isConnected: false });
      }
    }, delayMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.reconnectTimers.set(districtId, timer);
  }

  isAccountDeleted(err: unknown): boolean {
    return classifyTelegramSignal(err).category === 'ACCOUNT_DELETED';
  }

  /**
   * Centralized signal dispatcher for MTProto client events, errors, and disconnects.
   * Dispatches strictly on ClassifiedUserbotSignal.category.
   */
  async handleSignal(
    districtId: string,
    signal: ClassifiedUserbotSignal,
    options?: { isConnected?: boolean },
  ): Promise<void> {
    switch (signal.category) {
      case 'ACCOUNT_DELETED':
        await this.handleAccountDeleted(districtId, signal.error ?? signal.reason);
        break;

      case 'AUTH_KEY_DUPLICATED':
        await this.handleAuthKeyDuplicated(districtId, signal.error ?? signal.reason);
        break;

      case 'SESSION_REVOKED':
        // The session is dead on Telegram's side: retrying cannot restore it, so reconnection is
        // deliberately never scheduled for this category.
        await this.handleSessionRevoked(districtId, signal.error ?? signal.reason);
        break;

      case 'ACCOUNT_BANNED':
        await this.handleBan(districtId, signal.error ?? signal.reason);
        break;

      case 'UNRECOVERABLE_GAP':
        await this.handleUnrecoverableGap(districtId, {
          reason: signal.reason,
          error: signal.error,
          lastKnownPosition:
            signal.lastKnownPosition ?? this.clients.get(districtId)?.getUpdatePosition?.(),
        });
        if (
          options?.isConnected === false ||
          !this.clients.get(districtId)?.isConnected()
        ) {
          this.scheduleReconnection(districtId);
        }
        break;

      case 'FLOOD_WAIT':
        await this.handleAbnormalSignal(districtId, {
          signalType: 'FLOOD_WAIT',
          message: signal.reason,
          waitSeconds: signal.waitSeconds,
        });
        this.scheduleFloodWaitRetry(districtId, signal.waitSeconds);
        break;

      case 'PEER_FLOOD':
      case 'ACCOUNT_RESTRICTION':
        await this.handleAbnormalSignal(districtId, {
          signalType: signal.category,
          message: signal.reason,
        });
        if (
          options?.isConnected === false ||
          !this.clients.get(districtId)?.isConnected()
        ) {
          this.scheduleReconnection(districtId);
        }
        break;

      case 'TRANSIENT_DISCONNECT':
        logger.warn(
          { districtId, reason: signal.reason },
          'Transient MTProto disconnect detected; scheduling reconnection without state invalidation',
        );
        if (
          options?.isConnected === false ||
          !this.clients.get(districtId)?.isConnected()
        ) {
          this.scheduleReconnection(districtId);
        }
        break;

      case 'UNCLASSIFIED':
      default:
        logger.warn(
          { districtId, reason: signal.reason },
          'Unclassified userbot client signal/error; scheduling reconnection',
        );
        if (
          options?.isConnected === false ||
          !this.clients.get(districtId)?.isConnected()
        ) {
          this.scheduleReconnection(districtId);
        }
        break;
    }
  }

  /**
   * Handles Telegram account deleted on Telegram's side:
   * - Halts reconnection immediately.
   * - Disconnects client and deregisters auth key.
   * - Transitions session status in DB to PENDING (surfaces as PENDING rather than ACTIVE).
   * - Clears stored session secrets.
   * - Emits USERBOT_SESSION_STATUS_UPDATED audit log.
   * - Creates an active Operational Issue in operational_issues scoped to DISTRICT.
   */
  async handleAccountDeleted(districtId: string, error?: unknown): Promise<void> {
    this.deletedAccountDistricts.add(districtId);
    this.activeDistrictIds.delete(districtId);

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
        logger.warn({ districtId, err }, 'Error disconnecting client on account deleted');
      }
    }

    // Query current session row from DB
    const [existing] = await this.db
      .select({ status: districtTelegramUserbotSessions.status })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    const previousStatus = existing?.status ?? 'ACTIVE';

    // 1. Transition session status to PENDING and clear secrets
    await this.db
      .update(districtTelegramUserbotSessions)
      .set({
        status: 'PENDING',
        sessionEncrypted: null,
        sessionIv: null,
        sessionTag: null,
        updatePosition: null,
        updatePositionAdvancedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    // 2. Emit audit event
    await recordAuditEvent(this.db, {
      districtId,
      actorId: 'system:userbot-manager',
      actorRole: 'SYSTEM',
      action: 'USERBOT_SESSION_STATUS_UPDATED' satisfies UserbotAuditAction,
      metadata: {
        districtId,
        previousStatus,
        newStatus: 'PENDING',
        secretsCleared: false,
        reason: 'ACCOUNT_DELETED',
        error: error instanceof Error ? error.message : String(error ?? 'ACCOUNT_DELETED'),
      },
    });

    // 3. Create active Operational Issue
    const now = new Date();
    const logicalKey = `DISTRICT:${districtId}:USERBOT:ACCOUNT_DELETED`;

    await this.db
      .insert(operationalIssues)
      .values({
        id: `iss_${crypto.randomUUID()}`,
        logicalKey,
        scope: 'DISTRICT',
        districtId,
        component: 'USERBOT',
        issueCategory: 'ACCOUNT_DELETED',
        severity: 'Critical',
        status: 'ACTIVE',
        healthStatus: 'Unavailable',
        sanitizedTitle: 'Telegram userbot аккаунти ўчирилган (ACCOUNT_DELETED)',
        sanitizedDescription: 'Туман Telegram userbot аккаунти Telegram томонидан ўчирилган (ACCOUNT_DELETED). Қайта созлаш талаб этилади.',
        recommendedAction: 'Янги телефон рақами билан янги сессия яратинг ва қайта киринг.',
        targetRoute: `/telegram-setup?districtId=${districtId}`,
        metadata: {
          errorCode: 'ACCOUNT_DELETED',
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
          metadata: sql`COALESCE(${operationalIssues.metadata}, '{}'::jsonb) || '{"errorCode": "ACCOUNT_DELETED"}'::jsonb`,
        },
      });

    logger.error(
      { districtId },
      'Userbot account deleted on Telegram: status transitioned to PENDING, secrets cleared, audit log emitted, operational issue created, reconnection halted.',
    );
  }

  /**
   * Handles an unrecoverable update gap:
   * - Records District-scoped Operational Issue in operational_issues naming incomplete awareness
   * - Records last known good update position in metadata and description
   * - Emits USERBOT_UNRECOVERABLE_GAP_DETECTED audit event
   * - Flags district in-memory set unrecoverableGapDistricts
   * - INVARIANT: DB session status remains ACTIVE; client is NOT disconnected; transport keeps running.
   */
  async handleUnrecoverableGap(
    districtId: string,
    details?: { lastKnownPosition?: string | null; reason?: string; error?: unknown },
  ): Promise<void> {
    this.unrecoverableGapDistricts.add(districtId);

    let lastKnownGoodPosition: string | null = details?.lastKnownPosition ?? null;
    if (!lastKnownGoodPosition) {
      lastKnownGoodPosition = await this.getUpdatePosition(districtId);
    }
    if (!lastKnownGoodPosition) {
      const client = this.clients.get(districtId);
      lastKnownGoodPosition = client?.getUpdatePosition?.() ?? null;
    }

    const now = new Date();
    const logicalKey = `DISTRICT:${districtId}:USERBOT:UNRECOVERABLE_GAP`;

    const metadata: Record<string, unknown> = {
      districtId,
      lastKnownGoodPosition: lastKnownGoodPosition ?? null,
      incompleteAwareness: true,
      errorCode: 'UNRECOVERABLE_GAP',
      reason: details?.reason ?? null,
    };

    const posDisplay = lastKnownGoodPosition ?? 'мавжуд эмас';

    await this.db
      .insert(operationalIssues)
      .values({
        id: `iss_${crypto.randomUUID()}`,
        logicalKey,
        scope: 'DISTRICT',
        districtId,
        component: 'USERBOT',
        issueCategory: 'UNRECOVERABLE_GAP',
        severity: 'Warning',
        status: 'ACTIVE',
        healthStatus: 'Degraded',
        sanitizedTitle: 'Telegram хабарлар узилиши (Incomplete Awareness / Тиклаб бўлмайдиган бўшлиқ)',
        sanitizedDescription: `Туман Telegram гуруҳида тиклаб бўлмайдиган хабарлар узилиши (gap) юз берди. Сўнгги маълум ҳолат: ${posDisplay}. Билиш даражаси тўлиқ эмас (incomplete awareness).`,
        recommendedAction: 'Ўтказиб юборилган вақт оралиғидаги хабарларни қўлда текширинг.',
        targetRoute: `/telegram-setup?districtId=${districtId}`,
        metadata,
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
          metadata: sql`COALESCE(${operationalIssues.metadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
        },
      });

    await recordAuditEvent(this.db, {
      districtId,
      actorId: 'system:userbot-manager',
      actorRole: 'SYSTEM',
      action: 'USERBOT_UNRECOVERABLE_GAP_DETECTED' satisfies UserbotAuditAction,
      metadata: {
        districtId,
        lastKnownGoodPosition: lastKnownGoodPosition ?? null,
        incompleteAwareness: true,
        reason: details?.reason,
      },
    });

    logger.warn(
      { districtId, lastKnownGoodPosition, reason: details?.reason },
      'Unrecoverable gap detected: District-scoped operational issue created naming incomplete awareness; transport continues running.',
    );
  }

  /**
   * Atomically records an incoming MTProto update by incrementing inbound_update_counter.
   * Also clears is_stale if it was flagged.
   */
  async recordInboundUpdate(districtId: string): Promise<void> {
    try {
      const now = new Date();
      await this.db
        .update(districtTelegramUserbotSessions)
        .set({
          inboundUpdateCounter: sql`${districtTelegramUserbotSessions.inboundUpdateCounter} + 1`,
          isStale: false,
          updatedAt: now,
        })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      await this.db
        .update(operationalIssues)
        .set({
          status: 'RESOLVED',
          healthStatus: 'Healthy',
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(operationalIssues.logicalKey, `DISTRICT:${districtId}:USERBOT:STALE_INACTIVITY`),
            eq(operationalIssues.status, 'ACTIVE'),
          ),
        );
    } catch (err: unknown) {
      logger.error({ districtId, err }, 'Failed to record inbound update in database');
    }
  }

  /**
   * Refreshes last_seen_at for all actively connected sessions in the database.
   * Also flags connected sessions that have received no inbound updates for an implausibly long period.
   */
  async refreshLastSeen(): Promise<void> {
    if (this.isStopping) {
      return;
    }

    const now = new Date();
    const connectedDistricts: string[] = [];

    for (const [districtId, client] of this.clients.entries()) {
      if (
        client.isConnected() &&
        this.activeDistrictIds.has(districtId) &&
        !this.bannedDistricts.has(districtId) &&
        !this.authKeyDuplicatedDistricts.has(districtId) &&
        !this.deletedAccountDistricts.has(districtId) &&
        !this.sessionRevokedDistricts.has(districtId)
      ) {
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

      await this.evaluateStaleness(districtId, now);
    }

    logger.debug(
      { count: connectedDistricts.length, districts: connectedDistricts },
      'Refreshed userbot last_seen_at timestamps in database',
    );
  }

  /**
   * Evaluates whether an ACTIVE, connected session has received nothing for an implausibly long period.
   * If so, flags it in DB (is_stale = true) and raises a District-scoped Operational Issue.
   */
  async evaluateStaleness(districtId: string, asOfDate: Date): Promise<boolean> {
    const [session] = await this.db
      .select({
        status: districtTelegramUserbotSessions.status,
        lastSuccessfulConnectionAt: districtTelegramUserbotSessions.lastSuccessfulConnectionAt,
        inboundUpdateCounter: districtTelegramUserbotSessions.inboundUpdateCounter,
        isStale: districtTelegramUserbotSessions.isStale,
      })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    if (!session || session.status !== 'ACTIVE' || !session.lastSuccessfulConnectionAt) {
      return false;
    }

    const elapsedMs = asOfDate.getTime() - session.lastSuccessfulConnectionAt.getTime();
    const isStale = elapsedMs > this.staleThresholdMs && session.inboundUpdateCounter === 0;

    if (isStale && !session.isStale) {
      await this.db
        .update(districtTelegramUserbotSessions)
        .set({
          isStale: true,
          updatedAt: asOfDate,
        })
        .where(eq(districtTelegramUserbotSessions.districtId, districtId));

      const logicalKey = `DISTRICT:${districtId}:USERBOT:STALE_INACTIVITY`;
      await this.db
        .insert(operationalIssues)
        .values({
          id: `iss_${crypto.randomUUID()}`,
          logicalKey,
          scope: 'DISTRICT',
          districtId,
          component: 'USERBOT',
          issueCategory: 'USERBOT_STALE',
          severity: 'Warning',
          status: 'ACTIVE',
          healthStatus: 'Degraded',
          sanitizedTitle: 'Telegram userbot фаоллиги йўқ (CONNECTED_DEAF / STALE)',
          sanitizedDescription: `Userbot сессияси ${Math.round(elapsedMs / 1000)} сония олдин уланган бўлса-да, бирорта ҳам янгилик олмади.`,
          recommendedAction: 'Гуруҳ созламалари ва фойдаланувчи бот рухсатларини текширинг.',
          targetRoute: `/telegram-setup?districtId=${districtId}`,
          metadata: {
            districtId,
            reason: 'NO_INBOUND_UPDATES',
            elapsedMs,
          },
          startedAt: asOfDate,
          latestCheckAt: asOfDate,
          createdAt: asOfDate,
          updatedAt: asOfDate,
        })
        .onConflictDoUpdate({
          target: operationalIssues.logicalKey,
          targetWhere: sql`${operationalIssues.status} = 'ACTIVE'`,
          set: {
            latestCheckAt: asOfDate,
            updatedAt: asOfDate,
          },
        });

      logger.warn(
        { districtId, elapsedMs, thresholdMs: this.staleThresholdMs },
        'ACTIVE userbot session received nothing for an implausibly long period; flagged as stale and operational issue raised',
      );
    }

    return isStale;
  }

  /**
   * Evaluates overall connection and health status of a District userbot session.
   */
  async checkSessionHealth(districtId: string): Promise<UserbotSessionHealthReport> {
    const [district] = await this.db
      .select({
        status: districts.status,
        accessEligible: districts.accessEligible,
      })
      .from(districts)
      .where(eq(districts.id, districtId))
      .limit(1);

    const [session] = await this.db
      .select({
        status: districtTelegramUserbotSessions.status,
        lastSuccessfulConnectionAt: districtTelegramUserbotSessions.lastSuccessfulConnectionAt,
        lastSeenAt: districtTelegramUserbotSessions.lastSeenAt,
        inboundUpdateCounter: districtTelegramUserbotSessions.inboundUpdateCounter,
        isStale: districtTelegramUserbotSessions.isStale,
      })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    if (
      district &&
      (!['ACTIVE', 'GRACE'].includes(district.status) || district.accessEligible === false)
    ) {
      if (this.clients.has(districtId) || this.activeDistrictIds.has(districtId)) {
        await this.disconnectDistrict(districtId);
      }
      return {
        isHealthy: false,
        isConnected: false,
        isStale: false,
        status: 'NOT_ENTITLED',
        inboundUpdateCounter: session?.inboundUpdateCounter ?? 0,
        lastSuccessfulConnectionAt: session?.lastSuccessfulConnectionAt ?? null,
        lastSeenAt: session?.lastSeenAt ?? null,
        reason: 'District subscription is not active or eligible',
      };
    }

    if (!session) {
      return {
        isHealthy: false,
        isConnected: false,
        isStale: false,
        status: 'NOT_FOUND',
        inboundUpdateCounter: 0,
        lastSuccessfulConnectionAt: null,
        lastSeenAt: null,
        reason: 'Session not found in database',
      };
    }

    if (session.status !== 'ACTIVE') {
      return {
        isHealthy: false,
        isConnected: false,
        isStale: false,
        status: session.status,
        inboundUpdateCounter: session.inboundUpdateCounter,
        lastSuccessfulConnectionAt: session.lastSuccessfulConnectionAt,
        lastSeenAt: session.lastSeenAt,
        reason: `Session status is ${session.status}`,
      };
    }

    const client = this.clients.get(districtId);
    const isConnected = Boolean(
      !this.isStopping &&
      client &&
      client.isConnected() &&
      this.activeDistrictIds.has(districtId) &&
      !this.bannedDistricts.has(districtId) &&
      !this.authKeyDuplicatedDistricts.has(districtId) &&
      !this.deletedAccountDistricts.has(districtId) &&
      !this.sessionRevokedDistricts.has(districtId),
    );

    if (!isConnected) {
      return {
        isHealthy: false,
        isConnected: false,
        isStale: session.isStale,
        status: 'DISCONNECTED',
        inboundUpdateCounter: session.inboundUpdateCounter,
        lastSuccessfulConnectionAt: session.lastSuccessfulConnectionAt,
        lastSeenAt: session.lastSeenAt,
        reason: 'Client is not connected',
      };
    }

    const isStale = await this.evaluateStaleness(districtId, new Date());

    if (isStale) {
      return {
        isHealthy: false,
        isConnected: true,
        isStale: true,
        status: 'STALE',
        inboundUpdateCounter: session.inboundUpdateCounter,
        lastSuccessfulConnectionAt: session.lastSuccessfulConnectionAt,
        lastSeenAt: session.lastSeenAt,
        reason: 'Session has received no inbound updates for an implausibly long period',
      };
    }

    if (this.unrecoverableGapDistricts.has(districtId)) {
      return {
        isHealthy: false,
        isConnected: true,
        isStale: false,
        status: 'DEGRADED',
        inboundUpdateCounter: session.inboundUpdateCounter,
        lastSuccessfulConnectionAt: session.lastSuccessfulConnectionAt,
        lastSeenAt: session.lastSeenAt,
        reason: 'Unrecoverable update gap detected; awareness is incomplete',
      };
    }

    const [activeGap] = await this.db
      .select({ id: operationalIssues.id })
      .from(operationalIssues)
      .where(
        and(
          eq(operationalIssues.logicalKey, `DISTRICT:${districtId}:USERBOT:UNRECOVERABLE_GAP`),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      )
      .limit(1);

    if (activeGap) {
      this.unrecoverableGapDistricts.add(districtId);
      return {
        isHealthy: false,
        isConnected: true,
        isStale: false,
        status: 'DEGRADED',
        inboundUpdateCounter: session.inboundUpdateCounter,
        lastSuccessfulConnectionAt: session.lastSuccessfulConnectionAt,
        lastSeenAt: session.lastSeenAt,
        reason: 'Unrecoverable update gap detected; awareness is incomplete',
      };
    }

    return {
      isHealthy: true,
      isConnected: true,
      isStale: false,
      status: 'ACTIVE',
      inboundUpdateCounter: session.inboundUpdateCounter,
      lastSuccessfulConnectionAt: session.lastSuccessfulConnectionAt,
      lastSeenAt: session.lastSeenAt,
    };
  }

  /**
   * Disconnects a single district cleanly and removes it from management.
   */
  private async disconnectDistrict(districtId: string): Promise<void> {
    this.activeDistrictIds.delete(districtId);
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

    this.unrecoverableGapDistricts.delete(districtId);

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
    this.activeDistrictIds.clear();
    this.deletedAccountDistricts.clear();
    this.activeSessionKeys.clear();
    this.districtToSessionHash.clear();
    this.unrecoverableGapDistricts.clear();

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
    if (this.isStopping) {
      return [];
    }
    const connected: string[] = [];
    for (const [districtId, client] of this.clients.entries()) {
      if (
        client.isConnected() &&
        this.activeDistrictIds.has(districtId) &&
        !this.bannedDistricts.has(districtId) &&
        !this.authKeyDuplicatedDistricts.has(districtId) &&
        !this.deletedAccountDistricts.has(districtId) &&
        !this.sessionRevokedDistricts.has(districtId)
      ) {
        connected.push(districtId);
      }
    }
    return connected;
  }

  isDistrictConnected(districtId: string): boolean {
    if (
      this.isStopping ||
      this.bannedDistricts.has(districtId) ||
      this.authKeyDuplicatedDistricts.has(districtId) ||
      this.deletedAccountDistricts.has(districtId) ||
      this.sessionRevokedDistricts.has(districtId) ||
      !this.activeDistrictIds.has(districtId)
    ) {
      return false;
    }
    const client = this.clients.get(districtId);
    return Boolean(client && client.isConnected());
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

  isDistrictAccountDeleted(districtId: string): boolean {
    return this.deletedAccountDistricts.has(districtId);
  }

  isDistrictSessionRevoked(districtId: string): boolean {
    return this.sessionRevokedDistricts.has(districtId);
  }

  async getInboundUpdateCount(districtId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: districtTelegramUserbotSessions.inboundUpdateCounter })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);
    return row?.count ?? 0;
  }

  async getLastSuccessfulConnectionAt(districtId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ lastSuccessfulConnectionAt: districtTelegramUserbotSessions.lastSuccessfulConnectionAt })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);
    return row?.lastSuccessfulConnectionAt ?? null;
  }

  /**
   * Writes a new update position, but only when it is strictly newer than the one already
   * stored, so a stale or regressed position can never overwrite a newer one. Returns whether
   * the write happened.
   *
   * The comparison reads the stored value first: an unreadable stored value (absent, malformed,
   * or written by a different version) carries no comparable ordering, so the new position is
   * accepted and replaces it rather than throwing away a valid advance. The next position is
   * persisted in the same statement as the advanced-at timestamp, so the two can never disagree.
   */
  async advanceUpdatePosition(
    districtId: string,
    updatePosition: string,
    advancedAt: Date,
  ): Promise<boolean> {
    const [existing] = await this.db
      .select({ updatePosition: districtTelegramUserbotSessions.updatePosition })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);

    if (!existing) {
      throw new Error(
        `Cannot advance the userbot update position for district ${districtId}: ` +
          'no district_telegram_userbot_sessions row exists for this district.',
      );
    }

    const candidate = parseUserbotUpdatePosition(updatePosition);
    if (candidate === null) {
      throw new Error(
        `Cannot advance the userbot update position for district ${districtId}: ` +
          `the supplied position ${JSON.stringify(updatePosition)} is not a valid ` +
          'teleproto-v1 update position.',
      );
    }

    const stored = parseUserbotUpdatePosition(existing.updatePosition);
    if (!isNewerUserbotUpdatePosition(stored, candidate)) {
      logger.debug(
        { districtId, storedPosition: existing.updatePosition, candidatePosition: updatePosition },
        'Ignored a userbot update position that is not newer than the stored one',
      );
      return false;
    }

    await this.db
      .update(districtTelegramUserbotSessions)
      .set({
        updatePosition,
        updatePositionAdvancedAt: advancedAt,
        updatedAt: advancedAt,
      })
      .where(eq(districtTelegramUserbotSessions.districtId, districtId));

    return true;
  }

  async getUpdatePosition(districtId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ updatePosition: districtTelegramUserbotSessions.updatePosition })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);
    return row?.updatePosition ?? null;
  }

  async getUpdatePositionAdvancedAt(districtId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ updatePositionAdvancedAt: districtTelegramUserbotSessions.updatePositionAdvancedAt })
      .from(districtTelegramUserbotSessions)
      .where(eq(districtTelegramUserbotSessions.districtId, districtId))
      .limit(1);
    return row?.updatePositionAdvancedAt ?? null;
  }

  getGapNotice(districtId: string): GapNotice | null {
    return this.gapNotices.get(districtId) ?? null;
  }

  getGapNotices(): GapNotice[] {
    return Array.from(this.gapNotices.values());
  }

  isOlderLibraryPosition(raw: string | null): boolean {
    return isOlderLibraryPosition(raw);
  }

  hasUnrecoverableGap(districtId: string): boolean {
    return this.unrecoverableGapDistricts.has(districtId);
  }

  async clearUnrecoverableGap(districtId: string): Promise<void> {
    this.unrecoverableGapDistricts.delete(districtId);
    const now = new Date();
    await this.db
      .update(operationalIssues)
      .set({
        status: 'RESOLVED',
        healthStatus: 'Healthy',
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(operationalIssues.logicalKey, `DISTRICT:${districtId}:USERBOT:UNRECOVERABLE_GAP`),
          eq(operationalIssues.status, 'ACTIVE'),
        ),
      );
  }

  isUnrecoverableGap(err: unknown): boolean {
    return isUnrecoverableGap(err);
  }
}

