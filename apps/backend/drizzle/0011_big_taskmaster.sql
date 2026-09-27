CREATE TABLE "user_dashboard_visits" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"district_id" text NOT NULL,
	"visited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_dashboard_visits" ADD CONSTRAINT "user_dashboard_visits_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_dashboard_visits" ADD CONSTRAINT "user_dashboard_visits_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_dashboard_visits_user_district_visited_idx" ON "user_dashboard_visits" USING btree ("user_id","district_id","visited_at");--> statement-breakpoint
CREATE INDEX "topics_district_retention_idx" ON "topics" USING btree ("district_id","retention_expires_at");