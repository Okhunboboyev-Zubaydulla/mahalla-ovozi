CREATE TABLE "district_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"district_id" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"status_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_transition_at" timestamp with time zone,
	"scheduled_transition_type" text,
	"external_payment_reference" text,
	"internal_note" text,
	"updated_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_subscriptions_status_check" CHECK ("status" IN ('SETUP_INCOMPLETE', 'ACTIVE', 'GRACE', 'SUSPENDED', 'CANCELLED'))
);
--> statement-breakpoint
ALTER TABLE "district_subscriptions" ADD CONSTRAINT "district_subscriptions_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "district_subscriptions_district_id_unique" ON "district_subscriptions" USING btree ("district_id");--> statement-breakpoint
CREATE INDEX "district_subscriptions_status_idx" ON "district_subscriptions" USING btree ("status");--> statement-breakpoint
INSERT INTO "district_subscriptions" (
	"id",
	"district_id",
	"status",
	"status_started_at",
	"created_at",
	"updated_at"
)
SELECT
	'sub_' || d.id,
	d.id,
	d.status,
	COALESCE(d.activated_at, d.created_at, NOW()),
	COALESCE(d.created_at, NOW()),
	COALESCE(d.updated_at, NOW())
FROM "districts" d
ON CONFLICT ("district_id") DO NOTHING;
