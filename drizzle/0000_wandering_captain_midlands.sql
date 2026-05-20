CREATE TABLE "agentbay_agent_profiles" (
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"opencode_agent_name" text NOT NULL,
	"opencode_config_id" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "agentbay_agent_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agentbay_bot_agent_profiles" (
	"agent_profile_id" text NOT NULL,
	"bot_id" text NOT NULL,
	CONSTRAINT "agentbay_bot_agent_profiles_bot_id_agent_profile_id_pk" PRIMARY KEY("bot_id","agent_profile_id")
);
--> statement-breakpoint
CREATE TABLE "agentbay_bots" (
	"default_agent_profile_id" text NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"sandbox_profile_id" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "agentbay_bots_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agentbay_opencode_configs" (
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agentbay_opencode_configs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agentbay_sandbox_profiles" (
	"enabled" boolean DEFAULT true NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"template_name" text NOT NULL,
	"warmpool" text DEFAULT 'none' NOT NULL,
	CONSTRAINT "agentbay_sandbox_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "agentbay_agent_profiles" ADD CONSTRAINT "agentbay_agent_profiles_opencode_config_id_agentbay_opencode_configs_id_fk" FOREIGN KEY ("opencode_config_id") REFERENCES "public"."agentbay_opencode_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_bot_agent_profiles" ADD CONSTRAINT "agentbay_bot_agent_profiles_agent_profile_id_agentbay_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."agentbay_agent_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_bot_agent_profiles" ADD CONSTRAINT "agentbay_bot_agent_profiles_bot_id_agentbay_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agentbay_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_bots" ADD CONSTRAINT "agentbay_bots_default_agent_profile_id_agentbay_agent_profiles_id_fk" FOREIGN KEY ("default_agent_profile_id") REFERENCES "public"."agentbay_agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentbay_bots" ADD CONSTRAINT "agentbay_bots_sandbox_profile_id_agentbay_sandbox_profiles_id_fk" FOREIGN KEY ("sandbox_profile_id") REFERENCES "public"."agentbay_sandbox_profiles"("id") ON DELETE no action ON UPDATE no action;