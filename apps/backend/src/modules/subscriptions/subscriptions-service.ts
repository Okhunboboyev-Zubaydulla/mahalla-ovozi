import { eq, and, asc, sql } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { DbClient, DbOrTx } from '../../adapters/db/client.js';
import { logger } from '../../utils/logger.js';
import {
  districts,
  districtSubscriptions,
  districtDeletionRecords,
  districtTelegramBots,
  districtTelegramGroups,
} from '../../adapters/db/schema/index.js';
import {
  DistrictSubscription,
  SubscriptionStatus,
  SubscriptionStatusSchema,
  UpdateDistrictSubscriptionRequest,
  StartGraceRequest,
  RestoreActiveRequest,
  CancelDistrictRequest,
  StartRecoveryRequest,
} from '@mahalla-ovozi/api-contracts';
import { DistrictNotFoundError } from '../districts/districts-service.js';
import { recordAuditEvent } from '../audit/audit-service.js';
import {
  getOnboardingReadiness,
  DistrictNotReadyForActivationError,
} from '../districts/district-onboarding-engine.js';
import { DistrictAlreadyDeletedError } from './district-deletion-service.js';
import {
  DISTRICT_SUBSCRIPTION_EXPIRY_QUEUE,
  DISTRICT_LIVE_DELETION_QUEUE,
  JobSingletonKeys,
  sendQueueJob,
} from '../../adapters/jobs/boss-client.js';

export class InvalidSubscriptionTransitionError extends Error {
  readonly code = 'INVALID_SUBSCRIPTION_TRANSITION' as const;
  readonly statusCode = 409;
  readonly currentStatus: string;
  readonly requestedTransition: string;

  constructor(currentStatus: string, requestedTransition: string, customMessage?: string) {
    super(
      customMessage ??
        `Ҳозирги ҳолат (${currentStatus}) учун сўралган ўтиш (${requestedTransition}) мумкин эмас.`,
    );
    this.name = 'InvalidSubscriptionTransitionError';
    this.currentStatus = currentStatus;
    this.requestedTransition = requestedTransition;
  }
}

export class SubscriptionConcurrencyConflictError extends Error {
  readonly code = 'SUBSCRIPTION_CONCURRENCY_CONFLICT' as const;
  readonly statusCode = 409;

  constructor(districtId: string) {
    super(
      `Туман обунаси ҳолати бошқа жараён томонидан ўзгартирилган (ID: ${districtId}). Илтимос, саҳифани янгиланг.`,
    );
    this.name = 'SubscriptionConcurrencyConflictError';
  }
}

export class DistrictConfirmationMismatchError extends Error {
  readonly code = 'DISTRICT_CONFIRMATION_MISMATCH' as const;
  readonly statusCode = 400;

  constructor(expectedName: string, receivedName: string) {
    super(
      `Киритилган туман номи ("${receivedName}") ҳақиқий номга ("${expectedName}") мос келмади.`,
    );
    this.name = 'DistrictConfirmationMismatchError';
  }
}

export class RecoveryWindowExpiredError extends Error {
  readonly code = 'RECOVERY_WINDOW_EXPIRED' as const;
  readonly statusCode = 409;
  readonly districtId?: string;

  constructor(districtId?: string) {
    super('30 кунлик тиклаш муддати тугаган. Туманни тиклаш мумкин эмас.');
    this.name = 'RecoveryWindowExpiredError';
    this.districtId = districtId;
  }
}

