ALTER TABLE "districts" ADD COLUMN "access_eligible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "districts" ADD COLUMN "analysis_config_profile_id" text DEFAULT 'baseline_v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "districts" ADD COLUMN "disclosure_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "districts" ADD COLUMN "disclosure_confirmed_by_id" text;--> statement-breakpoint
ALTER TABLE "districts" ADD CONSTRAINT "districts_disclosure_confirmed_by_id_accounts_id_fk" FOREIGN KEY ("disclosure_confirmed_by_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;