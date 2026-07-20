export type OutboxMessage = {
  id: string;
  tenantId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  headers: Readonly<Record<string, string>>;
  createdAt: Date;
  availableAt: Date;
  publishAttempts: number;
};

export type ClaimedOutboxMessage = OutboxMessage & {
  claimToken: string;
  claimExpiresAt: Date;
};

export type OutboxEnvelope = {
  id: string;
  tenantId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  headers: Readonly<Record<string, string>>;
  createdAt: string;
};

export interface OutboxStore {
  claimAvailable(input: {
    claimToken: string;
    limit: number;
    leaseDurationMs: number;
    topics?: readonly string[];
    signal?: AbortSignal;
  }): Promise<ClaimedOutboxMessage[]>;

  markPublished(input: {
    id: string;
    claimToken: string;
  }): Promise<boolean>;

  markFailed(input: {
    id: string;
    claimToken: string;
    error: string;
    retryDelayMs: number;
  }): Promise<boolean>;
}

export interface OutboxTransport {
  publish(envelope: Readonly<OutboxEnvelope>, options: { signal: AbortSignal }): Promise<void>;
}
