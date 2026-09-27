CREATE TABLE "district_telegram_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"district_id" text NOT NULL,
	"mahalla_name" text NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"telegram_chat_title" text NOT NULL,
	"telegram_chat_username" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"bot_membership_status" text,
	"privacy_mode_disabled" boolean DEFAULT false NOT NULL,
	"test_message_received_at" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_telegram_groups_status_check" CHECK ("district_telegram_groups"."status" IN ('PENDING', 'TESTING', 'VALID', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "district_telegram_groups" ADD CONSTRAINT "district_telegram_groups_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "district_telegram_groups_chat_id_idx" ON "district_telegram_groups" USING btree ("telegram_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "district_telegram_groups_district_mahalla_lower_idx" ON "district_telegram_groups" USING btree ("district_id",LOWER("mahalla_name"));--> statement-breakpoint
CREATE INDEX "district_telegram_groups_district_id_idx" ON "district_telegram_groups" USING btree ("district_id");