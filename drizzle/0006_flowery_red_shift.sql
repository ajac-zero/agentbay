ALTER TABLE "dispatch_execution_inputs" ADD COLUMN "workspace" jsonb;--> statement-breakpoint
UPDATE "dispatch_execution_inputs" AS input
SET "workspace" = execution."workspace"
FROM "dispatch_executions" AS execution
WHERE execution."id" = input."execution_id";--> statement-breakpoint
ALTER TABLE "dispatch_execution_inputs" ALTER COLUMN "workspace" SET NOT NULL;
