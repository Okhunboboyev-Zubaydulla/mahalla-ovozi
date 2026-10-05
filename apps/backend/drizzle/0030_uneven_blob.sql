ALTER TABLE "district_telegram_userbot_sessions" ADD COLUMN "api_hash_encrypted" text;--> statement-breakpoint
ALTER TABLE "district_telegram_userbot_sessions" ADD COLUMN "api_hash_iv" text;--> statement-breakpoint
ALTER TABLE "district_telegram_userbot_sessions" ADD COLUMN "api_hash_tag" text;--> statement-breakpoint
ALTER TABLE "district_telegram_userbot_sessions" ADD COLUMN "api_hash_key_version" text DEFAULT 'v1' NOT NULL;