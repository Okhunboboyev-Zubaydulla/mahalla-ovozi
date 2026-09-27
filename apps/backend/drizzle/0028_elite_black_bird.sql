DO $$ BEGIN
  ALTER TABLE "telegram_intake_records" ADD CONSTRAINT "telegram_intakes_bot_id_source_consistency_check" CHECK (("telegram_intake_records"."source" = 'BOT_API' AND "telegram_intake_records"."telegram_bot_id" IS NOT NULL) OR ("telegram_intake_records"."source" = 'USERBOT' AND "telegram_intake_records"."telegram_bot_id" IS NULL));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;