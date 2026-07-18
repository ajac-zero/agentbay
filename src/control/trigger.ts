import { z } from "zod";

export const triggerConfigSchema = z.object({ schemaVersion: z.literal(1) }).strict();

export const triggerSchema = z
  .object({
    id: z.string().min(1).max(128),
    tenantId: z.string().min(1).max(128),
    type: z.literal("cloudevents.http"),
    config: triggerConfigSchema,
    enabled: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
    disabledAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

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
