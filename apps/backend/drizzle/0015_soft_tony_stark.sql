CREATE TABLE "district_analysis_settings_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"district_id" text NOT NULL,
	"base_active_version_id" text,
	"hokim_recognition_terms" jsonb NOT NULL,
	"local_vocabulary_additions" jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_analysis_settings_drafts_district_id_unique" UNIQUE("district_id")
);
--> statement-breakpoint
CREATE TABLE "district_analysis_settings_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"district_id" text NOT NULL,
	"version" integer NOT NULL,
	"hokim_recognition_terms" jsonb NOT NULL,
	"local_vocabulary_additions" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	"change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "district_analysis_settings_drafts" ADD CONSTRAINT "district_analysis_settings_drafts_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "district_analysis_settings_drafts" ADD CONSTRAINT "district_analysis_settings_drafts_base_active_version_id_district_analysis_settings_versions_id_fk" FOREIGN KEY ("base_active_version_id") REFERENCES "public"."district_analysis_settings_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "district_analysis_settings_drafts" ADD CONSTRAINT "district_analysis_settings_drafts_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "district_analysis_settings_versions" ADD CONSTRAINT "district_analysis_settings_versions_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "district_analysis_settings_versions" ADD CONSTRAINT "district_analysis_settings_versions_activated_by_accounts_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "district_settings_drafts_district_idx" ON "district_analysis_settings_drafts" USING btree ("district_id");--> statement-breakpoint
CREATE UNIQUE INDEX "district_settings_versions_district_version_idx" ON "district_analysis_settings_versions" USING btree ("district_id","version");--> statement-breakpoint
CREATE INDEX "district_settings_versions_district_idx" ON "district_analysis_settings_versions" USING btree ("district_id");--> statement-breakpoint
CREATE INDEX "district_settings_versions_active_idx" ON "district_analysis_settings_versions" USING btree ("district_id","is_active");