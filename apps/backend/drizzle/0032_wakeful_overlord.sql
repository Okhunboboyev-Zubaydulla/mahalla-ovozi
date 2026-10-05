ALTER TABLE "district_telegram_userbot_sessions" ADD COLUMN IF NOT EXISTS "update_position" text;
ALTER TABLE "district_telegram_userbot_sessions" ADD COLUMN IF NOT EXISTS "update_position_advanced_at" timestamp with time zone;
