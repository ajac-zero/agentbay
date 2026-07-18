import { createRoute, z } from "@hono/zod-openapi";
import { EXECUTION_STATES } from "./states.js";
import type { AgentProfileDefinition, ExecutionInput, JsonObject } from "./types.js";

export const simpleIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, "must contain only letters, numbers, '.', '_', or '-' and start and end with a letter or number");
export const versionSchema = z.coerce.number().int().positive();
const MAX_JSON_BYTES = 128 * 1024;
const boundedJsonObjectSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_JSON_BYTES, `must be at most ${MAX_JSON_BYTES} bytes`) as z.ZodType<JsonObject>;
const dnsLabelSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/, "must be a valid DNS label");

export const agentProfileDefinitionSchema: z.ZodType<AgentProfileDefinition> = z
  .object({
    schemaVersion: z.literal(1),
    runtime: z
      .object({
        type: z.literal("opencode"),
        agent: z.string().min(1).max(128),
        opencodeConfig: boundedJsonObjectSchema,
      })
      .strict(),
    sandbox: z
      .object({
        templateName: dnsLabelSchema,
        warmPool: dnsLabelSchema.default("none"),
      })
      .strict(),
    permissions: z.object({ onRequest: z.literal("fail") }).strict(),
    timeoutSeconds: z.number().int().min(1).max(86_400),
    retention: z
      .object({ sandboxSecondsAfterFinished: z.number().int().min(0).max(86_400).default(0) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    const agents = definition.runtime.opencodeConfig.agent;
    if (!agents || typeof agents !== "object" || Array.isArray(agents) || !(definition.runtime.agent in agents)) {
      context.addIssue({
        code: "custom",
        message: `opencodeConfig.agent must define selected agent ${definition.runtime.agent}`,
        path: ["runtime", "opencodeConfig", "agent"],
      });
    }
  });
export const definitionSchema = agentProfileDefinitionSchema;
export const profileRefSchema = z.object({ id: simpleIdSchema, version: z.number().int().positive() }).strict();
export const executionInputSchema = z
  .object({
    text: z.string().min(1).max(65_536),
    context: boundedJsonObjectSchema.optional(),
  })
  .strict() as z.ZodType<ExecutionInput>;
export const workspaceSchema = z.object({ type: z.literal("empty") }).strict();

export const publishProfileVersionBodySchema = z
  .object({
    version: z.number().int().positive(),
    definition: definitionSchema,
  })
  .strict();

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");

export const profileVersionSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    profile: profileRefSchema,
    definition: definitionSchema,
    createdAt: z.string().datetime(),
  })
  .strict()
  .openapi("AgentProfileVersion");

export const executionSchema = z
  .object({
    id: z.string(),
    binding: profileRefSchema,
    tenantId: z.string(),
    state: z.enum(EXECUTION_STATES),
    profile: profileRefSchema,
    input: executionInputSchema,
    workspace: workspaceSchema,
    eventId: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    result: z.unknown().nullable(),
  })
  .strict()
  .openapi("Execution");

export const executionErrorSchema = z.object({ error: z.string().min(1) }).strict().openapi("ExecutionError");

const profileParams = z.object({ profileID: simpleIdSchema, version: versionSchema });
const executionParams = z.object({ id: z.string().min(1).max(255).regex(/^[^/]+$/) });
const securedErrors = {
  400: jsonResponse("Invalid request.", executionErrorSchema),
  401: jsonResponse("Missing or invalid bearer token.", executionErrorSchema),
  413: jsonResponse("Request body too large.", executionErrorSchema),
  500: jsonResponse("Internal server error.", executionErrorSchema),
};

export const publishProfileVersionRoute = createRoute({
  method: "post",
  path: "/agent-profiles/{profileID}/versions",
  tags: ["executions"],
  summary: "Publish an immutable agent profile version",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ profileID: simpleIdSchema }),
    body: { required: true, content: { "application/json": { schema: publishProfileVersionBodySchema } } },
  },
  responses: {
    201: jsonResponse("Profile version published.", profileVersionSchema),
    ...securedErrors,
    409: jsonResponse("Profile version already exists.", executionErrorSchema),
  },
});

export const getProfileVersionRoute = createRoute({
  method: "get",
  path: "/agent-profiles/{profileID}/versions/{version}",
  tags: ["executions"],
  summary: "Read an exact agent profile version",
  security: [{ bearerAuth: [] }],
  request: { params: profileParams },
  responses: {
    200: jsonResponse("Profile version found.", profileVersionSchema),
    ...securedErrors,
    404: jsonResponse("Profile version not found.", executionErrorSchema),
  },
});

export const getExecutionRoute = createRoute({
  method: "get",
  path: "/executions/{id}",
  tags: ["executions"],
  summary: "Read an execution",
  security: [{ bearerAuth: [] }],
  request: { params: executionParams },
  responses: {
    200: jsonResponse("Execution found.", executionSchema),
    ...securedErrors,
    404: jsonResponse("Execution not found.", executionErrorSchema),
  },
});

function jsonResponse(description: string, schema: z.ZodType) {
  return { description, content: { "application/json": { schema } } };
}
