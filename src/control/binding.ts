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
  z.object({ path: jsonPointerSchema, op: z.literal("exists"), value: z.boolean() }).strict(),
]);

export const bindingDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventTypes: z.array(z.string().min(1).max(255)).min(1).max(32),
    filter: z.object({ all: z.array(filterClauseSchema).max(16) }).strict(),
    prompt: z
      .object({
        literal: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PROMPT_BYTES, `must be at most ${MAX_PROMPT_BYTES} bytes`),
        includeEvent: z.enum(["none", "data", "envelope"]),
      })
      .strict(),
    workspace: bindingWorkspaceSchema,
  })
  .strict();

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
export type BindingDefinition = z.infer<typeof bindingDefinitionSchema>;
export type PublishedBindingVersion = z.infer<typeof publishedBindingVersionSchema>;

export interface BindingStore {
  publishBindingVersion(binding: PublishedBindingVersion): Promise<PublishedBindingVersion>;
  getBindingVersion(tenantId: string, bindingId: string, version: number): Promise<PublishedBindingVersion | undefined>;
  disableBindingVersion(tenantId: string, bindingId: string, version: number, disabledAt: string): Promise<PublishedBindingVersion | undefined>;
  listBindingCandidates(tenantId: string, triggerId: string, eventType: string): Promise<readonly PublishedBindingVersion[]>;
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
