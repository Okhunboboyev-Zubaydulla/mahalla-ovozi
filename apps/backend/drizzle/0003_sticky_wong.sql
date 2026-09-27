CREATE TABLE "district_telegram_bots" (
	"id" text PRIMARY KEY NOT NULL,
	"district_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"bot_username" text,
	"bot_first_name" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_tag" text NOT NULL,
	"token_key_version" text DEFAULT 'v1' NOT NULL,
	"token_masked" text NOT NULL,
	"status" text DEFAULT 'VALID' NOT NULL,
	"last_validated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_telegram_bots_status_check" CHECK ("district_telegram_bots"."status" IN ('VALID', 'INVALID'))
);
--> statement-breakpoint
ALTER TABLE "district_telegram_bots" ADD CONSTRAINT "district_telegram_bots_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "district_telegram_bots_district_id_idx" ON "district_telegram_bots" USING btree ("district_id");--> statement-breakpoint
CREATE UNIQUE INDEX "district_telegram_bots_bot_id_idx" ON "district_telegram_bots" USING btree ("bot_id");