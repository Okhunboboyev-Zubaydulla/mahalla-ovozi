CREATE TABLE IF NOT EXISTS "district_deletion_records" (
	"id" text PRIMARY KEY NOT NULL,
	"district_id" text NOT NULL,
	"district_name" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_id" text,
	"cancellation_reason" text,
	"scheduled_live_deletion_at" timestamp with time zone NOT NULL,
	"actual_live_deletion_at" timestamp with time zone DEFAULT now() NOT NULL,
	"live_deletion_status" text DEFAULT 'COMPLETED' NOT NULL,
	"protected_backup_expiry_deadline" timestamp with time zone NOT NULL,
	"backup_expiry_status" text DEFAULT 'PENDING' NOT NULL,
	"backup_expiry_verified_at" timestamp with time zone,
	"restore_reconciliation_status" text,
	"restore_reconciliation_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_deletion_records_live_deletion_status_check" CHECK ("live_deletion_status" IN ('COMPLETED', 'FAILED')),
	CONSTRAINT "district_deletion_records_backup_expiry_status_check" CHECK ("backup_expiry_status" IN ('PENDING', 'VERIFIED', 'FAILED')),
	CONSTRAINT "district_deletion_records_restore_reconciliation_status_check" CHECK ("restore_reconciliation_status" IS NULL OR "restore_reconciliation_status" IN ('PENDING', 'RECONCILED', 'FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "district_deletion_records_district_id_uidx" ON "district_deletion_records" USING btree ("district_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "district_deletion_records_live_deletion_status_idx" ON "district_deletion_records" USING btree ("live_deletion_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "district_deletion_records_backup_expiry_status_idx" ON "district_deletion_records" USING btree ("backup_expiry_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "district_deletion_records_restore_reconciliation_status_idx" ON "district_deletion_records" USING btree ("restore_reconciliation_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "district_deletion_records_backup_expiry_deadline_idx" ON "district_deletion_records" USING btree ("protected_backup_expiry_deadline");