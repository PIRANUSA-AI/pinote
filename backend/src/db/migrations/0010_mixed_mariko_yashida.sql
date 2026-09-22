ALTER TABLE "jobs" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;