CREATE TABLE "districts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"region" text,
	"status" text DEFAULT 'SETUP_INCOMPLETE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "districts" ADD CONSTRAINT "districts_status_check"
  CHECK (status IN ('SETUP_INCOMPLETE', 'ACTIVE', 'SUSPENDED', 'CANCELLED'));
--> statement-breakpoint
CREATE UNIQUE INDEX "districts_name_lower_idx" ON "districts" USING btree (LOWER("name"));--> statement-breakpoint
CREATE INDEX "districts_name_idx" ON "districts" USING btree ("name");