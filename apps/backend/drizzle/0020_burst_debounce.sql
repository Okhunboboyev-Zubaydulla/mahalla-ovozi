ALTER TABLE "telegram_intake_records" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "telegram_intake_records" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "telegram_intakes_burst_unprocessed_idx" ON "telegram_intake_records" USING btree ("district_id","telegram_chat_id","telegram_user_id","processed_at");
