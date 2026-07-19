ALTER TABLE "agentbay_execution_inputs" ADD COLUMN "workspace" jsonb;--> statement-breakpoint
UPDATE "agentbay_execution_inputs" AS input
SET "workspace" = execution."workspace"
FROM "agentbay_executions" AS execution
WHERE execution."id" = input."execution_id";--> statement-breakpoint
ALTER TABLE "agentbay_execution_inputs" ALTER COLUMN "workspace" SET NOT NULL;
