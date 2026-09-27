CREATE TABLE "topic_projections" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"district_id" text NOT NULL,
	"mahalla_name" text NOT NULL,
	"calendar_day" text NOT NULL,
	"summary" text NOT NULL,
	"lanes" jsonb NOT NULL,
	"primary_lane" text NOT NULL,
	"anchor_evidence_id" text NOT NULL,
	"anchor_quote" text NOT NULL,
	"latest_meaningful_activity_timestamp" timestamp with time zone NOT NULL,
	"attribution" text NOT NULL,
	"is_hokim_related" boolean DEFAULT false NOT NULL,
	"generation" integer NOT NULL,
	"ai_profile_id" text NOT NULL,
	"ai_operation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topic_projections" ADD CONSTRAINT "topic_projections_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_projections" ADD CONSTRAINT "topic_projections_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_projections" ADD CONSTRAINT "topic_projections_anchor_evidence_id_accepted_evidence_id_fk" FOREIGN KEY ("anchor_evidence_id") REFERENCES "public"."accepted_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_projections" ADD CONSTRAINT "topic_projections_ai_profile_id_ai_profiles_id_fk" FOREIGN KEY ("ai_profile_id") REFERENCES "public"."ai_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_projections" ADD CONSTRAINT "topic_projections_ai_operation_id_ai_operations_id_fk" FOREIGN KEY ("ai_operation_id") REFERENCES "public"."ai_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_projections_topic_id_idx" ON "topic_projections" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "topic_projections_district_day_idx" ON "topic_projections" USING btree ("district_id","calendar_day");--> statement-breakpoint
CREATE INDEX "topic_projections_district_mahalla_day_idx" ON "topic_projections" USING btree ("district_id","mahalla_name","calendar_day");