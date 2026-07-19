import { z } from "zod";
import { jsonPointerSchema, type JsonPrimitive } from "../json.js";
import { bindingWorkspaceSchema } from "../workspace/schema.js";

const MAX_PROMPT_BYTES = 16 * 1024;
const simpleIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
export const versionedRefSchema = z.object({ id: simpleIdSchema, version: z.number().int().positive() }).strict();
const primitiveSchema: z.ZodType<JsonPrimitive> = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);

export const filterClauseSchema = z.discriminatedUnion("op", [
  z.object({ path: jsonPointerSchema, op: z.literal("eq"), value: primitiveSchema }).strict(),
  z.object({ path: jsonPointerSchema, op: z.literal("in"), values: z.array(primitiveSchema).min(1).max(32) }).strict(),
  z.object({ path: jsonPointerSchema, op: z.literal("contains"), value: primitiveSchema }).strict(),
  z.object({ path: jsonPointerSchema, op: z.literal("containsAny"), values: z.array(primitiveSchema).min(1).max(32) }).strict(),
  z.object({ path: jsonPointerSchema, op: z.literal("exists"), value: z.boolean() }).strict(),
]);

export const afterTurnSchema = z.object({
  disposition: z.literal("wait"),
  wait: z.object({
    name: simpleIdSchema,
    correlation: z.array(z.object({ name: simpleIdSchema, path: jsonPointerSchema }).strict()).min(1).max(16)
      .refine((items) => new Set(items.map((item) => item.name)).size === items.length, "correlation names must be unique"),
    deadlineSeconds: z.number().int().min(1).max(30 * 24 * 60 * 60),
  }).strict(),
}).strict();

const eventMatchSchema = {
  schemaVersion: z.literal(1),
  eventTypes: z.array(z.string().min(1).max(255)).min(1).max(32),
  filter: z.object({ all: z.array(filterClauseSchema).max(16) }).strict(),
};

export const promptSchema = z
  .object({
    literal: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PROMPT_BYTES, `must be at most ${MAX_PROMPT_BYTES} bytes`),
    includeEvent: z.enum(["none", "data", "envelope"]),
  })
  .strict();

export const createBindingDefinitionSchema = z
  .object({
    ...eventMatchSchema,
    prompt: promptSchema,
    workspace: bindingWorkspaceSchema,
    afterTurn: afterTurnSchema.optional(),
  })
  .strict();

export const wakeBindingDefinitionSchema = z
  .object({
    ...eventMatchSchema,
    disposition: z.literal("wake"),
    wake: z.object({
      waitName: simpleIdSchema,
      correlation: z.array(z.object({ name: simpleIdSchema, path: jsonPointerSchema }).strict()).min(1).max(16)
        .refine((items) => new Set(items.map((item) => item.name)).size === items.length, "correlation names must be unique"),
      action: z.discriminatedUnion("type", [
        z.object({ type: z.literal("continue"), prompt: promptSchema, workspace: bindingWorkspaceSchema.optional() }).strict(),
        z.object({ type: z.literal("complete") }).strict(),
      ]),
    }).strict(),
  })
  .strict();

export const bindingDefinitionSchema = z.union([
  createBindingDefinitionSchema,
  wakeBindingDefinitionSchema,
]);

export const publishedBindingVersionSchema = z
  .object({
    id: simpleIdSchema,
    bindingId: simpleIdSchema,
    version: z.number().int().positive(),
    tenantId: simpleIdSchema,
    triggerId: simpleIdSchema,
    profile: versionedRefSchema,
    definition: bindingDefinitionSchema,
    enabled: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
    disabledAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export type VersionedRef = z.infer<typeof versionedRefSchema>;
export type FilterClause = z.infer<typeof filterClauseSchema>;
export type AfterTurnPolicy = z.infer<typeof afterTurnSchema>;
export type BindingDefinition = z.infer<typeof bindingDefinitionSchema>;
export type CreateBindingDefinition = z.infer<typeof createBindingDefinitionSchema>;
export type WakeBindingDefinition = z.infer<typeof wakeBindingDefinitionSchema>;
export type PublishedBindingVersion = z.infer<typeof publishedBindingVersionSchema>;

export interface BindingStore {
  publishBindingVersion(binding: PublishedBindingVersion): Promise<PublishedBindingVersion>;
  getBindingVersion(tenantId: string, bindingId: string, version: number): Promise<PublishedBindingVersion | undefined>;
  disableBindingVersion(tenantId: string, bindingId: string, version: number, disabledAt: string): Promise<PublishedBindingVersion | undefined>;
  listBindingCandidates(tenantId: string, triggerId: string, eventType: string): Promise<readonly PublishedBindingVersion[]>;
}

export function isWakeBinding(binding: PublishedBindingVersion): binding is PublishedBindingVersion & { definition: WakeBindingDefinition } {
  return "disposition" in binding.definition && binding.definition.disposition === "wake";
}

export class BindingVersionAlreadyExistsError extends Error {
  readonly code = "BINDING_VERSION_ALREADY_EXISTS";

  constructor(bindingId: string, version: number) {
    super(`Binding ${bindingId} version ${version} already exists`);
    this.name = "BindingVersionAlreadyExistsError";
  }
}

export class BindingVersionNotFoundError extends Error {
  readonly code = "BINDING_VERSION_NOT_FOUND";

  constructor(bindingId: string, version: number) {
    super(`Binding ${bindingId} version ${version} was not found`);
    this.name = "BindingVersionNotFoundError";
  }
}
