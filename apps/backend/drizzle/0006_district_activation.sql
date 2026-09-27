ALTER TABLE "districts" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "districts" ADD COLUMN "activated_by_id" text;--> statement-breakpoint
ALTER TABLE "districts" ADD CONSTRAINT "districts_activated_by_id_accounts_id_fk" FOREIGN KEY ("activated_by_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;