export function formatDistrictSubscription(row: {
  id: string;
  districtId: string;
  districtName: string;
  region?: string | null;
  status: string;
  statusStartedAt: Date;
  scheduledTransitionAt?: Date | null;
  scheduledTransitionType?: string | null;
  externalPaymentReference?: string | null;
  internalNote?: string | null;
  updatedById?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): DistrictSubscription {
  return {
    id: row.id,
    districtId: row.districtId,
    districtName: row.districtName,
    region: row.region ?? undefined,
    status: SubscriptionStatusSchema.parse(row.status),
    statusStartedAt: row.statusStartedAt.toISOString(),
    scheduledTransitionAt: row.scheduledTransitionAt ? row.scheduledTransitionAt.toISOString() : undefined,
    scheduledTransitionType: row.scheduledTransitionType ?? undefined,
    externalPaymentReference: row.externalPaymentReference ?? undefined,
    internalNote: row.internalNote ?? undefined,
    updatedById: row.updatedById ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function ensureDistrictSubscription(
  db: DbOrTx,
  districtId: string,
  initialStatus?: string,
): Promise<typeof districtSubscriptions.$inferSelect> {
  const [existing] = await db
    .select()
    .from(districtSubscriptions)
    .where(eq(districtSubscriptions.districtId, districtId))
    .limit(1);

  if (existing) {
    return existing;
  }

  const [dist] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!dist) {
    const [tombstone] = await db
      .select()
      .from(districtDeletionRecords)
      .where(eq(districtDeletionRecords.districtId, districtId))
      .limit(1);

    if (tombstone && tombstone.liveDeletionStatus === 'COMPLETED') {
      throw new DistrictAlreadyDeletedError(districtId);
    }
    throw new DistrictNotFoundError(districtId);
  }

  const now = new Date();
  const status = initialStatus ?? (dist.status as SubscriptionStatus) ?? 'ACTIVE';
  const statusStartedAt = dist.activatedAt ?? dist.createdAt ?? now;

  await db
    .insert(districtSubscriptions)
    .values({
      id: `sub_${districtId}`,
      districtId,
      status,
      statusStartedAt,
      createdAt: dist.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: districtSubscriptions.districtId });

  const [created] = await db
    .select()
    .from(districtSubscriptions)
    .where(eq(districtSubscriptions.districtId, districtId))
    .limit(1);

  if (!created) {
    throw new DistrictNotFoundError(districtId);
  }

  return created;
}

export async function listDistrictSubscriptions(
  db: DbClient,
): Promise<DistrictSubscription[]> {
  const allDistricts = await db
    .select({
      id: districts.id,
      name: districts.name,
      region: districts.region,
      status: districts.status,
      activatedAt: districts.activatedAt,
      createdAt: districts.createdAt,
      subId: districtSubscriptions.id,
      subStatus: districtSubscriptions.status,
      subStatusStartedAt: districtSubscriptions.statusStartedAt,
      subScheduledTransitionAt: districtSubscriptions.scheduledTransitionAt,
      subScheduledTransitionType: districtSubscriptions.scheduledTransitionType,
      subExternalPaymentReference: districtSubscriptions.externalPaymentReference,
      subInternalNote: districtSubscriptions.internalNote,
      subUpdatedById: districtSubscriptions.updatedById,
      subCreatedAt: districtSubscriptions.createdAt,
      subUpdatedAt: districtSubscriptions.updatedAt,
    })
    .from(districts)
    .leftJoin(districtSubscriptions, eq(districts.id, districtSubscriptions.districtId))
    .orderBy(asc(districts.name));

  const results: DistrictSubscription[] = [];

  for (const row of allDistricts) {
    if (!row.subId) {
      const sub = await ensureDistrictSubscription(db, row.id, row.status);
      results.push(
        formatDistrictSubscription({
          id: sub.id,
          districtId: row.id,
          districtName: row.name,
          region: row.region,
          status: sub.status,
          statusStartedAt: sub.statusStartedAt,
          scheduledTransitionAt: sub.scheduledTransitionAt,
          scheduledTransitionType: sub.scheduledTransitionType,
          externalPaymentReference: sub.externalPaymentReference,
          internalNote: sub.internalNote,
          updatedById: sub.updatedById,
          createdAt: sub.createdAt,
          updatedAt: sub.updatedAt,
        }),
      );
    } else {
      results.push(
        formatDistrictSubscription({
          id: row.subId,
          districtId: row.id,
          districtName: row.name,
          region: row.region,
          status: row.subStatus ?? row.status,
          statusStartedAt: row.subStatusStartedAt ?? row.activatedAt ?? row.createdAt ?? new Date(),
          scheduledTransitionAt: row.subScheduledTransitionAt,
          scheduledTransitionType: row.subScheduledTransitionType,
          externalPaymentReference: row.subExternalPaymentReference,
          internalNote: row.subInternalNote,
          updatedById: row.subUpdatedById,
          createdAt: row.subCreatedAt ?? row.createdAt ?? new Date(),
          updatedAt: row.subUpdatedAt ?? new Date(),
        }),
      );
    }
  }

  return results;
}

export async function getDistrictSubscription(
  db: DbClient,
  districtId: string,
): Promise<DistrictSubscription> {
  const [dist] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!dist) {
    throw new DistrictNotFoundError(districtId);
  }

  const sub = await ensureDistrictSubscription(db, districtId, dist.status);

  return formatDistrictSubscription({
    id: sub.id,
    districtId: dist.id,
    districtName: dist.name,
    region: dist.region,
    status: sub.status,
    statusStartedAt: sub.statusStartedAt,
    scheduledTransitionAt: sub.scheduledTransitionAt,
    scheduledTransitionType: sub.scheduledTransitionType,
    externalPaymentReference: sub.externalPaymentReference,
    internalNote: sub.internalNote,
    updatedById: sub.updatedById,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  });
}

export async function updateDistrictSubscriptionMetadata(
  db: DbClient,
  districtId: string,
  input: UpdateDistrictSubscriptionRequest,
  actor?: { id: string; role: string },
  context?: { ipAddress?: string | null; userAgent?: string | null },
): Promise<DistrictSubscription> {
  const [dist] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!dist) {
    throw new DistrictNotFoundError(districtId);
  }

  // Ensure record exists before update
  await ensureDistrictSubscription(db, districtId, dist.status);

  const now = new Date();
  const updateFields: Partial<typeof districtSubscriptions.$inferInsert> = {
    updatedAt: now,
    updatedById: actor?.id ?? null,
  };

  if (input.externalPaymentReference !== undefined) {
    updateFields.externalPaymentReference =
      input.externalPaymentReference === null || input.externalPaymentReference === ''
        ? null
        : input.externalPaymentReference;
  }

  if (input.internalNote !== undefined) {
    updateFields.internalNote =
      input.internalNote === null || input.internalNote === ''
        ? null
        : input.internalNote;
  }

  let updatedRow: typeof districtSubscriptions.$inferSelect | undefined;

  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(districtSubscriptions)
      .set(updateFields)
      .where(eq(districtSubscriptions.districtId, districtId))
      .returning();

    updatedRow = updated;

    await recordAuditEvent(tx, {
      districtId,
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'PRODUCT_OWNER',
      action: 'DISTRICT_SUBSCRIPTION_METADATA_UPDATED',
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      metadata: {
        districtId,
        districtName: dist.name,
        externalPaymentReferenceUpdated: input.externalPaymentReference !== undefined,
        internalNoteUpdated: input.internalNote !== undefined,
      },
    });
  });

  if (!updatedRow) {
    throw new DistrictNotFoundError(districtId);
  }

  return formatDistrictSubscription({
    id: updatedRow.id,
    districtId: dist.id,
    districtName: dist.name,
    region: dist.region,
    status: updatedRow.status,
    statusStartedAt: updatedRow.statusStartedAt,
    scheduledTransitionAt: updatedRow.scheduledTransitionAt,
    scheduledTransitionType: updatedRow.scheduledTransitionType,
    externalPaymentReference: updatedRow.externalPaymentReference,
    internalNote: updatedRow.internalNote,
    updatedById: updatedRow.updatedById,
    createdAt: updatedRow.createdAt,
    updatedAt: updatedRow.updatedAt,
  });
}

