import { z } from "zod";
import { cronExpressionSchema } from "../schedule/cron.js";

export const cloudEventsHttpTriggerConfigSchema = z.object({ schemaVersion: z.literal(1) }).strict();
export const githubAppWebhookTriggerConfigSchema = z.object({
  schemaVersion: z.literal(1),
  webhookSecretEnv: z.string().regex(/^AGENTBAY_GITHUB_WEBHOOK_SECRET_[A-Z0-9_]{1,96}$/),
}).strict();
export const scheduleCronTriggerConfigSchema = z.object({
  schemaVersion: z.literal(1),
  expression: cronExpressionSchema,
  timezone: z.literal("UTC"),
  misfirePolicy: z.literal("skip"),
  repository: z.object({
    installationId: z.number().int().positive(),
    id: z.number().int().positive(),
    fullName: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/),
    defaultBranch: z.string().min(1).max(255),
  }).strict(),
}).strict();
export const triggerConfigSchema = z.union([
  cloudEventsHttpTriggerConfigSchema,
  githubAppWebhookTriggerConfigSchema,
  scheduleCronTriggerConfigSchema,
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
  z.object({
    ...triggerFields,
    type: z.literal("schedule.cron"),
    config: scheduleCronTriggerConfigSchema,
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
