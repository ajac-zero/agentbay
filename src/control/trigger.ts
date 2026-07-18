import { z } from "zod";

export const cloudEventsHttpTriggerConfigSchema = z.object({ schemaVersion: z.literal(1) }).strict();
export const githubAppWebhookTriggerConfigSchema = z.object({
  schemaVersion: z.literal(1),
  webhookSecretEnv: z.string().regex(/^AGENTBAY_GITHUB_WEBHOOK_SECRET_[A-Z0-9_]{1,96}$/),
}).strict();
export const triggerConfigSchema = z.union([
  cloudEventsHttpTriggerConfigSchema,
  githubAppWebhookTriggerConfigSchema,
]);

const triggerFields = {
  id: z.string().min(1).max(128),
  tenantId: z.string().min(1).max(128),
  enabled: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  disabledAt: z.iso.datetime({ offset: true }).nullable(),
};

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({
    ...triggerFields,
    type: z.literal("cloudevents.http"),
    config: cloudEventsHttpTriggerConfigSchema,
  }).strict(),
  z.object({
    ...triggerFields,
    type: z.literal("github.app.webhook"),
    config: githubAppWebhookTriggerConfigSchema,
  }).strict(),
]);

export type TriggerConfig = z.infer<typeof triggerConfigSchema>;
export type Trigger = z.infer<typeof triggerSchema>;

export interface TriggerStore {
  createTrigger(trigger: Trigger): Promise<Trigger>;
  getTrigger(tenantId: string, triggerId: string): Promise<Trigger | undefined>;
  disableTrigger(tenantId: string, triggerId: string, disabledAt: string): Promise<Trigger | undefined>;
}

export class TriggerAlreadyExistsError extends Error {
  readonly code = "TRIGGER_ALREADY_EXISTS";

  constructor(triggerId: string) {
    super(`Trigger ${triggerId} already exists`);
    this.name = "TriggerAlreadyExistsError";
  }
}

export class TriggerNotFoundError extends Error {
  readonly code = "TRIGGER_NOT_FOUND";

  constructor(triggerId: string) {
    super(`Trigger ${triggerId} was not found`);
    this.name = "TriggerNotFoundError";
  }
}
