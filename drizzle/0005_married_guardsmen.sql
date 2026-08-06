CREATE TABLE "dispatch_event_wakes" (
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
	CONSTRAINT "dispatch_event_wakes_action_valid" CHECK ("dispatch_event_wakes"."action" IN ('CONTINUED', 'COMPLETED')),
	CONSTRAINT "dispatch_event_wakes_lifecycle_consistent" CHECK (("dispatch_event_wakes"."action" = 'CONTINUED' AND "dispatch_event_wakes"."to_state" = 'QUEUED' AND "dispatch_event_wakes"."input_sequence" IS NOT NULL) OR ("dispatch_event_wakes"."action" = 'COMPLETED' AND "dispatch_event_wakes"."to_state" = 'COMPLETED' AND "dispatch_event_wakes"."input_sequence" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "dispatch_execution_inputs" (
	"created_at" timestamp with time zone NOT NULL,
	"event_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"kind" text NOT NULL,
	"sequence" integer NOT NULL,
	"tenant_id" text NOT NULL,
	CONSTRAINT "dispatch_execution_inputs_execution_id_sequence_pk" PRIMARY KEY("execution_id","sequence"),
	CONSTRAINT "dispatch_execution_inputs_sequence_positive" CHECK ("dispatch_execution_inputs"."sequence" > 0),
	CONSTRAINT "dispatch_execution_inputs_kind_valid" CHECK ("dispatch_execution_inputs"."kind" IN ('INITIAL', 'WAKE'))
);
--> statement-breakpoint
ALTER TABLE "dispatch_executions" ADD COLUMN "current_input_sequence" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_event_wakes" ADD CONSTRAINT "dispatch_event_wakes_binding_tenant_fk" FOREIGN KEY ("binding_version_id","tenant_id") REFERENCES "public"."dispatch_binding_versions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_event_wakes" ADD CONSTRAINT "dispatch_event_wakes_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."dispatch_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_event_wakes" ADD CONSTRAINT "dispatch_event_wakes_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."dispatch_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_event_waits" ADD CONSTRAINT "dispatch_event_waits_id_tenant_execution_unique" UNIQUE("id","tenant_id","execution_id");--> statement-breakpoint
ALTER TABLE "dispatch_event_wakes" ADD CONSTRAINT "dispatch_event_wakes_wait_execution_fk" FOREIGN KEY ("event_wait_id","tenant_id","execution_id") REFERENCES "public"."dispatch_event_waits"("id","tenant_id","execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_event_wakes" ADD CONSTRAINT "dispatch_event_wakes_input_fk" FOREIGN KEY ("execution_id","input_sequence") REFERENCES "public"."dispatch_execution_inputs"("execution_id","sequence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_execution_inputs" ADD CONSTRAINT "dispatch_execution_inputs_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."dispatch_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_execution_inputs" ADD CONSTRAINT "dispatch_execution_inputs_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."dispatch_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "dispatch_execution_inputs" ("tenant_id", "execution_id", "sequence", "kind", "event_id", "input", "created_at")
SELECT "tenant_id", "id", 1, 'INITIAL', "event_id", "input", "created_at"
FROM "dispatch_executions";--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_event_wakes_wait_unique" ON "dispatch_event_wakes" USING btree ("event_wait_id");--> statement-breakpoint
CREATE INDEX "dispatch_event_wakes_event_idx" ON "dispatch_event_wakes" USING btree ("tenant_id","event_id","execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_execution_inputs_initial_unique" ON "dispatch_execution_inputs" USING btree ("execution_id") WHERE "dispatch_execution_inputs"."kind" = 'INITIAL';--> statement-breakpoint
ALTER TABLE "dispatch_executions" ADD CONSTRAINT "dispatch_executions_current_input_sequence_positive" CHECK ("dispatch_executions"."current_input_sequence" > 0);
