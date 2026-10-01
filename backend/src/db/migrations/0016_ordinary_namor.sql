CREATE TABLE "action_item_members" (
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_members" (
	"job_id" text NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_item_members" ADD CONSTRAINT "action_item_members_item_id_action_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."action_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_item_members" ADD CONSTRAINT "action_item_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_item_members" ADD CONSTRAINT "action_item_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_members" ADD CONSTRAINT "job_members_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_members" ADD CONSTRAINT "job_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_members" ADD CONSTRAINT "job_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_item_members_pair_idx" ON "action_item_members" USING btree ("item_id","user_id");--> statement-breakpoint
CREATE INDEX "action_item_members_user_idx" ON "action_item_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_members_pair_idx" ON "job_members" USING btree ("job_id","user_id");--> statement-breakpoint
CREATE INDEX "job_members_user_idx" ON "job_members" USING btree ("user_id");