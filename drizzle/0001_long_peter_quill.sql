CREATE TABLE "dispatch_event_revision_resolutions" (
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
	CONSTRAINT "dispatch_event_revision_resolutions_event_id_tenant_id_pk" PRIMARY KEY("event_id","tenant_id"),
	CONSTRAINT "dispatch_event_revision_resolutions_attempt_nonnegative" CHECK ("dispatch_event_revision_resolutions"."attempt" >= 0),
	CONSTRAINT "dispatch_event_revision_resolutions_provider_github" CHECK ("dispatch_event_revision_resolutions"."provider" = 'github'),
	CONSTRAINT "dispatch_event_revision_resolutions_state_valid" CHECK ("dispatch_event_revision_resolutions"."state" IN ('PENDING', 'LEASED', 'RETRY_WAIT', 'SUCCEEDED', 'DEAD_LETTERED')),
	CONSTRAINT "dispatch_event_revision_resolutions_commit_valid" CHECK ("dispatch_event_revision_resolutions"."commit" IS NULL OR "dispatch_event_revision_resolutions"."commit" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "dispatch_event_revision_resolutions_lease_consistent" CHECK (("dispatch_event_revision_resolutions"."lease_owner" IS NULL AND "dispatch_event_revision_resolutions"."lease_token" IS NULL AND "dispatch_event_revision_resolutions"."lease_expires_at" IS NULL) OR ("dispatch_event_revision_resolutions"."lease_owner" IS NOT NULL AND "dispatch_event_revision_resolutions"."lease_token" IS NOT NULL AND "dispatch_event_revision_resolutions"."lease_expires_at" IS NOT NULL AND "dispatch_event_revision_resolutions"."state" = 'LEASED'))
);
--> statement-breakpoint
ALTER TABLE "dispatch_event_revision_resolutions" ADD CONSTRAINT "dispatch_event_revision_resolutions_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."dispatch_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_event_revision_resolutions_lease_token_unique" ON "dispatch_event_revision_resolutions" USING btree ("lease_token") WHERE "dispatch_event_revision_resolutions"."lease_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "dispatch_event_revision_resolutions_claim_idx" ON "dispatch_event_revision_resolutions" USING btree ("available_at","created_at","event_id") WHERE "dispatch_event_revision_resolutions"."state" IN ('PENDING', 'RETRY_WAIT', 'LEASED');