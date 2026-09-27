CREATE TABLE IF NOT EXISTS "district_telegram_userbot_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"district_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"api_id" text NOT NULL,
	"api_hash" text,
	"session_encrypted" text,
	"session_iv" text,
	"session_tag" text,
	"session_key_version" text DEFAULT 'v1' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_userbot_sessions_status_check" CHECK ("district_telegram_userbot_sessions"."status" IN ('PENDING', 'ACTIVE', 'BANNED', 'DISABLED'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "district_telegram_userbot_sessions" ADD CONSTRAINT "district_telegram_userbot_sessions_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "district_telegram_userbot_sessions_district_id_idx" ON "district_telegram_userbot_sessions" USING btree ("district_id");