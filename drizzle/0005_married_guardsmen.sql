CREATE TABLE "agentbay_event_wakes" (
	"action" text NOT NULL,
	"binding_version_id" text NOT NULL,
	"consumed_at" timestamp with time zone NOT NULL,
	"event_id" text NOT NULL,
	"event_wait_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"input_sequence" integer,
	"tenant_id" text NOT NULL,
	"to_state" text NOT NULL,
	CONSTRAINT "agentbay_event_wakes_action_valid" CHECK ("agentbay_event_wakes"."action" IN ('CONTINUED', 'COMPLETED')),
	CONSTRAINT "agentbay_event_wakes_lifecycle_consistent" CHECK (("agentbay_event_wakes"."action" = 'CONTINUED' AND "agentbay_event_wakes"."to_state" = 'QUEUED' AND "agentbay_event_wakes"."input_sequence" IS NOT NULL) OR ("agentbay_event_wakes"."action" = 'COMPLETED' AND "agentbay_event_wakes"."to_state" = 'COMPLETED' AND "agentbay_event_wakes"."input_sequence" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "agentbay_execution_inputs" (
	"created_at" timestamp with time zone NOT NULL,
	"event_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"kind" text NOT NULL,
	"sequence" integer NOT NULL,
	"tenant_id" text NOT NULL,
	CONSTRAINT "agentbay_execution_inputs_execution_id_sequence_pk" PRIMARY KEY("execution_id","sequence"),
	CONSTRAINT "agentbay_execution_inputs_sequence_positive" CHECK ("agentbay_execution_inputs"."sequence" > 0),
	CONSTRAINT "agentbay_execution_inputs_kind_valid" CHECK ("agentbay_execution_inputs"."kind" IN ('INITIAL', 'WAKE'))
);
--> statement-breakpoint
ALTER TABLE "agentbay_executions" ADD COLUMN "current_input_sequence" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agentbay_event_wakes" ADD CONSTRAINT "agentbay_event_wakes_binding_tenant_fk" FOREIGN KEY ("binding_version_id","tenant_id") REFERENCES "public"."agentbay_binding_versions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_event_wakes" ADD CONSTRAINT "agentbay_event_wakes_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."agentbay_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_event_wakes" ADD CONSTRAINT "agentbay_event_wakes_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."agentbay_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_event_waits" ADD CONSTRAINT "agentbay_event_waits_id_tenant_execution_unique" UNIQUE("id","tenant_id","execution_id");--> statement-breakpoint
ALTER TABLE "agentbay_event_wakes" ADD CONSTRAINT "agentbay_event_wakes_wait_execution_fk" FOREIGN KEY ("event_wait_id","tenant_id","execution_id") REFERENCES "public"."agentbay_event_waits"("id","tenant_id","execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_event_wakes" ADD CONSTRAINT "agentbay_event_wakes_input_fk" FOREIGN KEY ("execution_id","input_sequence") REFERENCES "public"."agentbay_execution_inputs"("execution_id","sequence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_execution_inputs" ADD CONSTRAINT "agentbay_execution_inputs_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."agentbay_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_execution_inputs" ADD CONSTRAINT "agentbay_execution_inputs_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."agentbay_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "agentbay_execution_inputs" ("tenant_id", "execution_id", "sequence", "kind", "event_id", "input", "created_at")
SELECT "tenant_id", "id", 1, 'INITIAL', "event_id", "input", "created_at"
FROM "agentbay_executions";--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_event_wakes_wait_unique" ON "agentbay_event_wakes" USING btree ("event_wait_id");--> statement-breakpoint
CREATE INDEX "agentbay_event_wakes_event_idx" ON "agentbay_event_wakes" USING btree ("tenant_id","event_id","execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_execution_inputs_initial_unique" ON "agentbay_execution_inputs" USING btree ("execution_id") WHERE "agentbay_execution_inputs"."kind" = 'INITIAL';--> statement-breakpoint
ALTER TABLE "agentbay_executions" ADD CONSTRAINT "agentbay_executions_current_input_sequence_positive" CHECK ("agentbay_executions"."current_input_sequence" > 0);
