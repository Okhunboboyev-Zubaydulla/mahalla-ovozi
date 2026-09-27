ALTER TABLE "telegram_intake_records" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "telegram_intake_records" ADD CONSTRAINT "telegram_intakes_status_check" CHECK ("telegram_intake_records"."status" IN ('PENDING', 'PROCESSING', 'ACCEPTED', 'EXCLUDED', 'IRRELEVANT', 'FAILED'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_intakes_district_status_idx" ON "telegram_intake_records" USING btree ("district_id","status");
