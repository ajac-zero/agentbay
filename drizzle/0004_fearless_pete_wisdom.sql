DROP INDEX "agentbay_outbox_publish_idx";--> statement-breakpoint
ALTER TABLE "agentbay_outbox" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agentbay_outbox" ADD COLUMN "lease_token" text;--> statement-breakpoint
CREATE INDEX "agentbay_outbox_claim_idx" ON "agentbay_outbox" USING btree ("available_at","lease_expires_at") WHERE "agentbay_outbox"."published_at" IS NULL;--> statement-breakpoint
ALTER TABLE "agentbay_outbox" ADD CONSTRAINT "agentbay_outbox_lease_complete" CHECK (("agentbay_outbox"."lease_token" IS NULL) = ("agentbay_outbox"."lease_expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "agentbay_outbox" ADD CONSTRAINT "agentbay_outbox_published_unleased" CHECK ("agentbay_outbox"."published_at" IS NULL OR "agentbay_outbox"."lease_token" IS NULL);