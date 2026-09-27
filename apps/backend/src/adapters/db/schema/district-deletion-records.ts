import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';

export const districtDeletionRecords = pgTable(
  'district_deletion_records',
  {
    id: text('id').primaryKey(),
    districtId: text('district_id').notNull(),
    districtName: text('district_name').notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledById: text('cancelled_by_id'),
    cancellationReason: text('cancellation_reason'),
    scheduledLiveDeletionAt: timestamp('scheduled_live_deletion_at', { withTimezone: true }).notNull(),
    actualLiveDeletionAt: timestamp('actual_live_deletion_at', { withTimezone: true }).notNull().defaultNow(),
    liveDeletionStatus: text('live_deletion_status').notNull().default('COMPLETED'),
    protectedBackupExpiryDeadline: timestamp('protected_backup_expiry_deadline', { withTimezone: true }).notNull(),
    backupExpiryStatus: text('backup_expiry_status').notNull().default('PENDING'),
    backupExpiryVerifiedAt: timestamp('backup_expiry_verified_at', { withTimezone: true }),
    restoreReconciliationStatus: text('restore_reconciliation_status'),
    restoreReconciliationVerifiedAt: timestamp('restore_reconciliation_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('district_deletion_records_district_id_uidx').on(table.districtId),
    check(
      'district_deletion_records_live_deletion_status_check',
      sql`${table.liveDeletionStatus} IN ('COMPLETED', 'FAILED')`,
    ),
    check(
      'district_deletion_records_backup_expiry_status_check',
      sql`${table.backupExpiryStatus} IN ('PENDING', 'VERIFIED', 'FAILED')`,
    ),
    check(
      'district_deletion_records_restore_reconciliation_status_check',
      sql`${table.restoreReconciliationStatus} IS NULL OR ${table.restoreReconciliationStatus} IN ('PENDING', 'RECONCILED', 'FAILED')`,
    ),
    index('district_deletion_records_live_deletion_status_idx').on(table.liveDeletionStatus),
    index('district_deletion_records_backup_expiry_status_idx').on(table.backupExpiryStatus),
    index('district_deletion_records_restore_reconciliation_status_idx').on(table.restoreReconciliationStatus),
    index('district_deletion_records_backup_expiry_deadline_idx').on(table.protectedBackupExpiryDeadline),
  ],
);

export type DistrictDeletionRecordEntity = typeof districtDeletionRecords.$inferSelect;
export type NewDistrictDeletionRecordEntity = typeof districtDeletionRecords.$inferInsert;