export async function startDistrictGrace(
  db: DbClient,
  boss: PgBoss | undefined,
  districtId: string,
  payload: StartGraceRequest,
  actor?: { id: string; role: string },
  context?: { ipAddress?: string | null; userAgent?: string | null },
): Promise<DistrictSubscription> {
  const [dist] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!dist) {
    throw new DistrictNotFoundError(districtId);
  }

  // Ensure record exists before starting Grace
  await ensureDistrictSubscription(db, districtId, dist.status);

  const now = new Date();
  const scheduledTransitionAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days in ms

  let updatedRow: typeof districtSubscriptions.$inferSelect | undefined;
  let districtName = dist.name;

  await db.transaction(async (tx) => {
    // 1. Lock districts row first (consistent lock order: districts -> district_subscriptions)
    const lockDistrictResult = await tx.execute<{
      id: string;
      name: string;
      status: string;
      region: string | null;
    }>(sql`SELECT id, name, status, region FROM districts WHERE id = ${districtId} FOR UPDATE`);

    const lockedDistrict = lockDistrictResult.rows[0];
    if (!lockedDistrict) {
      throw new DistrictNotFoundError(districtId);
    }
    districtName = lockedDistrict.name;

    // 2. Lock district_subscriptions row second
    const lockSubResult = await tx.execute<{
      id: string;
      district_id: string;
      status: string;
    }>(sql`SELECT id, district_id, status FROM district_subscriptions WHERE district_id = ${districtId} FOR UPDATE`);

    const lockedSub = lockSubResult.rows[0];
    if (!lockedSub) {
      throw new DistrictNotFoundError(districtId);
    }

    if (lockedSub.status !== 'ACTIVE' || lockedDistrict.status !== 'ACTIVE') {
      throw new InvalidSubscriptionTransitionError(lockedSub.status, 'GRACE');
    }

    // 3. Update district_subscriptions atomically
    const [updatedSub] = await tx
      .update(districtSubscriptions)
      .set({
        status: 'GRACE',
        statusStartedAt: now,
        scheduledTransitionAt,
        scheduledTransitionType: 'AUTOMATIC_SUSPENSION',
        updatedAt: now,
        updatedById: actor?.id ?? null,
      })
      .where(
        and(
          eq(districtSubscriptions.districtId, districtId),
          eq(districtSubscriptions.status, 'ACTIVE'),
        ),
      )
      .returning();

    if (!updatedSub) {
      throw new SubscriptionConcurrencyConflictError(districtId);
    }

    // 4. Synchronize districts table status atomically
    await tx
      .update(districts)
      .set({
        status: 'GRACE',
        updatedAt: now,
      })
      .where(eq(districts.id, districtId));

    updatedRow = updatedSub;

    // 5. Append-only audit logging
    await recordAuditEvent(tx, {
      districtId,
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'PRODUCT_OWNER',
      action: 'DISTRICT_GRACE_STARTED',
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      metadata: {
        districtId,
        districtName: lockedDistrict.name,
        previousValues: { status: 'ACTIVE' },
        newValues: {
          status: 'GRACE',
          scheduledTransitionAt: scheduledTransitionAt.toISOString(),
          scheduledTransitionType: 'AUTOMATIC_SUSPENSION',
        },
        scheduledTransitionAt: scheduledTransitionAt.toISOString(),
        scheduledTransitionType: 'AUTOMATIC_SUSPENSION',
        reason: payload.reason ?? null,
      },
    });
  });

  if (!updatedRow) {
    throw new DistrictNotFoundError(districtId);
  }

  // 6. Enqueue delayed background job in pg-boss if client available
  if (boss) {
    try {
      await sendQueueJob(
        boss,
        DISTRICT_SUBSCRIPTION_EXPIRY_QUEUE,
        { districtId },
        {
          singletonKey: JobSingletonKeys.forSubscriptionExpiry(districtId),
          startAfter: 7 * 24 * 60 * 60, // 7 days in seconds
          retryLimit: 3,
        },
      );
    } catch (jobErr) {
      // Non-fatal if pg-boss enqueue encounters network issue, since recurring cron sweep acts as fallback
      logger.error(
        {
          event: 'SUBSCRIPTION_EXPIRY_JOB_ENQUEUE_FAILED',
          districtId,
          err: (jobErr as Error).message,
        },
        'Failed to enqueue subscription expiry job',
      );
    }
  }

  return formatDistrictSubscription({
    id: updatedRow.id,
    districtId,
    districtName,
    region: dist.region,
    status: updatedRow.status,
    statusStartedAt: updatedRow.statusStartedAt,
    scheduledTransitionAt: updatedRow.scheduledTransitionAt,
    scheduledTransitionType: updatedRow.scheduledTransitionType,
    externalPaymentReference: updatedRow.externalPaymentReference,
    internalNote: updatedRow.internalNote,
    updatedById: updatedRow.updatedById,
    createdAt: updatedRow.createdAt,
    updatedAt: updatedRow.updatedAt,
  });
}

