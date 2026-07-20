CREATE TABLE "agentbay_schedule_states" (
  "tenant_id" text NOT NULL,
  "trigger_id" text NOT NULL,
  "next_fire_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agentbay_schedule_states_pk" PRIMARY KEY("tenant_id","trigger_id"),
  CONSTRAINT "agentbay_schedule_states_trigger_fk" FOREIGN KEY ("trigger_id","tenant_id") REFERENCES "agentbay_triggers"("id","tenant_id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "agentbay_schedule_states_due_idx" ON "agentbay_schedule_states" USING btree ("next_fire_at");--> statement-breakpoint
CREATE TABLE "agentbay_schedule_occurrences" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "trigger_id" text NOT NULL,
  "scheduled_at" timestamp with time zone NOT NULL,
  "state" text DEFAULT 'PENDING' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_token" text,
  "lease_expires_at" timestamp with time zone,
  "last_error" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agentbay_schedule_occurrences_trigger_fk" FOREIGN KEY ("trigger_id","tenant_id") REFERENCES "agentbay_triggers"("id","tenant_id") ON DELETE CASCADE,
  CONSTRAINT "agentbay_schedule_occurrences_state" CHECK ("state" IN ('PENDING','LEASED','RETRY_WAIT','SUCCEEDED','DEAD_LETTERED')),
  CONSTRAINT "agentbay_schedule_occurrences_attempt_nonnegative" CHECK ("attempt" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "agentbay_schedule_occurrences_trigger_time_unique" ON "agentbay_schedule_occurrences" USING btree ("tenant_id","trigger_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "agentbay_schedule_occurrences_available_idx" ON "agentbay_schedule_occurrences" USING btree ("state","available_at");
