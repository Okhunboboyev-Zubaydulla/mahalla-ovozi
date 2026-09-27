DO $$ BEGIN
  ALTER TABLE "topics" DROP CONSTRAINT IF EXISTS "topics_status_check";
  ALTER TABLE "topics" ADD CONSTRAINT "topics_status_check" CHECK ("topics"."status" IN ('ACTIVE', 'ARCHIVED', 'INACTIVE'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