export async function expireDistrictGrace(
  db: DbClient,
  districtId: string,
): Promise<DistrictSubscription | null> {
  const [dist] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!dist) {
    return null;
  }

  const now = new Date();
  let updatedRow: typeof districtSubscriptions.$inferSelect | undefined;
  let districtName = dist.name;

  await db.transaction(async (tx) => {
    // 1. Lock districts row first
    const lockDistrictResult = await tx.execute<{
      id: string;
      name: string;
      status: string;
      region: string | null;
    }>(sql`SELECT id, name, status, region FROM districts WHERE id = ${districtId} FOR UPDATE`);

    const lockedDistrict = lockDistrictResult.rows[0];
    if (!lockedDistrict) {
      return;
    }
    districtName = lockedDistrict.name;

    // 2. Lock district_subscriptions row second
    const lockSubResult = await tx.execute<{
      id: string;
      district_id: string;
      status: string;
      scheduled_transition_at: Date | null;
    }>(sql`SELECT id, district_id, status, scheduled_transition_at FROM district_subscriptions WHERE district_id = ${districtId} FOR UPDATE`);

    const lockedSub = lockSubResult.rows[0];
    if (!lockedSub || lockedSub.status !== 'GRACE') {
      // Idempotent: district is no longer in GRACE
      return;
    }

    if (
      lockedSub.scheduled_transition_at &&
      new Date(lockedSub.scheduled_transition_at) > now
    ) {
      // Grace period has not elapsed yet
      return;
    }

    // 3. Update district_subscriptions atomically
    const [updatedSub] = await tx
      .update(districtSubscriptions)
      .set({
        status: 'SUSPENDED',
        statusStartedAt: now,
        scheduledTransitionAt: null,
        scheduledTransitionType: null,
        updatedAt: now,
        updatedById: null, // SYSTEM actor
      })
      .where(
        and(
          eq(districtSubscriptions.districtId, districtId),
          eq(districtSubscriptions.status, 'GRACE'),
        ),
      )
      .returning();

    if (!updatedSub) {
      return;
    }

    // 4. Synchronize districts table status atomically
    await tx
      .update(districts)
      .set({
        status: 'SUSPENDED',
        updatedAt: now,
      })
      .where(eq(districts.id, districtId));

    updatedRow = updatedSub;

    // 5. Append-only audit logging with SYSTEM actor
    await recordAuditEvent(tx, {
      districtId,
      actorId: null,
      actorRole: 'SYSTEM',
      action: 'DISTRICT_SUBSCRIPTION_SUSPENDED',
      ipAddress: null,
      userAgent: null,
      metadata: {
        districtId,
        districtName: lockedDistrict.name,
        previousValues: { status: 'GRACE' },
        newValues: { status: 'SUSPENDED' },
        reason: '7 кунлик имтиёзли давр (Grace) тугаши муносабати билан автоматик тўхтатилди.',
        transitionTrigger: 'AUTOMATIC_GRACE_EXPIRY',
      },
    });
  });

  if (!updatedRow) {
    return null;
  }

  return formatDistrictSubscription({
    id: updatedRow.id,
    districtId,
    districtName,
    region: dist.region,
    status: updatedRow.status,
    statusStartedAt: updatedRow.statusStartedAt,
    scheduledTransitionAt: updatedRow.scheduledTransitionAt,
    scheduledTransitionType: updatedRow.scheduledTransitionType,
    externalPaymentReference: updatedRow.externalPaymentReference,
    internalNote: updatedRow.internalNote,
    updatedById: updatedRow.updatedById,
    createdAt: updatedRow.createdAt,
    updatedAt: updatedRow.updatedAt,
  });
}

