import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { logger } from "../logger.js";
import type { ObservabilitySnapshot, ObservabilityStore } from "./types.js";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ prefix: "agentbay_process_", register: metricsRegistry });

export const eventsAdmitted = new Counter({
  name: "agentbay_events_admitted_total",
  help: "Normalized events admitted by trigger and event type.",
  labelNames: ["tenant", "trigger_id", "event_type"] as const,
  registers: [metricsRegistry],
});
export const executionsCreated = new Counter({
  name: "agentbay_executions_created_total",
  help: "Executions created by binding and profile.",
  labelNames: ["tenant", "binding_id", "profile_id"] as const,
  registers: [metricsRegistry],
});
export const executionOutcomes = new Counter({
  name: "agentbay_execution_outcomes_total",
  help: "Terminal execution outcomes by profile.",
  labelNames: ["tenant", "profile_id", "result"] as const,
  registers: [metricsRegistry],
});
export const executionDuration = new Histogram({
  name: "agentbay_execution_duration_seconds",
  help: "Execution duration from creation to terminal outcome.",
  labelNames: ["tenant", "profile_id", "result"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200],
  registers: [metricsRegistry],
});
export const sandboxProvisionDuration = new Histogram({
  name: "agentbay_sandbox_provision_duration_seconds",
  help: "Sandbox provisioning duration by profile and result.",
  labelNames: ["tenant", "profile_id", "result"] as const,
  buckets: [1, 2, 5, 10, 20, 30, 60, 120, 180, 300],
  registers: [metricsRegistry],
});
export const sandboxClaims = new Counter({
  name: "agentbay_sandbox_claims_total",
  help: "SandboxClaim lifecycle operations.",
  labelNames: ["tenant", "profile_id", "operation", "result"] as const,
  registers: [metricsRegistry],
});
export const outboxAttempts = new Counter({
  name: "agentbay_outbox_publish_attempts_total",
  help: "Outbox publication attempts by topic and result.",
  labelNames: ["topic", "result"] as const,
  registers: [metricsRegistry],
});
export const outboxPublishDuration = new Histogram({
  name: "agentbay_outbox_publish_duration_seconds",
  help: "Outbox transport publication duration by topic and result.",
  labelNames: ["topic", "result"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [metricsRegistry],
});
export const scheduleOccurrences = new Counter({
  name: "agentbay_schedule_occurrences_total",
  help: "Schedule occurrence processing outcomes.",
  labelNames: ["tenant", "trigger_id", "result"] as const,
  registers: [metricsRegistry],
});
export const scheduleAdmissionDelay = new Histogram({
  name: "agentbay_schedule_admission_delay_seconds",
  help: "Delay between scheduled time and event admission.",
  labelNames: ["tenant", "trigger_id"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
  registers: [metricsRegistry],
});
export const checkpointAdvances = new Counter({
  name: "agentbay_checkpoint_advances_total",
  help: "Checkpoint compare-and-set outcomes by binding.",
  labelNames: ["tenant", "binding_id", "result"] as const,
  registers: [metricsRegistry],
});
export const revisionResolutions = new Counter({
  name: "agentbay_revision_resolutions_total",
  help: "Revision resolution outcomes by provider.",
  labelNames: ["tenant", "provider", "result"] as const,
  registers: [metricsRegistry],
});
export const githubEffects = new Counter({
  name: "agentbay_github_effects_total",
  help: "GitHub effect lifecycle outcomes.",
  labelNames: ["tenant", "effect_type", "result"] as const,
  registers: [metricsRegistry],
});
export const workerLoopFailures = new Counter({
  name: "agentbay_worker_loop_failures_total",
  help: "Unexpected worker loop failures by component.",
  labelNames: ["component"] as const,
  registers: [metricsRegistry],
});

let databaseCollect = async (): Promise<void> => {};
const collectDatabase = () => databaseCollect();
const executions = new Gauge({ name: "agentbay_executions", help: "Current executions by durable state.", labelNames: ["tenant", "state"] as const, collect: collectDatabase, registers: [metricsRegistry] });
const oldestActiveExecution = new Gauge({ name: "agentbay_execution_oldest_active_age_seconds", help: "Age of the oldest active execution.", labelNames: ["tenant"] as const, collect: collectDatabase, registers: [metricsRegistry] });
const overdueExecutions = new Gauge({ name: "agentbay_executions_overdue", help: "Active executions past their persisted timeout.", labelNames: ["tenant"] as const, collect: collectDatabase, registers: [metricsRegistry] });
const pendingOutbox = new Gauge({ name: "agentbay_outbox_pending", help: "Pending outbox messages by topic.", labelNames: ["tenant", "topic"] as const, collect: collectDatabase, registers: [metricsRegistry] });
const oldestPendingOutbox = new Gauge({ name: "agentbay_outbox_oldest_pending_age_seconds", help: "Age of the oldest pending outbox message by topic.", labelNames: ["tenant", "topic"] as const, collect: collectDatabase, registers: [metricsRegistry] });
const scheduleLateness = new Gauge({ name: "agentbay_schedule_next_fire_delay_seconds", help: "Seconds an enabled schedule is past its next expected fire time.", labelNames: ["tenant", "trigger_id"] as const, collect: collectDatabase, registers: [metricsRegistry] });
const scheduleMissedIntervals = new Gauge({ name: "agentbay_schedule_missed_intervals", help: "Expected schedule intervals elapsed since next_fire_at.", labelNames: ["tenant", "trigger_id"] as const, collect: collectDatabase, registers: [metricsRegistry] });
const checkpointAge = new Gauge({ name: "agentbay_checkpoint_age_seconds", help: "Age of the oldest checkpoint for a binding.", labelNames: ["tenant", "binding_id"] as const, collect: collectDatabase, registers: [metricsRegistry] });
const activeWorkloads = new Gauge({ name: "agentbay_sandbox_claims_active", help: "Durably owned active SandboxClaim workloads.", labelNames: ["tenant"] as const, collect: collectDatabase, registers: [metricsRegistry] });
const pendingRevisions = new Gauge({ name: "agentbay_revision_resolutions_pending", help: "Pending or retrying revision resolutions.", labelNames: ["tenant"] as const, collect: collectDatabase, registers: [metricsRegistry] });
const collectorUp = new Gauge({ name: "agentbay_observability_collector_up", help: "Whether the last PostgreSQL observability collection succeeded.", collect: collectDatabase, registers: [metricsRegistry] });
const snapshotAge = new Gauge({ name: "agentbay_observability_snapshot_age_seconds", help: "Age of the last successful PostgreSQL observability snapshot.", collect: collectDatabase, registers: [metricsRegistry] });

const dynamicGauges = [executions, oldestActiveExecution, overdueExecutions, pendingOutbox, oldestPendingOutbox, scheduleLateness, scheduleMissedIntervals, checkpointAge, activeWorkloads, pendingRevisions];

export function registerDatabaseMetrics(store: ObservabilityStore, options: { cacheMilliseconds?: number; timeoutMilliseconds?: number } = {}): void {
  const cacheMilliseconds = options.cacheMilliseconds ?? 5_000;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 2_000;
  let snapshot: ObservabilitySnapshot | undefined;
  let attemptedAt = 0;
  let collecting: Promise<void> | undefined;

  collectorUp.set(0);
  databaseCollect = async () => {
    if (collecting) await collecting;
    if (Date.now() - attemptedAt >= cacheMilliseconds) {
      attemptedAt = Date.now();
      collecting ??= store.collectObservabilitySnapshot(AbortSignal.timeout(timeoutMilliseconds))
        .then((next) => {
          snapshot = next;
          collectorUp.set(1);
        })
        .catch((error: unknown) => {
          collectorUp.set(0);
          logger.warn("observability database collection failed", { component: "observability", errorCode: "OBSERVABILITY_DATABASE_COLLECTION_FAILED", error: String(error) });
        })
        .finally(() => { collecting = undefined; });
      await collecting;
    }
    if (!snapshot) return;
    for (const gauge of dynamicGauges) gauge.reset();
    applySnapshot(snapshot);
    snapshotAge.set(Math.max(0, (Date.now() - snapshot.collectedAt.getTime()) / 1_000));
  };
}

export async function databaseMetricsTextForTest(store: ObservabilityStore): Promise<string> {
  registerDatabaseMetrics(store, { cacheMilliseconds: 60_000, timeoutMilliseconds: 1_000 });
  return metricsRegistry.metrics();
}

function applySnapshot(snapshot: ObservabilitySnapshot): void {
  for (const row of snapshot.rows) {
    if (row.kind === "execution_state") executions.set({ tenant: row.tenantId, state: row.label }, row.value);
    else if (row.kind === "execution_oldest_active_age") oldestActiveExecution.set({ tenant: row.tenantId }, row.value);
    else if (row.kind === "execution_overdue") overdueExecutions.set({ tenant: row.tenantId }, row.value);
    else if (row.kind === "outbox_pending") {
      pendingOutbox.set({ tenant: row.tenantId, topic: row.label }, row.value);
      oldestPendingOutbox.set({ tenant: row.tenantId, topic: row.label }, row.secondaryValue ?? 0);
    } else if (row.kind === "schedule_lateness") {
      scheduleLateness.set({ tenant: row.tenantId, trigger_id: row.label }, row.value);
      scheduleMissedIntervals.set({ tenant: row.tenantId, trigger_id: row.label }, row.secondaryValue ?? 0);
    }
    else if (row.kind === "checkpoint_age") checkpointAge.set({ tenant: row.tenantId, binding_id: row.label }, row.value);
    else if (row.kind === "active_workloads") activeWorkloads.set({ tenant: row.tenantId }, row.value);
    else if (row.kind === "revision_pending") pendingRevisions.set({ tenant: row.tenantId }, row.value);
  }
}
