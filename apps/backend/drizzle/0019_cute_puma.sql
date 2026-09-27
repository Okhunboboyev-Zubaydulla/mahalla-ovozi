CREATE INDEX "ai_ops_final_status_idx" ON "ai_operations" USING btree ("final_status");--> statement-breakpoint
CREATE INDEX "ai_ops_district_target_idx" ON "ai_operations" USING btree ("district_id","target_id");--> statement-breakpoint
CREATE INDEX "topics_district_latest_evidence_ts_idx" ON "topics" USING btree ("district_id","latest_relevant_evidence_timestamp");