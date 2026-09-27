ALTER TABLE "districts" DROP CONSTRAINT IF EXISTS "districts_status_check";--> statement-breakpoint
ALTER TABLE "districts" ADD CONSTRAINT "districts_status_check" CHECK ("status" IN ('SETUP_INCOMPLETE', 'ACTIVE', 'GRACE', 'SUSPENDED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "district_subscriptions" DROP CONSTRAINT IF EXISTS "district_subscriptions_scheduled_transition_type_check";--> statement-breakpoint
ALTER TABLE "district_subscriptions" ADD CONSTRAINT "district_subscriptions_scheduled_transition_type_check" CHECK ("scheduled_transition_type" IS NULL OR "scheduled_transition_type" IN ('AUTOMATIC_SUSPENSION', 'LIVE_DELETION'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "district_subscriptions_scheduled_transition_idx" ON "district_subscriptions" USING btree ("scheduled_transition_at");
