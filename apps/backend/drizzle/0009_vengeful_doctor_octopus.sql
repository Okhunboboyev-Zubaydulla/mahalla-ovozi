CREATE TABLE "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"district_id" text NOT NULL,
	"mahalla_name" text NOT NULL,
	"calendar_day" text NOT NULL,
	"primary_lane" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"latest_relevant_evidence_timestamp" timestamp with time zone NOT NULL,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"required_derived_generation" integer DEFAULT 1 NOT NULL,
	"applied_derived_generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accepted_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"district_id" text NOT NULL,
	"mahalla_name" text NOT NULL,
	"calendar_day" text NOT NULL,
	"intake_record_id" text NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"telegram_message_id" text NOT NULL,
	"telegram_user_id" text,
	"original_timestamp" timestamp with time zone NOT NULL,
	"verbatim_text" text NOT NULL,
	"content_type" text NOT NULL,
	"user_metadata" jsonb,
	"reply_metadata" jsonb,
	"ai_operation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_evidence" ADD CONSTRAINT "accepted_evidence_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_evidence" ADD CONSTRAINT "accepted_evidence_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_evidence" ADD CONSTRAINT "accepted_evidence_intake_record_id_telegram_intake_records_id_fk" FOREIGN KEY ("intake_record_id") REFERENCES "public"."telegram_intake_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_evidence" ADD CONSTRAINT "accepted_evidence_ai_operation_id_ai_operations_id_fk" FOREIGN KEY ("ai_operation_id") REFERENCES "public"."ai_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topics_district_mahalla_day_idx" ON "topics" USING btree ("district_id","mahalla_name","calendar_day");--> statement-breakpoint
CREATE INDEX "topics_district_status_idx" ON "topics" USING btree ("district_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "accepted_evidence_district_chat_msg_idx" ON "accepted_evidence" USING btree ("district_id","telegram_chat_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "accepted_evidence_district_mahalla_day_idx" ON "accepted_evidence" USING btree ("district_id","mahalla_name","calendar_day");--> statement-breakpoint
CREATE INDEX "accepted_evidence_topic_id_idx" ON "accepted_evidence" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "accepted_evidence_ordering_idx" ON "accepted_evidence" USING btree ("district_id","mahalla_name","calendar_day","original_timestamp","telegram_message_id","id");