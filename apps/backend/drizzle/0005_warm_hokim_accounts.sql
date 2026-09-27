ALTER TABLE "accounts" ADD COLUMN "status" text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "district_id" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_role_check" CHECK ("accounts"."role" IN ('PRODUCT_OWNER', 'DISTRICT_HOKIM'));--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_status_check" CHECK ("accounts"."status" IN ('ACTIVE', 'DISABLED'));--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_role_district_check" CHECK (("accounts"."role" = 'PRODUCT_OWNER' AND "accounts"."district_id" IS NULL) OR ("accounts"."role" = 'DISTRICT_HOKIM' AND "accounts"."district_id" IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_active_district_hokim_idx" ON "accounts" USING btree ("district_id") WHERE "role" = 'DISTRICT_HOKIM' AND "status" = 'ACTIVE';
