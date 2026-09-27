ALTER TABLE "telegram_intake_records" ALTER COLUMN "telegram_bot_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_intake_records" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'BOT_API' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "telegram_intake_records" ADD CONSTRAINT "telegram_intakes_source_check" CHECK ("telegram_intake_records"."source" IN ('BOT_API', 'USERBOT'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accepted_evidence_topic_keyset_idx" ON "accepted_evidence" USING btree ("topic_id","district_id","original_timestamp","telegram_message_id","id");