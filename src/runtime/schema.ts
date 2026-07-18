import { sql } from "drizzle-orm";
import type { BindingDefinition, TriggerConfig, TriggerDefinition } from "../control/types.js";
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

export const agentProfileVersions = pgTable("agentbay_agent_profile_versions", {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  definition: jsonb("definition").$type<import("../execution/types.js").AgentProfileDefinition>().notNull(),
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

export const triggers = pgTable("agentbay_triggers", {
  config: jsonb("config").$type<TriggerConfig>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true),
  id: text("id").primaryKey(),
  tenantID: text("tenant_id").notNull(),
  type: text("type").$type<TriggerDefinition["type"]>().notNull(),
}, (table) => [
  check("agentbay_triggers_enabled_lifecycle_consistent", sql`${table.enabled} = (${table.disabledAt} IS NULL)`),
  unique("agentbay_triggers_id_tenant_unique").on(table.id, table.tenantID),
  index("agentbay_triggers_tenant_type_enabled_idx").on(table.tenantID, table.type, table.enabled),
]);

export const bindingVersions = pgTable("agentbay_binding_versions", {
  bindingID: text("binding_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  definition: jsonb("definition").$type<Pick<BindingDefinition, "schemaVersion" | "filter" | "prompt" | "workspace">>().notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true),
  eventTypes: text("event_types").array().notNull(),
  id: text("id").primaryKey(),
  profileVersionID: text("profile_version_id").notNull(),
  tenantID: text("tenant_id").notNull(),
  triggerID: text("trigger_id").notNull(),
  version: integer("version").notNull(),
}, (table) => [
  check("agentbay_binding_versions_version_positive", sql`${table.version} > 0`),
  check("agentbay_binding_versions_event_types_nonempty", sql`cardinality(${table.eventTypes}) > 0`),
  check(
    "agentbay_binding_versions_enabled_lifecycle_consistent",
    sql`${table.enabled} = (${table.disabledAt} IS NULL)`,
  ),
  foreignKey({
    columns: [table.triggerID, table.tenantID],
    foreignColumns: [triggers.id, triggers.tenantID],
    name: "agentbay_binding_versions_trigger_tenant_fk",
  }),
  foreignKey({
    columns: [table.profileVersionID, table.tenantID],
    foreignColumns: [agentProfileVersions.id, agentProfileVersions.tenantID],
    name: "agentbay_binding_versions_profile_version_tenant_fk",
  }),
  uniqueIndex("agentbay_binding_versions_binding_version_unique").on(table.tenantID, table.bindingID, table.version),
  uniqueIndex("agentbay_binding_versions_one_enabled_unique")
    .on(table.tenantID, table.bindingID)
    .where(sql`${table.enabled}`),
  unique("agentbay_binding_versions_id_tenant_unique").on(table.id, table.tenantID),
  index("agentbay_binding_versions_match_idx").on(table.tenantID, table.triggerID, table.enabled),
]);

export const events = pgTable("agentbay_events", {
  admissionHash: text("admission_hash").notNull(),
  data: jsonb("data").$type<unknown>().notNull(),
  dataContentType: text("data_content_type").notNull().default("application/json"),
  dataSchema: text("data_schema"),
  eventID: text("event_id").notNull(),
  eventTime: timestamp("event_time", { withTimezone: true }),
  extensions: jsonb("extensions").$type<Record<string, unknown>>().notNull().default({}),
  id: text("id").primaryKey(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  normalizationVersion: integer("normalization_version").notNull().default(1),
  rawPayloadRef: text("raw_payload_ref"),
  source: text("source").notNull(),
  sourceDeduplicationKey: text("source_deduplication_key").notNull(),
  specVersion: text("spec_version").notNull().default("1.0"),
  subject: text("subject"),
  tenantID: text("tenant_id").notNull(),
  triggerID: text("trigger_id").notNull(),
  type: text("type").notNull(),
}, (table) => [
  check("agentbay_events_normalization_version_positive", sql`${table.normalizationVersion} > 0`),
  check("agentbay_events_spec_version_1", sql`${table.specVersion} = '1.0'`),
  foreignKey({
    columns: [table.triggerID, table.tenantID],
    foreignColumns: [triggers.id, triggers.tenantID],
    name: "agentbay_events_trigger_tenant_fk",
  }),
  uniqueIndex("agentbay_events_trigger_source_event_unique").on(table.tenantID, table.triggerID, table.source, table.eventID),
  uniqueIndex("agentbay_events_trigger_source_dedup_unique").on(table.tenantID, table.triggerID, table.sourceDeduplicationKey),
  unique("agentbay_events_id_tenant_unique").on(table.id, table.tenantID),
  index("agentbay_events_tenant_trigger_ingested_idx").on(table.tenantID, table.triggerID, table.ingestedAt),
  index("agentbay_events_tenant_type_ingested_idx").on(table.tenantID, table.type, table.ingestedAt),
]);

export const executions = pgTable("agentbay_executions", {
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  bindingVersionID: text("binding_version_id").notNull(),
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
  workspace: jsonb("workspace").$type<import("../workspace/types.js").ResolvedWorkspace>().notNull().default({ type: "empty" }),
}, (table) => [
  check("agentbay_executions_state_valid", sql`${table.state} IN ('RECEIVED', 'PLANNED', 'QUEUED', 'PROVISIONING', 'RUNNING', 'SUCCEEDED', 'DELIVERING', 'COMPLETED', 'RETRY_WAIT', 'AWAITING_APPROVAL', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'DEAD_LETTERED')`),
  foreignKey({
    columns: [table.bindingVersionID, table.tenantID],
    foreignColumns: [bindingVersions.id, bindingVersions.tenantID],
    name: "agentbay_executions_binding_version_tenant_fk",
  }),
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
  uniqueIndex("agentbay_executions_tenant_event_binding_unique").on(table.tenantID, table.eventID, table.bindingVersionID),
  unique("agentbay_executions_id_tenant_unique").on(table.id, table.tenantID),
  index("agentbay_executions_tenant_binding_created_idx").on(table.tenantID, table.bindingVersionID, table.createdAt),
  index("agentbay_executions_tenant_event_idx").on(table.tenantID, table.eventID),
  index("agentbay_executions_tenant_state_created_idx").on(table.tenantID, table.state, table.createdAt),
  index("agentbay_executions_state_timeout_idx").on(table.state, table.timeoutAt),
  index("agentbay_executions_dispatch_idx")
    .on(table.availableAt, table.createdAt, table.id)
    .where(sql`${table.state} = 'QUEUED'`),
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
  check(
    "agentbay_execution_attempts_active_lease_consistent",
    sql`(${table.leaseOwner} IS NULL) = (${table.leaseExpiresAt} IS NULL) AND (${table.state} IN ('LEASED', 'RUNNING')) = (${table.leaseOwner} IS NOT NULL)`,
  ),
  check(
    "agentbay_execution_attempts_terminal_consistent",
    sql`(${table.state} IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')) = (${table.finishedAt} IS NOT NULL)`,
  ),
  foreignKey({
    columns: [table.executionID, table.tenantID],
    foreignColumns: [executions.id, executions.tenantID],
    name: "agentbay_execution_attempts_execution_tenant_fk",
  }),
  uniqueIndex("agentbay_execution_attempts_fencing_token_unique").on(table.fencingToken),
  uniqueIndex("agentbay_execution_attempts_one_active_unique")
    .on(table.executionID)
    .where(sql`${table.state} IN ('LEASED', 'RUNNING')`),
  index("agentbay_execution_attempts_expired_active_lease_idx")
    .on(table.leaseExpiresAt, table.executionID)
    .where(sql`${table.state} IN ('LEASED', 'RUNNING')`),
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