export async function restoreDistrictActive(
  db: DbClient,
  districtId: string,
  payload: RestoreActiveRequest,
  actor?: { id: string; role: string },
  context?: { ipAddress?: string | null; userAgent?: string | null },
): Promise<DistrictSubscription> {
  const [dist] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!dist) {
    throw new DistrictNotFoundError(districtId);
  }

  // Ensure record exists before restore
  await ensureDistrictSubscription(db, districtId, dist.status);

  const now = new Date();
  let updatedRow: typeof districtSubscriptions.$inferSelect | undefined;
  let districtName = dist.name;

  await db.transaction(async (tx) => {
    // 1. Lock districts row first
    const lockDistrictResult = await tx.execute<{
      id: string;
      name: string;
      status: string;
      region: string | null;
    }>(sql`SELECT id, name, status, region FROM districts WHERE id = ${districtId} FOR UPDATE`);

    const lockedDistrict = lockDistrictResult.rows[0];
    if (!lockedDistrict) {
      throw new DistrictNotFoundError(districtId);
    }
    districtName = lockedDistrict.name;

    // 2. Lock district_subscriptions row second
    const lockSubResult = await tx.execute<{
      id: string;
      district_id: string;
      status: string;
    }>(sql`SELECT id, district_id, status FROM district_subscriptions WHERE district_id = ${districtId} FOR UPDATE`);

    const lockedSub = lockSubResult.rows[0];
    if (!lockedSub) {
      throw new DistrictNotFoundError(districtId);
    }

    if (
      (lockedSub.status !== 'GRACE' && lockedSub.status !== 'SUSPENDED') ||
      (lockedDistrict.status !== 'GRACE' && lockedDistrict.status !== 'SUSPENDED')
    ) {
      throw new InvalidSubscriptionTransitionError(lockedSub.status, 'ACTIVE');
    }

    // 3. If restoring from SUSPENDED, authoritatively re-verify all 8 prerequisites under lock
    if (lockedSub.status === 'SUSPENDED') {
      const readiness = await getOnboardingReadiness(tx, districtId);
      if (!readiness.isActivationReady) {
        const failedPrerequisites = readiness.items.filter((item) => item.status !== 'passed');
        throw new DistrictNotReadyForActivationError(failedPrerequisites);
      }
    }

    // 4. Update district_subscriptions atomically
    const [updatedSub] = await tx
      .update(districtSubscriptions)
      .set({
        status: 'ACTIVE',
        statusStartedAt: now,
        scheduledTransitionAt: null,
        scheduledTransitionType: null,
        updatedAt: now,
        updatedById: actor?.id ?? null,
      })
      .where(
        and(
          eq(districtSubscriptions.districtId, districtId),
          sql`${districtSubscriptions.status} IN ('GRACE', 'SUSPENDED')`,
        ),
      )
      .returning();

    if (!updatedSub) {
      throw new SubscriptionConcurrencyConflictError(districtId);
    }

    // 5. Synchronize districts table status atomically
    await tx
      .update(districts)
      .set({
        status: 'ACTIVE',
        updatedAt: now,
      })
      .where(eq(districts.id, districtId));

    updatedRow = updatedSub;

    // 6. Append-only audit logging
    await recordAuditEvent(tx, {
      districtId,
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'PRODUCT_OWNER',
      action: 'DISTRICT_SERVICE_RESTORED_ACTIVE',
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      metadata: {
        districtId,
        districtName: lockedDistrict.name,
        previousStatus: lockedSub.status,
        previousValues: { status: lockedSub.status },
        newValues: { status: 'ACTIVE' },
        reason: payload.reason ?? null,
      },
    });
  });

  if (!updatedRow) {
    throw new DistrictNotFoundError(districtId);
  }

  return formatDistrictSubscription({
    id: updatedRow.id,
    districtId,
    districtName,
    region: dist.region,
    status: updatedRow.status,
    statusStartedAt: updatedRow.statusStartedAt,
    scheduledTransitionAt: updatedRow.scheduledTransitionAt,
    scheduledTransitionType: updatedRow.scheduledTransitionType,
    externalPaymentReference: updatedRow.externalPaymentReference,
    internalNote: updatedRow.internalNote,
    updatedById: updatedRow.updatedById,
    createdAt: updatedRow.createdAt,
    updatedAt: updatedRow.updatedAt,
  });
}

