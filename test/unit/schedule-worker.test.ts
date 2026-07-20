import { describe, expect, it } from "vitest";
import type { AdmissionCommand, AdmissionResult } from "../../src/control/admission.js";
import { ScheduleWorker } from "../../src/schedule/worker.js";
import type { ClaimedScheduleOccurrence, ScheduleStore } from "../../src/schedule/types.js";
import type { EventAdmissionStore } from "../../src/execution/store.js";

describe("ScheduleWorker", () => {
  it("admits one exact-repository occurrence and completes its lease", async () => {
    const store = new FakeScheduleStore(occurrence());
    expect(await worker(store).runOne()).toBe(true);
    expect(store.admission).toMatchObject({
      tenantId: "default",
      triggerId: "hourly-bug-finder",
      internalEventId: "occurrence-1",
      sourceDeduplicationKey: "schedule:hourly-bug-finder:2026-07-20T18:17:00.000Z",
      event: {
        id: "occurrence-1",
        source: "urn:agentbay:schedule:hourly-bug-finder",
        type: "dev.agentbay.schedule.triggered",
        subject: "schedules/hourly-bug-finder",
        data: { repository: { id: 20, fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", defaultBranch: "main" } },
      },
      revisionResolution: {
        provider: "github", installationId: 10, repositoryId: 20, repositoryFullName: "acme/widgets",
        cloneUrl: "https://github.com/acme/widgets.git", branch: "main",
      },
    });
    expect(store.completed).toEqual(["occurrence-1"]);
    expect(store.failed).toEqual([]);
  });

  it("leases the same durable occurrence for retry when admission fails", async () => {
    const store = new FakeScheduleStore(occurrence());
    store.admissionError = new Error("temporary");
    expect(await worker(store).runOne()).toBe(true);
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual(["occurrence-1"]);
  });
});

function worker(store: FakeScheduleStore) {
  return new ScheduleWorker({ store, workerId: "worker-1", leaseDurationMs: 60_000, idlePollMs: 10,
    retryDelayMs: 30_000, maxAttempts: 5, materializeBatchSize: 100 });
}

function occurrence(): ClaimedScheduleOccurrence {
  return {
    id: "occurrence-1", tenantId: "default", triggerId: "hourly-bug-finder", scheduledAt: "2026-07-20T18:17:00.000Z",
    leaseOwner: "worker-1", leaseToken: "lease-1", attempt: 1,
    config: { schemaVersion: 1, expression: "17 * * * *", timezone: "UTC", misfirePolicy: "skip",
      repository: { installationId: 10, id: 20, fullName: "acme/widgets", defaultBranch: "main" } },
  };
}

class FakeScheduleStore implements ScheduleStore, EventAdmissionStore {
  admission?: AdmissionCommand & Record<string, unknown>;
  admissionError?: Error;
  completed: string[] = [];
  failed: string[] = [];
  constructor(private claimed?: ClaimedScheduleOccurrence) {}
  async materializeDueScheduleOccurrences() { return 0; }
  async claimScheduleOccurrence() { const value = this.claimed; this.claimed = undefined; return value; }
  async completeScheduleOccurrence(input: { id: string }) { this.completed.push(input.id); return true; }
  async failScheduleOccurrence(input: { id: string }) { this.failed.push(input.id); return true; }
  async admitEvent(command: AdmissionCommand): Promise<AdmissionResult> {
    if (this.admissionError) throw this.admissionError;
    this.admission = command;
    return { event: { id: command.internalEventId, tenantId: command.tenantId, triggerId: command.triggerId,
      source: command.event.source, eventId: command.event.id, type: command.event.type,
      sourceDeduplicationKey: command.sourceDeduplicationKey, admissionHash: command.admissionHash, admittedAt: command.admittedAt },
      executions: [], wakes: [], pendingWakes: [], replayed: false };
  }
}
