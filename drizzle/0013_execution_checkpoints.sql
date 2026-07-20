CREATE TABLE "agentbay_execution_checkpoints" (
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "checkpoint_name" text NOT NULL,
  "checkpoint_key_hash" text NOT NULL,
  "checkpoint_key_values" jsonb NOT NULL,
  "value" jsonb NOT NULL,
  "advanced_by_execution_id" text NOT NULL,
  "advanced_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "agentbay_execution_checkpoints_pk" PRIMARY KEY("tenant_id","binding_id","checkpoint_name","checkpoint_key_hash"),
  CONSTRAINT "agentbay_execution_checkpoints_execution_fk" FOREIGN KEY ("advanced_by_execution_id","tenant_id") REFERENCES "agentbay_executions"("id","tenant_id"),
  CONSTRAINT "agentbay_execution_checkpoints_key_hash_valid" CHECK ("checkpoint_key_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE TABLE "agentbay_execution_checkpoint_advances" (
  "execution_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "checkpoint_name" text NOT NULL,
  "checkpoint_key_hash" text NOT NULL,
  "checkpoint_key_values" jsonb NOT NULL,
  "expected_previous_exists" boolean NOT NULL,
  "expected_previous_value" jsonb,
  "target_value" jsonb NOT NULL,
  "state" text DEFAULT 'PENDING' NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "applied_at" timestamp with time zone,
  CONSTRAINT "agentbay_execution_checkpoint_advances_execution_fk" FOREIGN KEY ("execution_id","tenant_id") REFERENCES "agentbay_executions"("id","tenant_id") ON DELETE CASCADE,
  CONSTRAINT "agentbay_execution_checkpoint_advances_state" CHECK ("state" IN ('PENDING','APPLIED','SUPERSEDED')),
  CONSTRAINT "agentbay_execution_checkpoint_advances_expected_consistent" CHECK ("expected_previous_exists" = ("expected_previous_value" IS NOT NULL)),
  CONSTRAINT "agentbay_execution_checkpoint_advances_key_hash_valid" CHECK ("checkpoint_key_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE INDEX "agentbay_execution_checkpoint_advances_identity_idx" ON "agentbay_execution_checkpoint_advances" USING btree ("tenant_id","binding_id","checkpoint_name","checkpoint_key_hash");
