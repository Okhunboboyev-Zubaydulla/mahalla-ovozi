CREATE TABLE "telegram_intake_records" (
	"id" text PRIMARY KEY NOT NULL,
	"district_id" text NOT NULL,
	"mahalla_name" text NOT NULL,
	"telegram_bot_id" text NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"telegram_message_id" text NOT NULL,
	"update_id" text,
	"telegram_user_id" text,
	"original_timestamp" timestamp with time zone NOT NULL,
	"calendar_day" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_intake_records" ADD CONSTRAINT "telegram_intake_records_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_intakes_district_chat_msg_idx" ON "telegram_intake_records" USING btree ("district_id","telegram_chat_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "telegram_intakes_district_day_mahalla_idx" ON "telegram_intake_records" USING btree ("district_id","calendar_day","mahalla_name");--> statement-breakpoint
CREATE INDEX "telegram_intakes_district_created_idx" ON "telegram_intake_records" USING btree ("district_id","created_at");