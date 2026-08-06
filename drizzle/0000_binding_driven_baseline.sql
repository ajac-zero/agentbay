CREATE TABLE "dispatch_agent_profile_version_connections" (
	"connection_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"profile_version_id" text NOT NULL,
	"sidecar" text NOT NULL,
	"tenant_id" text NOT NULL,
	CONSTRAINT "dispatch_agent_profile_version_connections_ordinal_nonnegative" CHECK ("dispatch_agent_profile_version_connections"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dispatch_agent_profile_versions" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"definition" jsonb NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "dispatch_agent_profile_versions_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "dispatch_agent_profile_versions_version_positive" CHECK ("dispatch_agent_profile_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "dispatch_binding_versions" (
	"binding_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"definition" jsonb NOT NULL,
	"disabled_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"event_types" text[] NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"profile_version_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "dispatch_binding_versions_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "dispatch_binding_versions_version_positive" CHECK ("dispatch_binding_versions"."version" > 0),
	CONSTRAINT "dispatch_binding_versions_event_types_nonempty" CHECK (cardinality("dispatch_binding_versions"."event_types") > 0),
	CONSTRAINT "dispatch_binding_versions_enabled_lifecycle_consistent" CHECK ("dispatch_binding_versions"."enabled" = ("dispatch_binding_versions"."disabled_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "dispatch_connections" (
	"connection_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"type" text NOT NULL,
	CONSTRAINT "dispatch_connections_id_tenant_unique" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "dispatch_events" (
	"admission_hash" text NOT NULL,
	"data" jsonb NOT NULL,
	"data_content_type" text DEFAULT 'application/json' NOT NULL,
	"data_schema" text,
	"event_id" text NOT NULL,
	"event_time" timestamp with time zone,
	"extensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"normalization_version" integer DEFAULT 1 NOT NULL,
	"raw_payload_ref" text,
	"source" text NOT NULL,
	"source_deduplication_key" text NOT NULL,
	"spec_version" text DEFAULT '1.0' NOT NULL,
	"subject" text,
	"tenant_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"type" text NOT NULL,
	CONSTRAINT "dispatch_events_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "dispatch_events_normalization_version_positive" CHECK ("dispatch_events"."normalization_version" > 0),
	CONSTRAINT "dispatch_events_spec_version_1" CHECK ("dispatch_events"."spec_version" = '1.0')
);
--> statement-breakpoint
CREATE TABLE "dispatch_execution_attempts" (
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
	CONSTRAINT "dispatch_execution_attempts_execution_id_attempt_pk" PRIMARY KEY("execution_id","attempt"),
	CONSTRAINT "dispatch_execution_attempts_attempt_positive" CHECK ("dispatch_execution_attempts"."attempt" > 0),
	CONSTRAINT "dispatch_execution_attempts_state_valid" CHECK ("dispatch_execution_attempts"."state" IN ('PENDING', 'LEASED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')),
	CONSTRAINT "dispatch_execution_attempts_active_lease_consistent" CHECK (("dispatch_execution_attempts"."lease_owner" IS NULL) = ("dispatch_execution_attempts"."lease_expires_at" IS NULL) AND ("dispatch_execution_attempts"."state" IN ('LEASED', 'RUNNING')) = ("dispatch_execution_attempts"."lease_owner" IS NOT NULL)),
	CONSTRAINT "dispatch_execution_attempts_terminal_consistent" CHECK (("dispatch_execution_attempts"."state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')) = ("dispatch_execution_attempts"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "dispatch_execution_transitions" (
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
	CONSTRAINT "dispatch_execution_transitions_attempt_positive" CHECK ("dispatch_execution_transitions"."attempt" IS NULL OR "dispatch_execution_transitions"."attempt" > 0),
	CONSTRAINT "dispatch_execution_transitions_sequence_positive" CHECK ("dispatch_execution_transitions"."sequence" > 0),
	CONSTRAINT "dispatch_execution_transitions_to_state_valid" CHECK ("dispatch_execution_transitions"."to_state" IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED')),
	CONSTRAINT "dispatch_execution_transitions_from_state_valid" CHECK ("dispatch_execution_transitions"."from_state" IS NULL OR "dispatch_execution_transitions"."from_state" IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED'))
);
--> statement-breakpoint
CREATE TABLE "dispatch_executions" (
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"binding_version_id" text NOT NULL,
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
	"workspace" jsonb DEFAULT '{"type":"empty"}'::jsonb NOT NULL,
	CONSTRAINT "dispatch_executions_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "dispatch_executions_state_valid" CHECK ("dispatch_executions"."state" IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED'))
);
--> statement-breakpoint
CREATE TABLE "dispatch_outbox" (
	"aggregate_id" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"last_error" text,
	"lease_expires_at" timestamp with time zone,
	"lease_token" text,
	"payload" jsonb NOT NULL,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"tenant_id" text NOT NULL,
	"topic" text NOT NULL,
	CONSTRAINT "dispatch_outbox_lease_complete" CHECK (("dispatch_outbox"."lease_token" IS NULL) = ("dispatch_outbox"."lease_expires_at" IS NULL)),
	CONSTRAINT "dispatch_outbox_published_unleased" CHECK ("dispatch_outbox"."published_at" IS NULL OR "dispatch_outbox"."lease_token" IS NULL),
	CONSTRAINT "dispatch_outbox_publish_attempts_nonnegative" CHECK ("dispatch_outbox"."publish_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dispatch_triggers" (
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"type" text NOT NULL,
	CONSTRAINT "dispatch_triggers_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "dispatch_triggers_enabled_lifecycle_consistent" CHECK ("dispatch_triggers"."enabled" = ("dispatch_triggers"."disabled_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "dispatch_agent_profile_version_connections" ADD CONSTRAINT "dispatch_agent_profile_version_connections_profile_tenant_fk" FOREIGN KEY ("profile_version_id","tenant_id") REFERENCES "public"."dispatch_agent_profile_versions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_agent_profile_version_connections" ADD CONSTRAINT "dispatch_agent_profile_version_connections_connection_tenant_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "public"."dispatch_connections"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_binding_versions" ADD CONSTRAINT "dispatch_binding_versions_trigger_tenant_fk" FOREIGN KEY ("trigger_id","tenant_id") REFERENCES "public"."dispatch_triggers"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_binding_versions" ADD CONSTRAINT "dispatch_binding_versions_profile_version_tenant_fk" FOREIGN KEY ("profile_version_id","tenant_id") REFERENCES "public"."dispatch_agent_profile_versions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_events" ADD CONSTRAINT "dispatch_events_trigger_tenant_fk" FOREIGN KEY ("trigger_id","tenant_id") REFERENCES "public"."dispatch_triggers"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_execution_attempts" ADD CONSTRAINT "dispatch_execution_attempts_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."dispatch_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_execution_transitions" ADD CONSTRAINT "dispatch_execution_transitions_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."dispatch_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_execution_transitions" ADD CONSTRAINT "dispatch_execution_transitions_attempt_fk" FOREIGN KEY ("execution_id","attempt") REFERENCES "public"."dispatch_execution_attempts"("execution_id","attempt") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_executions" ADD CONSTRAINT "dispatch_executions_binding_version_tenant_fk" FOREIGN KEY ("binding_version_id","tenant_id") REFERENCES "public"."dispatch_binding_versions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_executions" ADD CONSTRAINT "dispatch_executions_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."dispatch_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_executions" ADD CONSTRAINT "dispatch_executions_profile_version_tenant_fk" FOREIGN KEY ("profile_version_id","tenant_id") REFERENCES "public"."dispatch_agent_profile_versions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_agent_profile_version_connections_ordinal_unique" ON "dispatch_agent_profile_version_connections" USING btree ("tenant_id","profile_version_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_agent_profile_version_connections_connection_unique" ON "dispatch_agent_profile_version_connections" USING btree ("tenant_id","profile_version_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_agent_profile_versions_profile_version_unique" ON "dispatch_agent_profile_versions" USING btree ("tenant_id","profile_id","version");--> statement-breakpoint
CREATE INDEX "dispatch_agent_profile_versions_tenant_profile_idx" ON "dispatch_agent_profile_versions" USING btree ("tenant_id","profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_binding_versions_binding_version_unique" ON "dispatch_binding_versions" USING btree ("tenant_id","binding_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_binding_versions_one_enabled_unique" ON "dispatch_binding_versions" USING btree ("tenant_id","binding_id") WHERE "dispatch_binding_versions"."enabled";--> statement-breakpoint
CREATE INDEX "dispatch_binding_versions_match_idx" ON "dispatch_binding_versions" USING btree ("tenant_id","trigger_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_connections_tenant_connection_unique" ON "dispatch_connections" USING btree ("tenant_id","connection_id");--> statement-breakpoint
CREATE INDEX "dispatch_connections_tenant_type_idx" ON "dispatch_connections" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_events_trigger_source_event_unique" ON "dispatch_events" USING btree ("tenant_id","trigger_id","source","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_events_trigger_source_dedup_unique" ON "dispatch_events" USING btree ("tenant_id","trigger_id","source_deduplication_key");--> statement-breakpoint
CREATE INDEX "dispatch_events_tenant_trigger_ingested_idx" ON "dispatch_events" USING btree ("tenant_id","trigger_id","ingested_at");--> statement-breakpoint
CREATE INDEX "dispatch_events_tenant_type_ingested_idx" ON "dispatch_events" USING btree ("tenant_id","type","ingested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_execution_attempts_fencing_token_unique" ON "dispatch_execution_attempts" USING btree ("fencing_token");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_execution_attempts_one_active_unique" ON "dispatch_execution_attempts" USING btree ("execution_id") WHERE "dispatch_execution_attempts"."state" IN ('LEASED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "dispatch_execution_attempts_expired_active_lease_idx" ON "dispatch_execution_attempts" USING btree ("lease_expires_at","execution_id") WHERE "dispatch_execution_attempts"."state" IN ('LEASED', 'RUNNING');--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_execution_transitions_sequence_unique" ON "dispatch_execution_transitions" USING btree ("tenant_id","execution_id","sequence");--> statement-breakpoint
CREATE INDEX "dispatch_execution_transitions_execution_created_idx" ON "dispatch_execution_transitions" USING btree ("execution_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_executions_tenant_idempotency_unique" ON "dispatch_executions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_executions_tenant_event_binding_unique" ON "dispatch_executions" USING btree ("tenant_id","event_id","binding_version_id");--> statement-breakpoint
CREATE INDEX "dispatch_executions_tenant_binding_created_idx" ON "dispatch_executions" USING btree ("tenant_id","binding_version_id","created_at");--> statement-breakpoint
CREATE INDEX "dispatch_executions_tenant_event_idx" ON "dispatch_executions" USING btree ("tenant_id","event_id");--> statement-breakpoint
CREATE INDEX "dispatch_executions_tenant_state_created_idx" ON "dispatch_executions" USING btree ("tenant_id","state","created_at");--> statement-breakpoint
CREATE INDEX "dispatch_executions_state_timeout_idx" ON "dispatch_executions" USING btree ("state","timeout_at");--> statement-breakpoint
CREATE INDEX "dispatch_executions_dispatch_idx" ON "dispatch_executions" USING btree ("available_at","created_at","id") WHERE "dispatch_executions"."state" = 'QUEUED';--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_outbox_topic_aggregate_unique" ON "dispatch_outbox" USING btree ("topic","aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "dispatch_outbox_claim_idx" ON "dispatch_outbox" USING btree ("available_at","lease_expires_at") WHERE "dispatch_outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "dispatch_outbox_tenant_aggregate_idx" ON "dispatch_outbox" USING btree ("tenant_id","aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "dispatch_triggers_tenant_type_enabled_idx" ON "dispatch_triggers" USING btree ("tenant_id","type","enabled");