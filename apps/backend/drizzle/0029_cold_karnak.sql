ALTER TABLE "district_telegram_userbot_sessions" ADD COLUMN "last_successful_connection_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "district_telegram_userbot_sessions" ADD COLUMN "inbound_update_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "district_telegram_userbot_sessions" ADD COLUMN "is_stale" boolean DEFAULT false NOT NULL;