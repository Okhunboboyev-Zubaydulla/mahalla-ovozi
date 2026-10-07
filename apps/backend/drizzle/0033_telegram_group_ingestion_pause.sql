ALTER TABLE "district_telegram_groups" ADD COLUMN "is_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "district_telegram_groups" ADD COLUMN "is_paused_skipped_count" integer DEFAULT 0 NOT NULL;
