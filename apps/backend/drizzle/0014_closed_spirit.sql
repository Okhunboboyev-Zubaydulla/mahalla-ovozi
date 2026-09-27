CREATE TABLE "global_analysis_settings_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"base_active_version_id" text,
	"model_provider" text NOT NULL,
	"model_id" text NOT NULL,
	"temperature" real DEFAULT 0 NOT NULL,
	"max_output_tokens" integer DEFAULT 500 NOT NULL,
	"relevance_system_prompt" text NOT NULL,
	"topic_matching_system_prompt" text NOT NULL,
	"topic_projection_system_prompt" text NOT NULL,
	"global_service_vocabulary" jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_analysis_settings_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"model_provider" text NOT NULL,
	"model_id" text NOT NULL,
	"temperature" real DEFAULT 0 NOT NULL,
	"max_output_tokens" integer DEFAULT 500 NOT NULL,
	"relevance_system_prompt" text NOT NULL,
	"topic_matching_system_prompt" text NOT NULL,
	"topic_projection_system_prompt" text NOT NULL,
	"global_service_vocabulary" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	"change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "global_analysis_settings_drafts" ADD CONSTRAINT "global_analysis_settings_drafts_base_active_version_id_global_analysis_settings_versions_id_fk" FOREIGN KEY ("base_active_version_id") REFERENCES "public"."global_analysis_settings_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_analysis_settings_drafts" ADD CONSTRAINT "global_analysis_settings_drafts_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_analysis_settings_versions" ADD CONSTRAINT "global_analysis_settings_versions_activated_by_accounts_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "global_settings_versions_version_idx" ON "global_analysis_settings_versions" USING btree ("version");--> statement-breakpoint
CREATE INDEX "global_settings_versions_active_idx" ON "global_analysis_settings_versions" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_id_idx" ON "audit_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "audit_events_district_created_at_id_idx" ON "audit_events" USING btree ("district_id","created_at","id");