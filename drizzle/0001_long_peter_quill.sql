CREATE TABLE "agentbay_event_revision_resolutions" (
	"attempt" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"branch" text NOT NULL,
	"clone_url" text NOT NULL,
	"commit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"last_error" text,
	"lease_expires_at" timestamp with time zone,
	"lease_owner" text,
	"lease_token" text,
	"provider" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"repository_id" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"tenant_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agentbay_event_revision_resolutions_event_id_tenant_id_pk" PRIMARY KEY("event_id","tenant_id"),
	CONSTRAINT "agentbay_event_revision_resolutions_attempt_nonnegative" CHECK ("agentbay_event_revision_resolutions"."attempt" >= 0),
	CONSTRAINT "agentbay_event_revision_resolutions_provider_github" CHECK ("agentbay_event_revision_resolutions"."provider" = 'github'),
	CONSTRAINT "agentbay_event_revision_resolutions_state_valid" CHECK ("agentbay_event_revision_resolutions"."state" IN ('PENDING', 'LEASED', 'RETRY_WAIT', 'SUCCEEDED', 'DEAD_LETTERED')),
	CONSTRAINT "agentbay_event_revision_resolutions_commit_valid" CHECK ("agentbay_event_revision_resolutions"."commit" IS NULL OR "agentbay_event_revision_resolutions"."commit" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "agentbay_event_revision_resolutions_lease_consistent" CHECK (("agentbay_event_revision_resolutions"."lease_owner" IS NULL AND "agentbay_event_revision_resolutions"."lease_token" IS NULL AND "agentbay_event_revision_resolutions"."lease_expires_at" IS NULL) OR ("agentbay_event_revision_resolutions"."lease_owner" IS NOT NULL AND "agentbay_event_revision_resolutions"."lease_token" IS NOT NULL AND "agentbay_event_revision_resolutions"."lease_expires_at" IS NOT NULL AND "agentbay_event_revision_resolutions"."state" = 'LEASED'))
);
--> statement-breakpoint
ALTER TABLE "agentbay_event_revision_resolutions" ADD CONSTRAINT "agentbay_event_revision_resolutions_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."agentbay_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_event_revision_resolutions_lease_token_unique" ON "agentbay_event_revision_resolutions" USING btree ("lease_token") WHERE "agentbay_event_revision_resolutions"."lease_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agentbay_event_revision_resolutions_claim_idx" ON "agentbay_event_revision_resolutions" USING btree ("available_at","created_at","event_id") WHERE "agentbay_event_revision_resolutions"."state" IN ('PENDING', 'RETRY_WAIT', 'LEASED');