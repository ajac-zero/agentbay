ALTER TABLE "dispatch_execution_attempts" ADD COLUMN "diagnostic" jsonb;--> statement-breakpoint
ALTER TABLE "dispatch_execution_attempts" ADD CONSTRAINT "dispatch_execution_attempts_diagnostic_bounded" CHECK ("diagnostic" IS NULL OR octet_length("diagnostic"::text) <= 8192);
