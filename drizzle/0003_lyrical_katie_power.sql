CREATE TABLE "agentbay_agent_profile_versions" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"definition" jsonb NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "agentbay_agent_profile_versions_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "agentbay_agent_profile_versions_version_positive" CHECK ("agentbay_agent_profile_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "agentbay_events" (
	"data" jsonb NOT NULL,
	"data_content_type" text DEFAULT 'application/json' NOT NULL,
	"event_id" text NOT NULL,
	"event_time" timestamp with time zone,
	"extensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"normalization_version" integer DEFAULT 1 NOT NULL,
	"raw_payload_ref" text,
	"source" text NOT NULL,
	"source_deduplication_key" text,
	"spec_version" text DEFAULT '1.0' NOT NULL,
	"subject" text,
	"tenant_id" text NOT NULL,
	"type" text NOT NULL,
	CONSTRAINT "agentbay_events_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "agentbay_events_normalization_version_positive" CHECK ("agentbay_events"."normalization_version" > 0),
	CONSTRAINT "agentbay_events_spec_version_1" CHECK ("agentbay_events"."spec_version" = '1.0')
);
--> statement-breakpoint
CREATE TABLE "agentbay_execution_attempts" (
	"attempt" integer NOT NULL,
	"execution_id" text NOT NULL,
	"fencing_token" text NOT NULL,
	"finished_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"lease_owner" text,
	"opencode_session_id" text,
	"started_at" timestamp with time zone,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"tenant_id" text NOT NULL,
	"workload_name" text,
	CONSTRAINT "agentbay_execution_attempts_execution_id_attempt_pk" PRIMARY KEY("execution_id","attempt"),
	CONSTRAINT "agentbay_execution_attempts_attempt_positive" CHECK ("agentbay_execution_attempts"."attempt" > 0),
	CONSTRAINT "agentbay_execution_attempts_state_valid" CHECK ("agentbay_execution_attempts"."state" IN ('PENDING', 'LEASED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'))
);
--> statement-breakpoint
CREATE TABLE "agentbay_execution_transitions" (
	"actor" text NOT NULL,
	"attempt" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"execution_id" text NOT NULL,
	"from_state" text,
	"id" text PRIMARY KEY NOT NULL,
	"reason" text,
	"sequence" integer NOT NULL,
	"tenant_id" text NOT NULL,
	"to_state" text NOT NULL,
	"trace_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "agentbay_execution_transitions_attempt_positive" CHECK ("agentbay_execution_transitions"."attempt" IS NULL OR "agentbay_execution_transitions"."attempt" > 0),
	CONSTRAINT "agentbay_execution_transitions_sequence_positive" CHECK ("agentbay_execution_transitions"."sequence" > 0),
	CONSTRAINT "agentbay_execution_transitions_to_state_valid" CHECK ("agentbay_execution_transitions"."to_state" IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED')),
	CONSTRAINT "agentbay_execution_transitions_from_state_valid" CHECK ("agentbay_execution_transitions"."from_state" IS NULL OR "agentbay_execution_transitions"."from_state" IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED'))
);
--> statement-breakpoint
CREATE TABLE "agentbay_executions" (
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"input" jsonb NOT NULL,
	"profile_version_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"resolved_policy" jsonb NOT NULL,
	"result" jsonb,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"tenant_id" text NOT NULL,
	"timeout_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "agentbay_executions_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "agentbay_executions_state_valid" CHECK ("agentbay_executions"."state" IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED'))
);
--> statement-breakpoint
CREATE TABLE "agentbay_outbox" (
	"aggregate_id" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"last_error" text,
	"payload" jsonb NOT NULL,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"tenant_id" text NOT NULL,
	"topic" text NOT NULL,
	CONSTRAINT "agentbay_outbox_publish_attempts_nonnegative" CHECK ("agentbay_outbox"."publish_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agentbay_execution_attempts" ADD CONSTRAINT "agentbay_execution_attempts_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."agentbay_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_execution_transitions" ADD CONSTRAINT "agentbay_execution_transitions_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."agentbay_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_execution_transitions" ADD CONSTRAINT "agentbay_execution_transitions_attempt_fk" FOREIGN KEY ("execution_id","attempt") REFERENCES "public"."agentbay_execution_attempts"("execution_id","attempt") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_executions" ADD CONSTRAINT "agentbay_executions_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."agentbay_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_executions" ADD CONSTRAINT "agentbay_executions_profile_version_tenant_fk" FOREIGN KEY ("profile_version_id","tenant_id") REFERENCES "public"."agentbay_agent_profile_versions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_agent_profile_versions_profile_version_unique" ON "agentbay_agent_profile_versions" USING btree ("tenant_id","profile_id","version");--> statement-breakpoint
CREATE INDEX "agentbay_agent_profile_versions_tenant_profile_idx" ON "agentbay_agent_profile_versions" USING btree ("tenant_id","profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_events_source_event_unique" ON "agentbay_events" USING btree ("tenant_id","source","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_events_source_dedup_unique" ON "agentbay_events" USING btree ("tenant_id","source","source_deduplication_key");--> statement-breakpoint
CREATE INDEX "agentbay_events_tenant_type_ingested_idx" ON "agentbay_events" USING btree ("tenant_id","type","ingested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_execution_attempts_fencing_token_unique" ON "agentbay_execution_attempts" USING btree ("fencing_token");--> statement-breakpoint
CREATE INDEX "agentbay_execution_attempts_lease_idx" ON "agentbay_execution_attempts" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_execution_transitions_sequence_unique" ON "agentbay_execution_transitions" USING btree ("tenant_id","execution_id","sequence");--> statement-breakpoint
CREATE INDEX "agentbay_execution_transitions_execution_created_idx" ON "agentbay_execution_transitions" USING btree ("execution_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_executions_tenant_idempotency_unique" ON "agentbay_executions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agentbay_executions_tenant_state_created_idx" ON "agentbay_executions" USING btree ("tenant_id","state","created_at");--> statement-breakpoint
CREATE INDEX "agentbay_executions_state_timeout_idx" ON "agentbay_executions" USING btree ("state","timeout_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_outbox_topic_aggregate_unique" ON "agentbay_outbox" USING btree ("topic","aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "agentbay_outbox_publish_idx" ON "agentbay_outbox" USING btree ("published_at","available_at");--> statement-breakpoint
CREATE INDEX "agentbay_outbox_tenant_aggregate_idx" ON "agentbay_outbox" USING btree ("tenant_id","aggregate_type","aggregate_id");