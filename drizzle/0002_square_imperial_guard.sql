CREATE TABLE "dispatch_event_waits" (
	"activated_at" timestamp with time zone NOT NULL,
	"attempt" integer NOT NULL,
	"correlation" jsonb NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"execution_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"tenant_id" text NOT NULL,
	CONSTRAINT "dispatch_event_waits_attempt_positive" CHECK ("dispatch_event_waits"."attempt" > 0),
	CONSTRAINT "dispatch_event_waits_deadline_after_activation" CHECK ("dispatch_event_waits"."deadline_at" > "dispatch_event_waits"."activated_at"),
	CONSTRAINT "dispatch_event_waits_state_valid" CHECK ("dispatch_event_waits"."state" IN ('ACTIVE', 'CANCELLED', 'EXPIRED', 'CONSUMED')),
	CONSTRAINT "dispatch_event_waits_lifecycle_consistent" CHECK (("dispatch_event_waits"."state" = 'ACTIVE') = ("dispatch_event_waits"."ended_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "dispatch_execution_transitions" DROP CONSTRAINT "dispatch_execution_transitions_to_state_valid";--> statement-breakpoint
ALTER TABLE "dispatch_execution_transitions" DROP CONSTRAINT "dispatch_execution_transitions_from_state_valid";--> statement-breakpoint
ALTER TABLE "dispatch_executions" DROP CONSTRAINT "dispatch_executions_state_valid";--> statement-breakpoint
ALTER TABLE "dispatch_event_waits" ADD CONSTRAINT "dispatch_event_waits_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."dispatch_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_event_waits" ADD CONSTRAINT "dispatch_event_waits_attempt_fk" FOREIGN KEY ("execution_id","attempt") REFERENCES "public"."dispatch_execution_attempts"("execution_id","attempt") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_event_waits_one_active_execution_unique" ON "dispatch_event_waits" USING btree ("tenant_id","execution_id") WHERE "dispatch_event_waits"."state" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "dispatch_event_waits_deadline_idx" ON "dispatch_event_waits" USING btree ("deadline_at","execution_id") WHERE "dispatch_event_waits"."state" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "dispatch_event_waits_name_idx" ON "dispatch_event_waits" USING btree ("tenant_id","name") WHERE "dispatch_event_waits"."state" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "dispatch_execution_transitions" ADD CONSTRAINT "dispatch_execution_transitions_to_state_valid" CHECK ("dispatch_execution_transitions"."to_state" IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'WAITING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED'));--> statement-breakpoint
ALTER TABLE "dispatch_execution_transitions" ADD CONSTRAINT "dispatch_execution_transitions_from_state_valid" CHECK ("dispatch_execution_transitions"."from_state" IS NULL OR "dispatch_execution_transitions"."from_state" IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'WAITING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED'));--> statement-breakpoint
ALTER TABLE "dispatch_executions" ADD CONSTRAINT "dispatch_executions_state_valid" CHECK ("dispatch_executions"."state" IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'WAITING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED'));