CREATE TABLE "agentbay_event_wake_offers" (
	"action" text NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"binding_version_id" text NOT NULL,
	"correlation" jsonb NOT NULL,
	"event_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"input" jsonb,
	"tenant_id" text NOT NULL,
	"wait_name" text NOT NULL,
	"workspace" jsonb,
	CONSTRAINT "agentbay_event_wake_offers_action_valid" CHECK ("agentbay_event_wake_offers"."action" IN ('CONTINUED','COMPLETED')),
	CONSTRAINT "agentbay_event_wake_offers_payload_consistent" CHECK (("agentbay_event_wake_offers"."action"='CONTINUED' AND "agentbay_event_wake_offers"."input" IS NOT NULL) OR ("agentbay_event_wake_offers"."action"='COMPLETED' AND "agentbay_event_wake_offers"."input" IS NULL AND "agentbay_event_wake_offers"."workspace" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "agentbay_execution_wake_context_values" (
	"authority_id" text,
	"authority_type" text NOT NULL,
	"context_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"execution_id" text NOT NULL,
	"name" text NOT NULL,
	"tenant_id" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "agentbay_execution_wake_context_values_context_id_name_pk" PRIMARY KEY("context_id","name"),
	CONSTRAINT "agentbay_execution_wake_context_values_authority_bounded" CHECK (octet_length("agentbay_execution_wake_context_values"."authority_type") BETWEEN 1 AND 255),
	CONSTRAINT "agentbay_execution_wake_context_values_primitive" CHECK (jsonb_typeof("agentbay_execution_wake_context_values"."value") IN ('null','boolean','number','string'))
);
--> statement-breakpoint
ALTER TABLE "agentbay_event_waits" DROP CONSTRAINT "agentbay_event_waits_state_valid";--> statement-breakpoint
ALTER TABLE "agentbay_event_waits" DROP CONSTRAINT "agentbay_event_waits_lifecycle_consistent";--> statement-breakpoint
DROP INDEX "agentbay_event_waits_one_active_execution_unique";--> statement-breakpoint
DROP INDEX "agentbay_event_waits_deadline_idx";--> statement-breakpoint
ALTER TABLE "agentbay_execution_wake_contexts" ALTER COLUMN "correlation" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "agentbay_event_wake_intents" ADD COLUMN "offer_id" text;--> statement-breakpoint
ALTER TABLE "agentbay_event_wakes" ADD COLUMN "offer_id" text;--> statement-breakpoint
ALTER TABLE "agentbay_execution_wake_contexts" ADD COLUMN "required_names" jsonb;--> statement-breakpoint
ALTER TABLE "agentbay_execution_wake_contexts" ADD COLUMN "state" text;--> statement-breakpoint
UPDATE "agentbay_execution_wake_contexts" AS context SET "required_names"=names.value,"state"='READY'
FROM "agentbay_executions" AS execution
JOIN "agentbay_binding_versions" AS binding ON binding.id=execution.binding_version_id AND binding.tenant_id=execution.tenant_id
CROSS JOIN LATERAL (SELECT jsonb_agg(item->>'name' ORDER BY item->>'name') AS value FROM jsonb_array_elements(binding.definition #> '{afterTurn,wait,correlation}') AS item) AS names
WHERE context.execution_id=execution.id AND context.tenant_id=execution.tenant_id;--> statement-breakpoint
ALTER TABLE "agentbay_execution_wake_contexts" ALTER COLUMN "required_names" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agentbay_execution_wake_contexts" ALTER COLUMN "state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agentbay_event_wake_offers" ADD CONSTRAINT "agentbay_event_wake_offers_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."agentbay_events"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_event_wake_offers" ADD CONSTRAINT "agentbay_event_wake_offers_binding_tenant_fk" FOREIGN KEY ("binding_version_id","tenant_id") REFERENCES "public"."agentbay_binding_versions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_execution_wake_contexts_reference_unique" ON "agentbay_execution_wake_contexts" USING btree ("id","tenant_id","execution_id");--> statement-breakpoint
ALTER TABLE "agentbay_execution_wake_context_values" ADD CONSTRAINT "agentbay_execution_wake_context_values_context_fk" FOREIGN KEY ("context_id","tenant_id","execution_id") REFERENCES "public"."agentbay_execution_wake_contexts"("id","tenant_id","execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_execution_wake_context_values" ADD CONSTRAINT "agentbay_execution_wake_context_values_execution_tenant_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "public"."agentbay_executions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_event_wake_offers_event_binding_unique" ON "agentbay_event_wake_offers" USING btree ("tenant_id","event_id","binding_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_event_wake_offers_reference_unique" ON "agentbay_event_wake_offers" USING btree ("id","tenant_id","event_id","binding_version_id","action");--> statement-breakpoint
CREATE INDEX "agentbay_event_wake_offers_match_idx" ON "agentbay_event_wake_offers" USING btree ("tenant_id","wait_name");--> statement-breakpoint
ALTER TABLE "agentbay_event_wake_intents" ADD CONSTRAINT "agentbay_event_wake_intents_offer_fk" FOREIGN KEY ("offer_id","tenant_id","event_id","binding_version_id","action") REFERENCES "public"."agentbay_event_wake_offers"("id","tenant_id","event_id","binding_version_id","action") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_event_wakes" ADD CONSTRAINT "agentbay_event_wakes_offer_fk" FOREIGN KEY ("offer_id","tenant_id","event_id","binding_version_id","action") REFERENCES "public"."agentbay_event_wake_offers"("id","tenant_id","event_id","binding_version_id","action") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_event_wake_intents_offer_execution_unique" ON "agentbay_event_wake_intents" USING btree ("offer_id","execution_id") WHERE "agentbay_event_wake_intents"."offer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_event_wakes_offer_execution_unique" ON "agentbay_event_wakes" USING btree ("offer_id","execution_id") WHERE "agentbay_event_wakes"."offer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_event_waits_one_active_execution_unique" ON "agentbay_event_waits" USING btree ("tenant_id","execution_id") WHERE "agentbay_event_waits"."state" IN ('PENDING_CONTEXT','ACTIVE');--> statement-breakpoint
CREATE INDEX "agentbay_event_waits_deadline_idx" ON "agentbay_event_waits" USING btree ("deadline_at","execution_id") WHERE "agentbay_event_waits"."state" IN ('PENDING_CONTEXT','ACTIVE');--> statement-breakpoint
ALTER TABLE "agentbay_event_waits" ADD CONSTRAINT "agentbay_event_waits_state_valid" CHECK ("agentbay_event_waits"."state" IN ('PENDING_CONTEXT', 'ACTIVE', 'CANCELLED', 'EXPIRED', 'CONSUMED'));--> statement-breakpoint
ALTER TABLE "agentbay_event_waits" ADD CONSTRAINT "agentbay_event_waits_lifecycle_consistent" CHECK (("agentbay_event_waits"."state" IN ('PENDING_CONTEXT','ACTIVE')) = ("agentbay_event_waits"."ended_at" IS NULL));--> statement-breakpoint
ALTER TABLE "agentbay_execution_wake_contexts" ADD CONSTRAINT "agentbay_execution_wake_contexts_required_names_array" CHECK (jsonb_typeof("agentbay_execution_wake_contexts"."required_names") = 'array');--> statement-breakpoint
ALTER TABLE "agentbay_execution_wake_contexts" ADD CONSTRAINT "agentbay_execution_wake_contexts_state_valid" CHECK ("agentbay_execution_wake_contexts"."state" IN ('BUILDING','READY'));
