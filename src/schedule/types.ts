export type ScheduleCronTriggerConfig = {
  schemaVersion: 1;
  expression: string;
  timezone: "UTC";
  misfirePolicy: "skip";
  repository: { installationId: number; id: number; fullName: string; defaultBranch: string };
};

export type ClaimedScheduleOccurrence = {
  id: string;
  tenantId: string;
  triggerId: string;
  scheduledAt: string;
  leaseOwner: string;
  leaseToken: string;
  attempt: number;
  config: ScheduleCronTriggerConfig;
};

export interface ScheduleStore {
  materializeDueScheduleOccurrences(input: { now: string; limit: number }): Promise<number>;
  claimScheduleOccurrence(input: { leaseOwner: string; leaseDurationMs: number }): Promise<ClaimedScheduleOccurrence | undefined>;
  completeScheduleOccurrence(input: { id: string; leaseOwner: string; leaseToken: string; completedAt: string }): Promise<boolean>;
  failScheduleOccurrence(input: {
    id: string; leaseOwner: string; leaseToken: string; error: string; failedAt: string; retryAt: string; maxAttempts: number;
  }): Promise<boolean>;
}