export async function processOverdueGraceSubscriptions(db: DbClient): Promise<number> {
  const overdue = await db
    .select({ districtId: districtSubscriptions.districtId })
    .from(districtSubscriptions)
    .where(
      and(
        eq(districtSubscriptions.status, 'GRACE'),
        sql`${districtSubscriptions.scheduledTransitionAt} <= NOW()`,
      ),
    )
    .limit(100);

  let processedCount = 0;
  for (const item of overdue) {
    try {
      const result = await expireDistrictGrace(db, item.districtId);
      if (result) {
        processedCount++;
      }
    } catch (err) {
      logger.error(
        {
          event: 'OVERDUE_GRACE_EXPIRY_SWEEP_FAILED',
          districtId: item.districtId,
          err: (err as Error).message,
        },
        'Overdue grace expiry sweep failed',
      );
    }
  }

  return processedCount;
}

export async function cancelDistrict(
  db: DbClient,
  boss: PgBoss | undefined,
  districtId: string,
  payload: CancelDistrictRequest,
  actor?: { id: string; role: string },
  context?: { ipAddress?: string | null; userAgent?: string | null },
): Promise<DistrictSubscription> {
  const [dist] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!dist) {
    throw new DistrictNotFoundError(districtId);
  }

  // Ensure record exists before cancel
  await ensureDistrictSubscription(db, districtId, dist.status);

  let updatedRow: typeof districtSubscriptions.$inferSelect | undefined;
  let districtName = dist.name;

  await db.transaction(async (tx) => {
    const now = new Date();
    const scheduledTransitionAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days in ms

    // 1. Lock districts row first (consistent lock order: districts -> district_subscriptions)
    const lockDistrictResult = await tx.execute<{
      id: string;
      name: string;
      status: string;
      region: string | null;
    }>(sql`SELECT id, name, status, region FROM districts WHERE id = ${districtId} FOR UPDATE`);

    const lockedDistrict = lockDistrictResult.rows[0];
    if (!lockedDistrict) {
      throw new DistrictNotFoundError(districtId);
    }
    districtName = lockedDistrict.name;

    // 2. Lock district_subscriptions row second
    const lockSubResult = await tx.execute<{
      id: string;
      district_id: string;
      status: string;
      internal_note: string | null;
    }>(sql`SELECT id, district_id, status, internal_note FROM district_subscriptions WHERE district_id = ${districtId} FOR UPDATE`);

    const lockedSub = lockSubResult.rows[0];
    if (!lockedSub) {
      throw new DistrictNotFoundError(districtId);
    }

    // 3. Verify current status is ACTIVE, GRACE, or SUSPENDED
    const eligibleStatuses = ['ACTIVE', 'GRACE', 'SUSPENDED'];
    if (
      !eligibleStatuses.includes(lockedSub.status) ||
      !eligibleStatuses.includes(lockedDistrict.status)
    ) {
      throw new InvalidSubscriptionTransitionError(lockedSub.status, 'CANCELLED');
    }

    // 4. Verify typed district name match (case-sensitive trimmed, NFC normalized)
    if (
      payload.confirmationDistrictName.trim().normalize('NFC') !==
      lockedDistrict.name.trim().normalize('NFC')
    ) {
      throw new DistrictConfirmationMismatchError(lockedDistrict.name, payload.confirmationDistrictName);
    }

    // 5. Delete active bot token credentials from district_telegram_bots
    await tx
      .delete(districtTelegramBots)
      .where(eq(districtTelegramBots.districtId, districtId));

    // 6. Transition associated telegram group mappings to PENDING and clear validation state
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

    // 7. Update district_subscriptions atomically
    const [updatedSub] = await tx
      .update(districtSubscriptions)
      .set({
        status: 'CANCELLED',
        statusStartedAt: now,
        scheduledTransitionAt,
        scheduledTransitionType: 'LIVE_DELETION',
        internalNote: payload.reason ?? lockedSub.internal_note,
        updatedAt: now,
        updatedById: actor?.id ?? null,
      })
      .where(
        and(
          eq(districtSubscriptions.districtId, districtId),
          sql`${districtSubscriptions.status} IN ('ACTIVE', 'GRACE', 'SUSPENDED')`,
        ),
      )
      .returning();

    if (!updatedSub) {
      throw new SubscriptionConcurrencyConflictError(districtId);
    }

    // 8. Synchronize districts table status atomically
    await tx
      .update(districts)
      .set({
        status: 'CANCELLED',
        updatedAt: now,
      })
      .where(eq(districts.id, districtId));

    updatedRow = updatedSub;

    // 9. Append-only audit logging
    await recordAuditEvent(tx, {
      districtId,
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'PRODUCT_OWNER',
      action: 'DISTRICT_CANCELLED',
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      metadata: {
        districtId,
        districtName: lockedDistrict.name,
        previousStatus: lockedSub.status,
        previousValues: { status: lockedSub.status },
        newValues: {
          status: 'CANCELLED',
          scheduledTransitionAt: scheduledTransitionAt.toISOString(),
          scheduledTransitionType: 'LIVE_DELETION',
        },
        scheduledTransitionAt: scheduledTransitionAt.toISOString(),
        scheduledTransitionType: 'LIVE_DELETION',
        botTokenRemoved: true,
        reason: payload.reason,
      },
    });
  });

  if (!updatedRow) {
    throw new DistrictNotFoundError(districtId);
  }

  // 10. Enqueue delayed live deletion job in pg-boss (30 days delay)
  if (boss) {
    try {
      await sendQueueJob(
        boss,
        DISTRICT_LIVE_DELETION_QUEUE,
        { districtId },
        {
          singletonKey: JobSingletonKeys.forLiveDeletion(districtId),
          startAfter: 30 * 24 * 60 * 60, // 30 days in seconds
        },
      );
    } catch (err) {
      logger.error(
        {
          event: 'CANCEL_DISTRICT_ENQUEUE_LIVE_DELETION_FAILED',
          districtId,
          err: (err as Error).message,
        },
        'Failed to enqueue live deletion job on district cancellation',
      );
    }
  }

  return formatDistrictSubscription({
    id: updatedRow.id,
    districtId,
    districtName,
    region: dist.region,
    status: updatedRow.status,
    statusStartedAt: updatedRow.statusStartedAt,
    scheduledTransitionAt: updatedRow.scheduledTransitionAt,
    scheduledTransitionType: updatedRow.scheduledTransitionType,
    externalPaymentReference: updatedRow.externalPaymentReference,
    internalNote: updatedRow.internalNote,
    updatedById: updatedRow.updatedById,
    createdAt: updatedRow.createdAt,
    updatedAt: updatedRow.updatedAt,
  });
}

