DO $$
DECLARE
  offending_count integer;
  offending_ids text;
BEGIN
  SELECT count(*), coalesce(string_agg(id, ', '), '')
  INTO offending_count, offending_ids
  FROM "district_telegram_userbot_sessions"
  WHERE "api_hash" IS NOT NULL AND "api_hash_encrypted" IS NULL;

  IF offending_count > 0 THEN
    RAISE EXCEPTION 'Verification failed before drop: % offending row(s) found with non-null plaintext api_hash and null api_hash_encrypted (ids: %)', offending_count, offending_ids;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "district_telegram_userbot_sessions" DROP COLUMN "api_hash";