ALTER TABLE "jobs" ADD COLUMN "insight_status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "insight_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "insight_started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "jobs_insight_status_idx" ON "jobs" USING btree ("insight_status");