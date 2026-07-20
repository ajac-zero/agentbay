import { randomUUID } from "node:crypto";
import { hashCanonicalJson, type JsonValue } from "../json.js";
import { logger } from "../logger.js";
import type { EventAdmissionStore } from "../execution/store.js";
import type { ScheduleStore } from "./types.js";
import type { ScheduleCronTriggerConfig } from "./types.js";

export class ScheduleWorker {
  constructor(private readonly options: {
    store: ScheduleStore & EventAdmissionStore;
    workerId: string;
    leaseDurationMs: number;
    idlePollMs: number;
    retryDelayMs: number;
    maxAttempts: number;
    materializeBatchSize: number;
  }) {}

  async runOne(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const now = new Date();
    const materialized = await this.options.store.materializeDueScheduleOccurrences({ now: now.toISOString(), limit: this.options.materializeBatchSize });
    const occurrence = await this.options.store.claimScheduleOccurrence({ leaseOwner: this.options.workerId, leaseDurationMs: this.options.leaseDurationMs });
    if (!occurrence) return materialized > 0;
    try {
      const repository = occurrence.config.repository;
      const cloneUrl = `https://github.com/${repository.fullName}.git`;
      const event = {
        specversion: "1.0" as const,
        id: occurrence.id,
        source: `urn:agentbay:schedule:${occurrence.triggerId}`,
        type: "dev.agentbay.schedule.triggered",
        subject: `schedules/${occurrence.triggerId}`,
        time: occurrence.scheduledAt,
        datacontenttype: "application/json" as const,
        data: {
          schemaVersion: 1,
          scheduleId: occurrence.triggerId,
          occurrenceId: occurrence.id,
          scheduledAt: occurrence.scheduledAt,
          repository: {
            id: repository.id,
            fullName: repository.fullName,
            cloneUrl,
            defaultBranch: repository.defaultBranch,
          },
        },
      };
      await this.options.store.admitEvent({
        tenantId: occurrence.tenantId,
        triggerId: occurrence.triggerId,
        internalEventId: occurrence.id,
        event,
        sourceDeduplicationKey: `schedule:${occurrence.triggerId}:${occurrence.scheduledAt}`,
        admissionHash: hashCanonicalJson({ schemaVersion: 1, triggerId: occurrence.triggerId, event } as JsonValue),
        admittedAt: new Date().toISOString(),
        revisionResolution: {
          provider: "github",
          installationId: repository.installationId,
          repositoryId: repository.id,
          repositoryFullName: repository.fullName,
          cloneUrl,
          branch: repository.defaultBranch,
        },
      });
      await this.options.store.completeScheduleOccurrence({ id: occurrence.id, leaseOwner: occurrence.leaseOwner, leaseToken: occurrence.leaseToken, completedAt: new Date().toISOString() });
    } catch (error) {
      if (signal?.aborted) throw error;
      const failedAt = new Date();
      await this.options.store.failScheduleOccurrence({
        id: occurrence.id,
        leaseOwner: occurrence.leaseOwner,
        leaseToken: occurrence.leaseToken,
        error: String(error).slice(0, 2_048),
        failedAt: failedAt.toISOString(),
        retryAt: new Date(failedAt.getTime() + this.options.retryDelayMs).toISOString(),
        maxAttempts: this.options.maxAttempts,
      });
    }
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let worked = false;
      try { worked = await this.runOne(signal); }
      catch (error) { if (signal.aborted) break; logger.error("schedule worker iteration failed", { error: String(error) }); }
      if (!worked && !signal.aborted) await delay(this.options.idlePollMs, signal);
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
