import { describe, expect, it, vi } from "vitest";
import { databaseMetricsTextForTest } from "../../src/observability/metrics.js";
import type { ObservabilityStore } from "../../src/observability/types.js";

describe("observability metrics", () => {
  it("renders bounded durable-state gauges from one cached snapshot", async () => {
    const store: ObservabilityStore = {
      collectObservabilitySnapshot: vi.fn().mockResolvedValue({
        collectedAt: new Date(),
        rows: [
          { kind: "execution_state", tenantId: "default", label: "RUNNING", value: 2 },
          { kind: "outbox_pending", tenantId: "default", label: "execution.requested", value: 1, secondaryValue: 42 },
          { kind: "execution_overdue", tenantId: "default", label: "", value: 1 },
        ],
      }),
    };
    const text = await databaseMetricsTextForTest(store);
    expect(text).toContain('agentbay_executions{tenant="default",state="RUNNING"} 2');
    expect(text).toContain('agentbay_outbox_oldest_pending_age_seconds{tenant="default",topic="execution.requested"} 42');
    expect(text).toContain('agentbay_executions_overdue{tenant="default"} 1');
    expect(store.collectObservabilitySnapshot).toHaveBeenCalledTimes(1);
  });
});
