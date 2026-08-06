CREATE TABLE "dispatch_event_wake_intents" (
	"action" text NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"binding_version_id" text NOT NULL,
	"disposition" text NOT NULL,
	"event_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"input" jsonb,
	"tenant_id" text NOT NULL,
	"workspace" jsonb,
	CONSTRAINT "dispatch_event_wake_intents_action_valid" CHECK ("dispatch_event_wake_intents"."action" IN ('CONTINUED', 'COMPLETED')),
	CONSTRAINT "dispatch_event_wake_intents_disposition_valid" CHECK ("dispatch_event_wake_intents"."disposition" IN ('PENDING', 'DOMINATED')),
	CONSTRAINT "dispatch_event_wake_intents_payload_consistent" CHECK (("dispatch_event_wake_intents"."action" = 'CONTINUED' AND "dispatch_event_wake_intents"."input" IS NOT NULL AND "dispatch_event_wake_intents"."workspace" IS NOT NULL) OR ("dispatch_event_wake_intents"."action" = 'COMPLETED' AND "dispatch_event_wake_intents"."input" IS NULL AND "dispatch_event_wake_intents"."workspace" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "dispatch_execution_pending_wakes" (
	"execution_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dispatch_execution_pending_wakes_tenant_id_execution_id_pk" PRIMARY KEY("tenant_id","execution_id")
);
--> statement-breakpoint
CREATE TABLE "dispatch_execution_wake_contexts" (
	"correlation" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"execution_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tenant_id" text NOT NULL,
	CONSTRAINT "dispatch_execution_wake_contexts_correlation_object" CHECK (jsonb_typeof("dispatch_execution_wake_contexts"."correlation") = 'object')
);
--> statement-breakpoint
DROP INDEX "dispatch_event_wakes_wait_unique";--> statement-breakpoint
ALTER TABLE "dispatch_event_wakes" ALTER COLUMN "event_wait_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_event_wakes" ADD COLUMN "wake_intent_id" text;--> statement-breakpoint
ALTER TABLE "dispatch_event_wake_intents" ADD CONSTRAINT "dispatch_event_wake_intents_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."dispatch_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_event_wake_intents" ADD CONSTRAINT "dispatch_event_wake_intents_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."dispatch_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_event_wake_intents" ADD CONSTRAINT "dispatch_event_wake_intents_binding_tenant_fk" FOREIGN KEY ("binding_version_id","tenant_id") REFERENCES "public"."dispatch_binding_versions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_event_wake_intents_pending_reference_unique" ON "dispatch_event_wake_intents" USING btree ("id","tenant_id","execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_event_wake_intents_applied_reference_unique" ON "dispatch_event_wake_intents" USING btree ("id","tenant_id","event_id","execution_id","binding_version_id","action");--> statement-breakpoint
ALTER TABLE "dispatch_execution_pending_wakes" ADD CONSTRAINT "dispatch_execution_pending_wakes_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."dispatch_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_execution_pending_wakes" ADD CONSTRAINT "dispatch_execution_pending_wakes_intent_fk" FOREIGN KEY ("intent_id","tenant_id","execution_id") REFERENCES "public"."dispatch_event_wake_intents"("id","tenant_id","execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_execution_wake_contexts" ADD CONSTRAINT "dispatch_execution_wake_contexts_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."dispatch_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_event_wake_intents_event_execution_unique" ON "dispatch_event_wake_intents" USING btree ("tenant_id","event_id","execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_execution_pending_wakes_intent_unique" ON "dispatch_execution_pending_wakes" USING btree ("intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_execution_wake_contexts_execution_unique" ON "dispatch_execution_wake_contexts" USING btree ("tenant_id","execution_id");--> statement-breakpoint
CREATE INDEX "dispatch_execution_wake_contexts_match_idx" ON "dispatch_execution_wake_contexts" USING btree ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "dispatch_event_wakes" ADD CONSTRAINT "dispatch_event_wakes_intent_fk" FOREIGN KEY ("wake_intent_id","tenant_id","event_id","execution_id","binding_version_id","action") REFERENCES "public"."dispatch_event_wake_intents"("id","tenant_id","event_id","execution_id","binding_version_id","action") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_event_wakes_intent_unique" ON "dispatch_event_wakes" USING btree ("wake_intent_id") WHERE "dispatch_event_wakes"."wake_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_event_wakes_wait_unique" ON "dispatch_event_wakes" USING btree ("event_wait_id") WHERE "dispatch_event_wakes"."event_wait_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_event_wakes" ADD CONSTRAINT "dispatch_event_wakes_exactly_one_source" CHECK (("dispatch_event_wakes"."event_wait_id" IS NOT NULL) <> ("dispatch_event_wakes"."wake_intent_id" IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION dispatch_clear_terminal_pending_wake() RETURNS trigger AS $$
BEGIN
  IF NEW.state IN ('COMPLETED','CANCELLED','TIMED_OUT','FAILED','DEAD_LETTERED')
    AND OLD.state IS DISTINCT FROM NEW.state THEN
    DELETE FROM dispatch_execution_pending_wakes
      WHERE tenant_id = NEW.tenant_id AND execution_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER dispatch_executions_clear_terminal_pending_wake
AFTER UPDATE OF state ON dispatch_executions
FOR EACH ROW EXECUTE FUNCTION dispatch_clear_terminal_pending_wake();
