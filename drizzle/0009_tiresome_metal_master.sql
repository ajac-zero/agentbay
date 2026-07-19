CREATE TABLE "agentbay_github_pull_request_effects" (
	"attempted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"execution_id" text NOT NULL,
	"fence_hash" text NOT NULL,
	"base_ref" text NOT NULL,
	"github_pull_request_id" text,
	"head_ref" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"opened_event_id" text,
	"pull_request_number" integer,
	"pull_request_url" text,
	"pull_request_title" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"repository_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text NOT NULL,
	"tenant_id" text NOT NULL,
	CONSTRAINT "agentbay_github_pull_request_effects_state_valid" CHECK ("agentbay_github_pull_request_effects"."state" IN ('REGISTERED','REPORTED','CONFIRMED')),
	CONSTRAINT "agentbay_github_pull_request_effects_fence_hash_valid" CHECK ("agentbay_github_pull_request_effects"."fence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agentbay_github_pull_request_effects_repository_id_valid" CHECK ("agentbay_github_pull_request_effects"."repository_id" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "agentbay_github_pull_request_effects_repository_name_bounded" CHECK (octet_length("agentbay_github_pull_request_effects"."repository_full_name") BETWEEN 3 AND 255),
	CONSTRAINT "agentbay_github_pull_request_effects_request_hash_valid" CHECK ("agentbay_github_pull_request_effects"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agentbay_github_pull_request_effects_pr_id_valid" CHECK ("agentbay_github_pull_request_effects"."github_pull_request_id" IS NULL OR "agentbay_github_pull_request_effects"."github_pull_request_id" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "agentbay_github_pull_request_effects_pr_number_valid" CHECK ("agentbay_github_pull_request_effects"."pull_request_number" IS NULL OR "agentbay_github_pull_request_effects"."pull_request_number" > 0),
	CONSTRAINT "agentbay_github_pull_request_effects_url_bounded" CHECK ("agentbay_github_pull_request_effects"."pull_request_url" IS NULL OR octet_length("agentbay_github_pull_request_effects"."pull_request_url") BETWEEN 20 AND 2048),
	CONSTRAINT "agentbay_github_pull_request_effects_request_bounded" CHECK (octet_length("agentbay_github_pull_request_effects"."pull_request_title") BETWEEN 1 AND 4096 AND octet_length("agentbay_github_pull_request_effects"."head_ref") BETWEEN 1 AND 255 AND octet_length("agentbay_github_pull_request_effects"."base_ref") BETWEEN 1 AND 255),
	CONSTRAINT "agentbay_github_pull_request_effects_identity_consistent" CHECK (("agentbay_github_pull_request_effects"."state"='REGISTERED' AND "agentbay_github_pull_request_effects"."github_pull_request_id" IS NULL AND "agentbay_github_pull_request_effects"."pull_request_number" IS NULL AND "agentbay_github_pull_request_effects"."pull_request_url" IS NULL AND "agentbay_github_pull_request_effects"."opened_event_id" IS NULL AND "agentbay_github_pull_request_effects"."confirmed_at" IS NULL) OR ("agentbay_github_pull_request_effects"."state"='REPORTED' AND "agentbay_github_pull_request_effects"."github_pull_request_id" IS NOT NULL AND "agentbay_github_pull_request_effects"."pull_request_number" IS NOT NULL AND "agentbay_github_pull_request_effects"."pull_request_url" IS NOT NULL AND "agentbay_github_pull_request_effects"."opened_event_id" IS NULL AND "agentbay_github_pull_request_effects"."confirmed_at" IS NULL) OR ("agentbay_github_pull_request_effects"."state"='CONFIRMED' AND "agentbay_github_pull_request_effects"."github_pull_request_id" IS NOT NULL AND "agentbay_github_pull_request_effects"."pull_request_number" IS NOT NULL AND "agentbay_github_pull_request_effects"."pull_request_url" IS NOT NULL AND "agentbay_github_pull_request_effects"."opened_event_id" IS NOT NULL AND "agentbay_github_pull_request_effects"."confirmed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agentbay_github_pull_request_effects" ADD CONSTRAINT "agentbay_github_pull_request_effects_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."agentbay_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_github_pull_request_effects" ADD CONSTRAINT "agentbay_github_pull_request_effects_event_tenant_fk" FOREIGN KEY ("opened_event_id","tenant_id") REFERENCES "public"."agentbay_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_github_pull_request_effects_execution_unique" ON "agentbay_github_pull_request_effects" USING btree ("tenant_id","execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_github_pull_request_effects_pr_id_unique" ON "agentbay_github_pull_request_effects" USING btree ("tenant_id","repository_id","github_pull_request_id") WHERE "agentbay_github_pull_request_effects"."github_pull_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_github_pull_request_effects_pr_number_unique" ON "agentbay_github_pull_request_effects" USING btree ("tenant_id","repository_id","pull_request_number") WHERE "agentbay_github_pull_request_effects"."pull_request_number" IS NOT NULL;
