import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { BotAdapterConfig, EnvVarRef, OpencodeConfig } from "./types.js";

export const sandboxProfiles = pgTable("agentbay_sandbox_profiles", {
  enabled: boolean("enabled").notNull().default(true),
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  templateName: text("template_name").notNull(),
  warmpool: text("warmpool").notNull().default("none"),
}, (table) => [
  check("agentbay_sandbox_profiles_id_dns_label", sql`${table.id} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' AND length(${table.id}) <= 63`),
  check("agentbay_sandbox_profiles_slug_dns_label", sql`${table.slug} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' AND length(${table.slug}) <= 63`),
]);

export const opencodeConfigs = pgTable("agentbay_opencode_configs", {
  config: jsonb("config").$type<OpencodeConfig>().notNull().default({}),
  configHash: text("config_hash").notNull(),
  displayName: text("display_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("agentbay_opencode_configs_id_dns_label", sql`${table.id} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' AND length(${table.id}) <= 63`),
  check("agentbay_opencode_configs_slug_dns_label", sql`${table.slug} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' AND length(${table.slug}) <= 63`),
]);

export const agentProfiles = pgTable("agentbay_agent_profiles", {
  claimEnv: jsonb("claim_env").$type<EnvVarRef[]>().notNull().default([]),
  displayName: text("display_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  id: text("id").primaryKey(),
  opencodeAgentName: text("opencode_agent_name").notNull(),
  opencodeConfigID: text("opencode_config_id")
    .notNull()
    .references(() => opencodeConfigs.id),
  slug: text("slug").notNull().unique(),
}, (table) => [
  check("agentbay_agent_profiles_id_dns_label", sql`${table.id} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' AND length(${table.id}) <= 63`),
  check("agentbay_agent_profiles_slug_dns_label", sql`${table.slug} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' AND length(${table.slug}) <= 63`),
]);

export const bots = pgTable("agentbay_bots", {
  adapters: jsonb("adapters").$type<BotAdapterConfig>().notNull().default({}),
  defaultAgentProfileID: text("default_agent_profile_id")
    .notNull()
    .references(() => agentProfiles.id),
  displayName: text("display_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  id: text("id").primaryKey(),
  sandboxProfileID: text("sandbox_profile_id")
    .notNull()
    .references(() => sandboxProfiles.id),
  slug: text("slug").notNull().unique(),
}, (table) => [
  check("agentbay_bots_id_dns_label", sql`${table.id} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' AND length(${table.id}) <= 63`),
  check("agentbay_bots_slug_dns_label", sql`${table.slug} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' AND length(${table.slug}) <= 63`),
]);

export const botAgentProfiles = pgTable(
  "agentbay_bot_agent_profiles",
  {
    agentProfileID: text("agent_profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "cascade" }),
    botID: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.botID, table.agentProfileID] })],
);

export const agentProfileVersions = pgTable("agentbay_agent_profile_versions", {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  id: text("id").primaryKey(),
  profileID: text("profile_id").notNull(),
  tenantID: text("tenant_id").notNull(),
  version: integer("version").notNull(),
}, (table) => [
  check("agentbay_agent_profile_versions_version_positive", sql`${table.version} > 0`),
  uniqueIndex("agentbay_agent_profile_versions_profile_version_unique").on(table.tenantID, table.profileID, table.version),
  unique("agentbay_agent_profile_versions_id_tenant_unique").on(table.id, table.tenantID),
  index("agentbay_agent_profile_versions_tenant_profile_idx").on(table.tenantID, table.profileID),
]);

export const events = pgTable("agentbay_events", {
  data: jsonb("data").$type<unknown>().notNull(),
  dataContentType: text("data_content_type").notNull().default("application/json"),
  eventID: text("event_id").notNull(),
  eventTime: timestamp("event_time", { withTimezone: true }),
  extensions: jsonb("extensions").$type<Record<string, unknown>>().notNull().default({}),
  id: text("id").primaryKey(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  normalizationVersion: integer("normalization_version").notNull().default(1),
  rawPayloadRef: text("raw_payload_ref"),
  source: text("source").notNull(),
  sourceDeduplicationKey: text("source_deduplication_key"),
  specVersion: text("spec_version").notNull().default("1.0"),
  subject: text("subject"),
  tenantID: text("tenant_id").notNull(),
  type: text("type").notNull(),
}, (table) => [
  check("agentbay_events_normalization_version_positive", sql`${table.normalizationVersion} > 0`),
  check("agentbay_events_spec_version_1", sql`${table.specVersion} = '1.0'`),
  uniqueIndex("agentbay_events_source_event_unique").on(table.tenantID, table.source, table.eventID),
  uniqueIndex("agentbay_events_source_dedup_unique").on(table.tenantID, table.source, table.sourceDeduplicationKey),
  unique("agentbay_events_id_tenant_unique").on(table.id, table.tenantID),
  index("agentbay_events_tenant_type_ingested_idx").on(table.tenantID, table.type, table.ingestedAt),
]);

export const executions = pgTable("agentbay_executions", {
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  eventID: text("event_id").notNull(),
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  input: jsonb("input").$type<unknown>().notNull(),
  profileVersionID: text("profile_version_id").notNull(),
  requestHash: text("request_hash").notNull(),
  resolvedPolicy: jsonb("resolved_policy").$type<Record<string, unknown>>().notNull(),
  result: jsonb("result").$type<unknown>(),
  state: text("state").notNull().default("QUEUED"),
  tenantID: text("tenant_id").notNull(),
  timeoutAt: timestamp("timeout_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  workspace: jsonb("workspace").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  check("agentbay_executions_state_valid", sql`${table.state} IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED')`),
  foreignKey({
    columns: [table.eventID, table.tenantID],
    foreignColumns: [events.id, events.tenantID],
    name: "agentbay_executions_event_tenant_fk",
  }),
  foreignKey({
    columns: [table.profileVersionID, table.tenantID],
    foreignColumns: [agentProfileVersions.id, agentProfileVersions.tenantID],
    name: "agentbay_executions_profile_version_tenant_fk",
  }),
  uniqueIndex("agentbay_executions_tenant_idempotency_unique").on(table.tenantID, table.idempotencyKey),
  unique("agentbay_executions_id_tenant_unique").on(table.id, table.tenantID),
  index("agentbay_executions_tenant_state_created_idx").on(table.tenantID, table.state, table.createdAt),
  index("agentbay_executions_state_timeout_idx").on(table.state, table.timeoutAt),
]);

export const executionAttempts = pgTable("agentbay_execution_attempts", {
  attempt: integer("attempt").notNull(),
  executionID: text("execution_id").notNull(),
  fencingToken: text("fencing_token").notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseOwner: text("lease_owner"),
  opencodeSessionID: text("opencode_session_id"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  state: text("state").notNull().default("PENDING"),
  tenantID: text("tenant_id").notNull(),
  workloadName: text("workload_name"),
}, (table) => [
  primaryKey({ columns: [table.executionID, table.attempt] }),
  check("agentbay_execution_attempts_attempt_positive", sql`${table.attempt} > 0`),
  check("agentbay_execution_attempts_state_valid", sql`${table.state} IN ('PENDING', 'LEASED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')`),
  foreignKey({
    columns: [table.executionID, table.tenantID],
    foreignColumns: [executions.id, executions.tenantID],
    name: "agentbay_execution_attempts_execution_tenant_fk",
  }),
  uniqueIndex("agentbay_execution_attempts_fencing_token_unique").on(table.fencingToken),
  index("agentbay_execution_attempts_lease_idx").on(table.state, table.leaseExpiresAt),
]);

export const executionTransitions = pgTable("agentbay_execution_transitions", {
  actor: text("actor").notNull(),
  attempt: integer("attempt"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  executionID: text("execution_id").notNull(),
  fromState: text("from_state"),
  id: text("id").primaryKey(),
  reason: text("reason"),
  sequence: integer("sequence").notNull(),
  tenantID: text("tenant_id").notNull(),
  toState: text("to_state").notNull(),
  traceContext: jsonb("trace_context").$type<Record<string, string>>().notNull().default({}),
}, (table) => [
  check("agentbay_execution_transitions_attempt_positive", sql`${table.attempt} IS NULL OR ${table.attempt} > 0`),
  check("agentbay_execution_transitions_sequence_positive", sql`${table.sequence} > 0`),
  check("agentbay_execution_transitions_to_state_valid", sql`${table.toState} IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED')`),
  check("agentbay_execution_transitions_from_state_valid", sql`${table.fromState} IS NULL OR ${table.fromState} IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED')`),
  foreignKey({
    columns: [table.executionID, table.tenantID],
    foreignColumns: [executions.id, executions.tenantID],
    name: "agentbay_execution_transitions_execution_tenant_fk",
  }),
  foreignKey({
    columns: [table.executionID, table.attempt],
    foreignColumns: [executionAttempts.executionID, executionAttempts.attempt],
    name: "agentbay_execution_transitions_attempt_fk",
  }),
  uniqueIndex("agentbay_execution_transitions_sequence_unique").on(table.tenantID, table.executionID, table.sequence),
  index("agentbay_execution_transitions_execution_created_idx").on(table.executionID, table.createdAt),
]);

export const outboxEntries = pgTable("agentbay_outbox", {
  aggregateID: text("aggregate_id").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
  id: text("id").primaryKey(),
  lastError: text("last_error"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseToken: text("lease_token"),
  payload: jsonb("payload").$type<unknown>().notNull(),
  publishAttempts: integer("publish_attempts").notNull().default(0),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  tenantID: text("tenant_id").notNull(),
  topic: text("topic").notNull(),
}, (table) => [
  check("agentbay_outbox_lease_complete", sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`),
  check("agentbay_outbox_published_unleased", sql`${table.publishedAt} IS NULL OR ${table.leaseToken} IS NULL`),
  check("agentbay_outbox_publish_attempts_nonnegative", sql`${table.publishAttempts} >= 0`),
  uniqueIndex("agentbay_outbox_topic_aggregate_unique").on(table.topic, table.aggregateType, table.aggregateID),
  index("agentbay_outbox_claim_idx")
    .on(table.availableAt, table.leaseExpiresAt)
    .where(sql`${table.publishedAt} IS NULL`),
  index("agentbay_outbox_tenant_aggregate_idx").on(table.tenantID, table.aggregateType, table.aggregateID),
]);
