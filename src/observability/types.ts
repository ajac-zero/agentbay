export type ObservabilitySnapshotRow = {
  kind: "active_workloads" | "checkpoint_age" | "execution_oldest_active_age" | "execution_overdue" | "execution_state" | "outbox_pending" | "revision_pending" | "schedule_lateness";
  tenantId: string;
  label: string;
  value: number;
  secondaryValue?: number;
};

export type ObservabilitySnapshot = {
  collectedAt: Date;
  rows: ObservabilitySnapshotRow[];
};

export interface ObservabilityStore {
  collectObservabilitySnapshot(signal?: AbortSignal): Promise<ObservabilitySnapshot>;
}
