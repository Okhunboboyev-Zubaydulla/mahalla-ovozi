CREATE TABLE "ai_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"district_id" text NOT NULL,
	"mahalla_name" text NOT NULL,
	"calendar_day" text NOT NULL,
	"operation_type" text NOT NULL,
	"target_id" text NOT NULL,
	"pinned_profile_id" text NOT NULL,
	"context_revision" integer DEFAULT 0 NOT NULL,
	"snapshot_fingerprint" text NOT NULL,
	"final_status" text NOT NULL,
	"result_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"operation_type" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"temperature" real DEFAULT 0 NOT NULL,
	"max_output_tokens" integer DEFAULT 500 NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"retry_policy" jsonb NOT NULL,
	"capabilities" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"provider_request_id" text,
	"duration_ms" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"estimated_cost_usd" numeric(10, 6),
	"status" text NOT NULL,
	"error_code" text,
	"sanitized_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_pinned_profile_id_ai_profiles_id_fk" FOREIGN KEY ("pinned_profile_id") REFERENCES "public"."ai_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_attempts" ADD CONSTRAINT "ai_provider_attempts_operation_id_ai_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."ai_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_ops_district_mahalla_day_idx" ON "ai_operations" USING btree ("district_id","mahalla_name","calendar_day");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_ops_district_op_target_idx" ON "ai_operations" USING btree ("district_id","operation_type","target_id");--> statement-breakpoint
CREATE INDEX "ai_attempts_operation_idx" ON "ai_provider_attempts" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_attempts_op_attempt_idx" ON "ai_provider_attempts" USING btree ("operation_id","attempt_number");