CREATE TABLE "operational_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"logical_key" text NOT NULL,
	"scope" text NOT NULL,
	"district_id" text,
	"component" text NOT NULL,
	"issue_category" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"health_status" text NOT NULL,
	"sanitized_title" text NOT NULL,
	"sanitized_description" text NOT NULL,
	"recommended_action" text NOT NULL,
	"target_route" text,
	"metadata" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"latest_check_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_issues_scope_check" CHECK ("operational_issues"."scope" IN ('GLOBAL', 'DISTRICT')),
	CONSTRAINT "operational_issues_severity_check" CHECK ("operational_issues"."severity" IN ('Critical', 'Warning', 'Information')),
	CONSTRAINT "operational_issues_status_check" CHECK ("operational_issues"."status" IN ('ACTIVE', 'RESOLVED')),
	CONSTRAINT "operational_issues_scope_district_check" CHECK (("operational_issues"."scope" = 'GLOBAL' AND "operational_issues"."district_id" IS NULL) OR ("operational_issues"."scope" = 'DISTRICT' AND "operational_issues"."district_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "operational_issues" ADD CONSTRAINT "operational_issues_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operational_issues_active_logical_key_uidx" ON "operational_issues" USING btree ("logical_key") WHERE "operational_issues"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "operational_issues_status_severity_idx" ON "operational_issues" USING btree ("status","severity");--> statement-breakpoint
CREATE INDEX "operational_issues_district_status_idx" ON "operational_issues" USING btree ("district_id","status");--> statement-breakpoint
CREATE INDEX "operational_issues_started_at_idx" ON "operational_issues" USING btree ("started_at");