import {
  AuditEvent,
  PermanentDeletionProof,
  AuditHistoryItem,
  AuditHistoryQuery,
  KeysetPage,
  AuditKeysetCursorPayload,
  ALLOWED_METADATA_SEARCH_KEYS,
  decodeKeysetCursor,
  encodeKeysetCursor,
  AuditActorRole,
} from '@mahalla-ovozi/api-contracts';
import { and, or, eq, ne, isNull, isNotNull, gte, lte, ilike, desc, asc, sql, SQL } from 'drizzle-orm';
import { DbClient } from '../../adapters/db/client.js';
import {
  auditEvents,
  districts,
  districtDeletionRecords,
  DistrictDeletionRecordEntity,
} from '../../adapters/db/schema/index.js';
import { getTashkentDayBounds } from '../telegram-intake/timezone-util.js';
import {
  classifyAuditActionCategory,
  determineAuditActionOutcome,
  sanitizeMetadata,
} from './audit-service.js';

export class InvalidCursorError extends Error {
  statusCode = 400;
  code = 'INVALID_CURSOR';
  constructor(message = 'Яроқсиз саҳифалаш курсори.') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/**
 * Safely escapes PostgreSQL ILIKE wildcard characters (%, _, \).
 */
export function escapeIlikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toObjectRecord(val: unknown): Record<string, unknown> | null {
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

export function formatDeletionProofRow(
  row: Pick<
    DistrictDeletionRecordEntity,
    | 'id'
    | 'districtId'
    | 'districtName'
    | 'cancelledAt'
    | 'cancelledById'
    | 'cancellationReason'
    | 'scheduledLiveDeletionAt'
    | 'actualLiveDeletionAt'
    | 'liveDeletionStatus'
    | 'protectedBackupExpiryDeadline'
    | 'backupExpiryStatus'
    | 'backupExpiryVerifiedAt'
    | 'restoreReconciliationStatus'
    | 'restoreReconciliationVerifiedAt'
    | 'createdAt'
  >,
): PermanentDeletionProof {
  const liveDeletionStatus = row.liveDeletionStatus as 'COMPLETED' | 'FAILED';
  const backupExpiryStatus = row.backupExpiryStatus as
    | 'PENDING'
    | 'VERIFIED'
    | 'FAILED';
  const lifecycleComplete =
    liveDeletionStatus === 'COMPLETED' && backupExpiryStatus === 'VERIFIED';

  return {
    id: row.id,
    recordType: 'PERMANENT_DELETION_PROOF',
    districtId: row.districtId,
    districtName: row.districtName,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : undefined,
    cancelledById: row.cancelledById ?? undefined,
    cancellationReason: row.cancellationReason ?? undefined,
    scheduledLiveDeletionAt: row.scheduledLiveDeletionAt.toISOString(),
    actualLiveDeletionAt: row.actualLiveDeletionAt.toISOString(),
    liveDeletionStatus,
    protectedBackupExpiryDeadline:
      row.protectedBackupExpiryDeadline.toISOString(),
    backupExpiryStatus,
    backupExpiryVerifiedAt: row.backupExpiryVerifiedAt
      ? row.backupExpiryVerifiedAt.toISOString()
      : undefined,
    restoreReconciliationStatus:
      (row.restoreReconciliationStatus as
        | 'PENDING'
        | 'RECONCILED'
        | 'FAILED'
        | null) ?? undefined,
    restoreReconciliationVerifiedAt: row.restoreReconciliationVerifiedAt
      ? row.restoreReconciliationVerifiedAt.toISOString()
      : undefined,
    lifecycleComplete,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AuditQueryService {
  /**
   * Queries unified audit history (audit events and/or permanent deletion proofs)
   * with multi-parameter filtering, allowlisted ILIKE search,
   * Tashkent timezone calendar day conversion, and deterministic keyset pagination.
   */
  async queryAuditEvents(
    db: DbClient,
    params: AuditHistoryQuery,
  ): Promise<KeysetPage<AuditHistoryItem>> {
    const recordType = params.recordType || 'ALL';

    // 1. Parse keyset cursor
    let cursorDate: Date | null = null;
    let cursorId: string | null = null;

    if (params.cursor) {
      const decoded = decodeKeysetCursor<AuditKeysetCursorPayload>(
        params.cursor,
      );
      if (
        !decoded ||
        typeof decoded.id !== 'string' ||
        !decoded.createdAt ||
        Number.isNaN(new Date(decoded.createdAt).getTime())
      ) {
        throw new InvalidCursorError();
      }
      cursorDate = new Date(decoded.createdAt);
      cursorId = decoded.id;
    }

    if (recordType === 'PERMANENT_DELETION_PROOF') {
      return this.queryDeletionRecordsOnly(db, params, cursorDate, cursorId);
    }

    if (recordType === 'AUDIT_EVENT') {
      return this.queryAuditEventsOnly(db, params, cursorDate, cursorId);
    }

    return this.queryUnifiedHistory(db, params, cursorDate, cursorId);
  }

  /**
   * Queries only standard audit events.
   */
  private async queryAuditEventsOnly(
    db: DbClient,
    params: AuditHistoryQuery,
    cursorDate: Date | null,
    cursorId: string | null,
  ): Promise<KeysetPage<AuditHistoryItem>> {
    const direction = params.direction || 'forward';
    const conditions = this.buildAuditEventConditions(
      params,
      cursorDate,
      cursorId,
      direction,
    );
    const limit = params.limit || 50;
    const filterWhere = conditions.length > 0 ? and(...conditions) : undefined;

    const queryBuilder = db
      .select({
        id: auditEvents.id,
        districtId: auditEvents.districtId,
        districtName: districts.name,
        actorId: auditEvents.actorId,
        actorRole: auditEvents.actorRole,
        action: auditEvents.action,
        ipAddress: auditEvents.ipAddress,
        userAgent: auditEvents.userAgent,
        metadata: auditEvents.metadata,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .leftJoin(districts, eq(auditEvents.districtId, districts.id))
      .where(filterWhere);

    if (direction === 'backward') {
      queryBuilder.orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
    } else {
      queryBuilder.orderBy(desc(auditEvents.createdAt), desc(auditEvents.id));
    }

    queryBuilder.limit(limit + 1);
    const rows = await queryBuilder;

    return this.paginateResults(
      rows.map((row) => this.formatAuditEventRow(row)),
      limit,
      direction,
      Boolean(params.cursor),
    );
  }

  /**
   * Queries only permanent deletion proofs.
   */
  private async queryDeletionRecordsOnly(
    db: DbClient,
    params: AuditHistoryQuery,
    cursorDate: Date | null,
    cursorId: string | null,
  ): Promise<KeysetPage<AuditHistoryItem>> {
    const direction = params.direction || 'forward';
    const conditions = this.buildDeletionRecordConditions(
      params,
      cursorDate,
      cursorId,
      direction,
    );
    const limit = params.limit || 50;
    const filterWhere = conditions.length > 0 ? and(...conditions) : undefined;

    const queryBuilder = db
      .select({
        id: districtDeletionRecords.id,
        districtId: districtDeletionRecords.districtId,
        districtName: districtDeletionRecords.districtName,
        cancelledAt: districtDeletionRecords.cancelledAt,
        cancelledById: districtDeletionRecords.cancelledById,
        cancellationReason: districtDeletionRecords.cancellationReason,
        scheduledLiveDeletionAt:
          districtDeletionRecords.scheduledLiveDeletionAt,
        actualLiveDeletionAt: districtDeletionRecords.actualLiveDeletionAt,
        liveDeletionStatus: districtDeletionRecords.liveDeletionStatus,
        protectedBackupExpiryDeadline:
          districtDeletionRecords.protectedBackupExpiryDeadline,
        backupExpiryStatus: districtDeletionRecords.backupExpiryStatus,
        backupExpiryVerifiedAt:
          districtDeletionRecords.backupExpiryVerifiedAt,
        restoreReconciliationStatus:
          districtDeletionRecords.restoreReconciliationStatus,
        restoreReconciliationVerifiedAt:
          districtDeletionRecords.restoreReconciliationVerifiedAt,
        createdAt: districtDeletionRecords.createdAt,
      })
      .from(districtDeletionRecords)
      .where(filterWhere);

    if (direction === 'backward') {
      queryBuilder.orderBy(
        asc(districtDeletionRecords.createdAt),
        asc(districtDeletionRecords.id),
      );
    } else {
      queryBuilder.orderBy(
        desc(districtDeletionRecords.createdAt),
        desc(districtDeletionRecords.id),
      );
    }

    queryBuilder.limit(limit + 1);
    const rows = await queryBuilder;

    return this.paginateResults(
      rows.map((row) => formatDeletionProofRow(row)),
      limit,
      direction,
      Boolean(params.cursor),
    );
  }

  /**
   * Queries unified history interleaving audit events and deletion records via SQL UNION ALL.
   */
  private async queryUnifiedHistory(
    db: DbClient,
    params: AuditHistoryQuery,
    cursorDate: Date | null,
    cursorId: string | null,
  ): Promise<KeysetPage<AuditHistoryItem>> {
    const direction = params.direction || 'forward';
    const limit = params.limit || 50;

    const auditConditions = this.buildAuditEventConditions(
      params,
      cursorDate,
      cursorId,
      direction,
    );
    const delConditions = this.buildDeletionRecordConditions(
      params,
      cursorDate,
      cursorId,
      direction,
    );

    const auditWhereSql =
      auditConditions.length > 0
        ? sql`WHERE ${and(...auditConditions)}`
        : sql``;
    const delWhereSql =
      delConditions.length > 0
        ? sql`WHERE ${and(...delConditions)}`
        : sql``;

    const cursorSql = cursorDate && cursorId
      ? direction === 'forward'
        ? sql`WHERE (created_at, id) < (${cursorDate}, ${cursorId})`
        : sql`WHERE (created_at, id) > (${cursorDate}, ${cursorId})`
      : sql``;

    const orderSql =
      direction === 'backward'
        ? sql`ORDER BY created_at ASC, id ASC`
        : sql`ORDER BY created_at DESC, id DESC`;

    const unifiedSql = sql`
      SELECT * FROM (
        SELECT
          ${auditEvents.id} AS id,
          'AUDIT_EVENT' AS record_type,
          ${auditEvents.districtId} AS district_id,
          ${districts.name} AS district_name,
          ${auditEvents.actorId} AS actor_id,
          ${auditEvents.actorRole} AS actor_role,
          ${auditEvents.action} AS action,
          ${auditEvents.ipAddress} AS ip_address,
          ${auditEvents.userAgent} AS user_agent,
          ${auditEvents.metadata} AS metadata,
          NULL::timestamptz AS cancelled_at,
          NULL::text AS cancelled_by_id,
          NULL::text AS cancellation_reason,
          NULL::timestamptz AS scheduled_live_deletion_at,
          NULL::timestamptz AS actual_live_deletion_at,
          NULL::text AS live_deletion_status,
          NULL::timestamptz AS protected_backup_expiry_deadline,
          NULL::text AS backup_expiry_status,
          NULL::timestamptz AS backup_expiry_verified_at,
          NULL::text AS restore_reconciliation_status,
          NULL::timestamptz AS restore_reconciliation_verified_at,
          ${auditEvents.createdAt} AS created_at
        FROM ${auditEvents}
        LEFT JOIN ${districts} ON ${auditEvents.districtId} = ${districts.id}
        ${auditWhereSql}

        UNION ALL

        SELECT
          ${districtDeletionRecords.id} AS id,
          'PERMANENT_DELETION_PROOF' AS record_type,
          ${districtDeletionRecords.districtId} AS district_id,
          ${districtDeletionRecords.districtName} AS district_name,
          ${districtDeletionRecords.cancelledById} AS actor_id,
          CASE WHEN ${districtDeletionRecords.cancelledById} IS NOT NULL THEN 'PRODUCT_OWNER' ELSE 'SYSTEM' END AS actor_role,
          'DISTRICT_PERMANENT_DELETION_PROOF' AS action,
          NULL::text AS ip_address,
          NULL::text AS user_agent,
          NULL::jsonb AS metadata,
          ${districtDeletionRecords.cancelledAt} AS cancelled_at,
          ${districtDeletionRecords.cancelledById} AS cancelled_by_id,
          ${districtDeletionRecords.cancellationReason} AS cancellation_reason,
          ${districtDeletionRecords.scheduledLiveDeletionAt} AS scheduled_live_deletion_at,
          ${districtDeletionRecords.actualLiveDeletionAt} AS actual_live_deletion_at,
          ${districtDeletionRecords.liveDeletionStatus} AS live_deletion_status,
          ${districtDeletionRecords.protectedBackupExpiryDeadline} AS protected_backup_expiry_deadline,
          ${districtDeletionRecords.backupExpiryStatus} AS backup_expiry_status,
          ${districtDeletionRecords.backupExpiryVerifiedAt} AS backup_expiry_verified_at,
          ${districtDeletionRecords.restoreReconciliationStatus} AS restore_reconciliation_status,
          ${districtDeletionRecords.restoreReconciliationVerifiedAt} AS restore_reconciliation_verified_at,
          ${districtDeletionRecords.createdAt} AS created_at
        FROM ${districtDeletionRecords}
        ${delWhereSql}
      ) AS unified_records
      ${cursorSql}
      ${orderSql}
      LIMIT ${limit + 1}
    `;

    const result = await db.execute<{
      id: string;
      record_type: 'AUDIT_EVENT' | 'PERMANENT_DELETION_PROOF';
      district_id: string | null;
      district_name: string | null;
      actor_id: string | null;
      actor_role: string | null;
      action: string;
      ip_address: string | null;
      user_agent: string | null;
      metadata: Record<string, unknown> | null;
      cancelled_at: Date | string | null;
      cancelled_by_id: string | null;
      cancellation_reason: string | null;
      scheduled_live_deletion_at: Date | string | null;
      actual_live_deletion_at: Date | string | null;
      live_deletion_status: string | null;
      protected_backup_expiry_deadline: Date | string | null;
      backup_expiry_status: string | null;
      backup_expiry_verified_at: Date | string | null;
      restore_reconciliation_status: string | null;
      restore_reconciliation_verified_at: Date | string | null;
      created_at: Date | string;
    }>(unifiedSql);

    const items: AuditHistoryItem[] = result.rows.map((row) => {
      const createdAtDate =
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at);

      if (row.record_type === 'PERMANENT_DELETION_PROOF') {
        return formatDeletionProofRow({
          id: row.id,
          districtId: row.district_id || '',
          districtName: row.district_name || '',
          cancelledAt: row.cancelled_at ? new Date(row.cancelled_at) : null,
          cancelledById: row.cancelled_by_id,
          cancellationReason: row.cancellation_reason,
          scheduledLiveDeletionAt: new Date(row.scheduled_live_deletion_at!),
          actualLiveDeletionAt: new Date(row.actual_live_deletion_at!),
          liveDeletionStatus: row.live_deletion_status || 'COMPLETED',
          protectedBackupExpiryDeadline: new Date(
            row.protected_backup_expiry_deadline!,
          ),
          backupExpiryStatus: row.backup_expiry_status || 'PENDING',
          backupExpiryVerifiedAt: row.backup_expiry_verified_at
            ? new Date(row.backup_expiry_verified_at)
            : null,
          restoreReconciliationStatus: row.restore_reconciliation_status,
          restoreReconciliationVerifiedAt: row.restore_reconciliation_verified_at
            ? new Date(row.restore_reconciliation_verified_at)
            : null,
          createdAt: createdAtDate,
        });
      }

      return this.formatAuditEventRow({
        id: row.id,
        districtId: row.district_id,
        districtName: row.district_name,
        actorId: row.actor_id,
        actorRole: row.actor_role,
        action: row.action,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        metadata: row.metadata,
        createdAt: createdAtDate,
      });
    });

    return this.paginateResults(
      items,
      limit,
      direction,
      Boolean(params.cursor),
    );
  }

  private buildAuditEventConditions(
    params: AuditHistoryQuery,
    cursorDate: Date | null,
    cursorId: string | null,
    direction: 'forward' | 'backward',
  ): SQL[] {
    const conditions: (SQL | undefined)[] = [];

    if (cursorDate && cursorId) {
      if (direction === 'forward') {
        conditions.push(
          sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${cursorDate}, ${cursorId})`,
        );
      } else {
        conditions.push(
          sql`(${auditEvents.createdAt}, ${auditEvents.id}) > (${cursorDate}, ${cursorId})`,
        );
      }
    }

    if (params.districtId) {
      if (params.districtId.toLowerCase() === 'global') {
        conditions.push(isNull(auditEvents.districtId));
      } else {
        conditions.push(eq(auditEvents.districtId, params.districtId));
      }
    }

    if (params.startDate) {
      const { startUtc } = getTashkentDayBounds(params.startDate);
      conditions.push(gte(auditEvents.createdAt, startUtc));
    }

    if (params.endDate) {
      const { endUtc } = getTashkentDayBounds(params.endDate);
      conditions.push(lte(auditEvents.createdAt, endUtc));
    }

    if (params.category) {
      switch (params.category) {
        case 'AUTH_SECURITY':
          conditions.push(
            sql`(${auditEvents.action} LIKE 'AUTH_%' OR ${auditEvents.action} IN ('ACCOUNT_PO_CREATED', 'ACCOUNT_PO_PASSWORD_RESET', 'ACCOUNT_HOKIM_FIRST_LOGIN_PASSWORD_CHANGED'))`,
          );
          break;
        case 'DISTRICT_ADMINISTRATION':
          conditions.push(
            sql`(${auditEvents.action} LIKE 'DISTRICT_%' AND ${auditEvents.action} NOT LIKE 'DISTRICT_TELEGRAM_BOT_%' AND ${auditEvents.action} NOT LIKE 'DISTRICT_GROUP_%')`,
          );
          break;
        case 'HOKIM_MANAGEMENT':
          conditions.push(
            sql`(${auditEvents.action} LIKE 'ACCOUNT_HOKIM_%' AND ${auditEvents.action} != 'ACCOUNT_HOKIM_FIRST_LOGIN_PASSWORD_CHANGED')`,
          );
          break;
        case 'TELEGRAM_INTEGRATION':
          conditions.push(
            sql`(${auditEvents.action} LIKE 'DISTRICT_TELEGRAM_BOT_%' OR ${auditEvents.action} LIKE 'DISTRICT_GROUP_%')`,
          );
          break;
        case 'OPERATIONAL_LIFECYCLE':
          conditions.push(
            sql`(${auditEvents.action} LIKE 'OPERATIONAL_%' OR (${auditEvents.action} NOT LIKE 'AUTH_%' AND ${auditEvents.action} NOT LIKE 'ACCOUNT_%' AND ${auditEvents.action} NOT LIKE 'DISTRICT_%'))`,
          );
          break;
      }
    }

    if (params.actorRole) {
      conditions.push(eq(auditEvents.actorRole, params.actorRole));
    }

    if (params.action) {
      conditions.push(eq(auditEvents.action, params.action));
    }

    if (params.outcome) {
      const failureCondition = sql`(
        COALESCE(${auditEvents.metadata}->>'outcome', '') = 'FAILURE' OR
        COALESCE(${auditEvents.metadata}->>'status', '') = 'FAILED' OR
        COALESCE(${auditEvents.metadata}->>'success', '') = 'false' OR
        ${auditEvents.action} LIKE '%_FAILED' OR
        ${auditEvents.action} LIKE '%_FAILURE'
      )`;
      if (params.outcome === 'FAILURE') {
        conditions.push(failureCondition);
      } else if (params.outcome === 'SUCCESS') {
        conditions.push(sql`NOT (${failureCondition})`);
      }
    }

    if (params.search && params.search.trim().length > 0) {
      const escaped = escapeIlikePattern(params.search.trim());
      const pattern = `%${escaped}%`;

      const searchOrs: SQL[] = [
        ilike(auditEvents.id, pattern),
        ilike(auditEvents.action, pattern),
        sql`COALESCE(${auditEvents.actorId}, '') ILIKE ${pattern}`,
        sql`COALESCE(${auditEvents.districtId}, '') ILIKE ${pattern}`,
      ];

      for (const key of ALLOWED_METADATA_SEARCH_KEYS) {
        searchOrs.push(sql`${auditEvents.metadata}->>${key} ILIKE ${pattern}`);
      }

      conditions.push(or(...searchOrs));
    }

    return conditions.filter((c): c is SQL => c !== undefined);
  }

  private buildDeletionRecordConditions(
    params: AuditHistoryQuery,
    cursorDate: Date | null,
    cursorId: string | null,
    direction: 'forward' | 'backward',
  ): SQL[] {
    const conditions: (SQL | undefined)[] = [];

    if (cursorDate && cursorId) {
      if (direction === 'forward') {
        conditions.push(
          sql`(${districtDeletionRecords.createdAt}, ${districtDeletionRecords.id}) < (${cursorDate}, ${cursorId})`,
        );
      } else {
        conditions.push(
          sql`(${districtDeletionRecords.createdAt}, ${districtDeletionRecords.id}) > (${cursorDate}, ${cursorId})`,
        );
      }
    }

    if (params.districtId) {
      if (params.districtId.toLowerCase() === 'global') {
        conditions.push(sql`1 = 0`); // Deletion records are strictly district-scoped
      } else {
        conditions.push(
          eq(districtDeletionRecords.districtId, params.districtId),
        );
      }
    }

    if (params.startDate) {
      const { startUtc } = getTashkentDayBounds(params.startDate);
      conditions.push(gte(districtDeletionRecords.createdAt, startUtc));
    }

    if (params.endDate) {
      const { endUtc } = getTashkentDayBounds(params.endDate);
      conditions.push(lte(districtDeletionRecords.createdAt, endUtc));
    }

    if (params.category) {
      if (
        params.category === 'OPERATIONAL_LIFECYCLE' ||
        params.category === 'DISTRICT_ADMINISTRATION'
      ) {
        // deletion proof matches operational/district category
      } else {
        conditions.push(sql`1 = 0`);
      }
    }

    if (params.actorRole) {
      if (params.actorRole === 'PRODUCT_OWNER') {
        conditions.push(isNotNull(districtDeletionRecords.cancelledById));
      } else if (params.actorRole === 'SYSTEM') {
        conditions.push(isNull(districtDeletionRecords.cancelledById));
      } else {
        conditions.push(sql`1 = 0`);
      }
    }

    if (params.action) {
      if (
        params.action === 'DISTRICT_LIVE_DELETED' ||
        params.action === 'DISTRICT_PERMANENT_DELETION_PROOF'
      ) {
        // matches
      } else {
        conditions.push(sql`1 = 0`);
      }
    }

    if (params.outcome) {
      if (params.outcome === 'SUCCESS') {
        conditions.push(
          and(
            eq(districtDeletionRecords.liveDeletionStatus, 'COMPLETED'),
            ne(districtDeletionRecords.backupExpiryStatus, 'FAILED'),
            sql`COALESCE(${districtDeletionRecords.restoreReconciliationStatus}, '') != 'FAILED'`,
          ),
        );
      } else if (params.outcome === 'FAILURE') {
        conditions.push(
          or(
            eq(districtDeletionRecords.liveDeletionStatus, 'FAILED'),
            eq(districtDeletionRecords.backupExpiryStatus, 'FAILED'),
            eq(districtDeletionRecords.restoreReconciliationStatus, 'FAILED'),
          ),
        );
      }
    }

    if (params.search && params.search.trim().length > 0) {
      const escaped = escapeIlikePattern(params.search.trim());
      const pattern = `%${escaped}%`;

      conditions.push(
        or(
          ilike(districtDeletionRecords.id, pattern),
          ilike(districtDeletionRecords.districtName, pattern),
          ilike(districtDeletionRecords.districtId, pattern),
          sql`COALESCE(${districtDeletionRecords.cancellationReason}, '') ILIKE ${pattern}`,
          sql`COALESCE(${districtDeletionRecords.cancelledById}, '') ILIKE ${pattern}`,
        ),
      );
    }

    return conditions.filter((c): c is SQL => c !== undefined);
  }

  private formatAuditEventRow(row: {
    id: string;
    districtId: string | null;
    districtName: string | null;
    actorId: string | null;
    actorRole: string | null;
    action: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: unknown;
    createdAt: Date;
  }): AuditEvent {
    const rawMeta = row.metadata as Record<string, unknown> | null;
    const sanitizedMeta = sanitizeMetadata(rawMeta || undefined);

    const previousValues = toObjectRecord(
      rawMeta?.previousState ?? rawMeta?.previousValues,
    );
    const newValues = toObjectRecord(
      rawMeta?.newState ?? rawMeta?.newValues,
    );
    const reason =
      typeof rawMeta?.reason === 'string' ? rawMeta.reason : null;

    const actorRole: AuditActorRole | null =
      row.actorRole === 'PRODUCT_OWNER' ||
      row.actorRole === 'DISTRICT_HOKIM' ||
      row.actorRole === 'SYSTEM'
        ? row.actorRole
        : null;

    return {
      id: row.id,
      recordType: 'AUDIT_EVENT',
      districtId: row.districtId,
      districtName: row.districtName || null,
      actorId: row.actorId,
      actorRole,
      action: row.action,
      category: classifyAuditActionCategory(row.action),
      outcome: determineAuditActionOutcome(row.action, rawMeta || undefined),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      reason,
      previousValues: previousValues
        ? sanitizeMetadata(previousValues) || null
        : null,
      newValues: newValues ? sanitizeMetadata(newValues) || null : null,
      metadata: sanitizedMeta || null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private paginateResults(
    rows: AuditHistoryItem[],
    limit: number,
    direction: 'forward' | 'backward',
    hasCursor: boolean,
  ): KeysetPage<AuditHistoryItem> {
    const hasMore = rows.length > limit;
    let pageRows = hasMore ? rows.slice(0, limit) : rows;

    if (direction === 'backward') {
      pageRows = pageRows.reverse();
    }

    let hasNextPage = false;
    let hasPrevPage = false;

    if (direction === 'forward') {
      hasNextPage = hasMore;
      hasPrevPage = hasCursor;
    } else {
      hasPrevPage = hasMore;
      hasNextPage = pageRows.length > 0;
    }

    let nextCursor: string | null = null;
    let prevCursor: string | null = null;

    if (hasNextPage && pageRows.length > 0) {
      const lastItem = pageRows[pageRows.length - 1];
      if (lastItem) {
        nextCursor = encodeKeysetCursor<AuditKeysetCursorPayload>({
          id: lastItem.id,
          createdAt: lastItem.createdAt,
        });
      }
    }

    if (hasPrevPage && pageRows.length > 0) {
      const firstItem = pageRows[0];
      if (firstItem) {
        prevCursor = encodeKeysetCursor<AuditKeysetCursorPayload>({
          id: firstItem.id,
          createdAt: firstItem.createdAt,
        });
      }
    }

    return {
      items: pageRows,
      pagination: {
        limit,
        hasNextPage,
        hasPrevPage,
        nextCursor,
        prevCursor,
      },
    };
  }

  /**
   * Retrieves a single audit event or permanent deletion proof by ID.
   * Checks audit_events first; falls back to district_deletion_records by id or districtId.
   */
  async getAuditEventById(
    db: DbClient,
    id: string,
  ): Promise<AuditHistoryItem | null> {
    const rows = await db
      .select({
        id: auditEvents.id,
        districtId: auditEvents.districtId,
        districtName: districts.name,
        actorId: auditEvents.actorId,
        actorRole: auditEvents.actorRole,
        action: auditEvents.action,
        ipAddress: auditEvents.ipAddress,
        userAgent: auditEvents.userAgent,
        metadata: auditEvents.metadata,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .leftJoin(districts, eq(auditEvents.districtId, districts.id))
      .where(eq(auditEvents.id, id))
      .limit(1);

    const row = rows[0];
    if (row) {
      return this.formatAuditEventRow(row);
    }

    // Fall back to district_deletion_records (by id or districtId)
    const [delRecord] = await db
      .select()
      .from(districtDeletionRecords)
      .where(
        or(
          eq(districtDeletionRecords.id, id),
          eq(districtDeletionRecords.districtId, id),
        ),
      )
      .limit(1);

    if (delRecord) {
      return formatDeletionProofRow(delRecord);
    }

    return null;
  }
}

export const auditQueryService = new AuditQueryService();