export async function startDistrictRecovery(
  db: DbClient,
  districtId: string,
  payload: StartRecoveryRequest,
  actor?: { id: string; role: string },
  context?: { ipAddress?: string | null; userAgent?: string | null },
): Promise<DistrictSubscription> {
  const [dist] = await db
    .select()
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);

  if (!dist) {
    const [tombstone] = await db
      .select()
      .from(districtDeletionRecords)
      .where(eq(districtDeletionRecords.districtId, districtId))
      .limit(1);

    if (tombstone && tombstone.liveDeletionStatus === 'COMPLETED') {
      throw new DistrictAlreadyDeletedError(districtId);
    }
    throw new DistrictNotFoundError(districtId);
  }

  // Ensure record exists before recovery
  await ensureDistrictSubscription(db, districtId, dist.status);

  let updatedRow: typeof districtSubscriptions.$inferSelect | undefined;
  let districtName = dist.name;

  await db.transaction(async (tx) => {
    const now = new Date();

    // 1. Lock districts row first (consistent lock order: districts -> district_subscriptions)
    const lockDistrictResult = await tx.execute<{
      id: string;
      name: string;
      status: string;
      region: string | null;
    }>(sql`SELECT id, name, status, region FROM districts WHERE id = ${districtId} FOR UPDATE`);

    const lockedDistrict = lockDistrictResult.rows[0];
    if (!lockedDistrict) {
      const [tombstone] = await tx
        .select()
        .from(districtDeletionRecords)
        .where(eq(districtDeletionRecords.districtId, districtId))
        .limit(1);

      if (tombstone && tombstone.liveDeletionStatus === 'COMPLETED') {
        throw new DistrictAlreadyDeletedError(districtId);
      }
      throw new DistrictNotFoundError(districtId);
    }
    districtName = lockedDistrict.name;

    // 2. Lock district_subscriptions row second
    const lockSubResult = await tx.execute<{
      id: string;
      district_id: string;
      status: string;
      scheduled_transition_at: Date | null;
    }>(sql`SELECT id, district_id, status, scheduled_transition_at FROM district_subscriptions WHERE district_id = ${districtId} FOR UPDATE`);

    const lockedSub = lockSubResult.rows[0];
    if (!lockedSub) {
      throw new DistrictNotFoundError(districtId);
    }

    // 3. Verify current status is CANCELLED
    if (lockedSub.status !== 'CANCELLED' || lockedDistrict.status !== 'CANCELLED') {
      throw new InvalidSubscriptionTransitionError(lockedSub.status, 'SETUP_INCOMPLETE');
    }

    // 4. Verify recovery window has not expired
    const deadlineMs = lockedSub.scheduled_transition_at
      ? new Date(lockedSub.scheduled_transition_at).getTime()
      : NaN;
    if (Number.isNaN(deadlineMs) || deadlineMs <= now.getTime()) {
      throw new RecoveryWindowExpiredError(districtId);
    }

    // 5. Update district_subscriptions atomically
    const [updatedSub] = await tx
      .update(districtSubscriptions)
      .set({
        status: 'SETUP_INCOMPLETE',
        statusStartedAt: now,
        scheduledTransitionAt: null,
        scheduledTransitionType: null,
        updatedAt: now,
        updatedById: actor?.id ?? null,
      })
      .where(
        and(
          eq(districtSubscriptions.districtId, districtId),
          eq(districtSubscriptions.status, 'CANCELLED'),
        ),
      )
      .returning();

    if (!updatedSub) {
      throw new SubscriptionConcurrencyConflictError(districtId);
    }

    // 6. Synchronize districts table status atomically
    await tx
      .update(districts)
      .set({
        status: 'SETUP_INCOMPLETE',
        updatedAt: now,
      })
      .where(eq(districts.id, districtId));

    updatedRow = updatedSub;

    // 7. Append-only audit logging
    await recordAuditEvent(tx, {
      districtId,
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'PRODUCT_OWNER',
      action: 'DISTRICT_RECOVERY_STARTED',
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      metadata: {
        districtId,
        districtName: lockedDistrict.name,
        previousStatus: 'CANCELLED',
        previousValues: { status: 'CANCELLED' },
        newValues: { status: 'SETUP_INCOMPLETE' },
        reason: payload.reason ?? null,
      },
    });
  });

  if (!updatedRow) {
    throw new DistrictNotFoundError(districtId);
  }

  return formatDistrictSubscription({
    id: updatedRow.id,
    districtId,
    districtName,
    region: dist.region,
    status: updatedRow.status,
    statusStartedAt: updatedRow.statusStartedAt,
    scheduledTransitionAt: updatedRow.scheduledTransitionAt,
    scheduledTransitionType: updatedRow.scheduledTransitionType,
    externalPaymentReference: updatedRow.externalPaymentReference,
    internalNote: updatedRow.internalNote,
    updatedById: updatedRow.updatedById,
    createdAt: updatedRow.createdAt,
    updatedAt: updatedRow.updatedAt,
  });
}


