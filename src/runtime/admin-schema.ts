import { createRoute, z } from "@hono/zod-openapi";
import type { RuntimeStore } from "./store.js";

export type RuntimeAdminResource = {
  tag: string;
  path: string;
  schema: z.ZodType;
  inputSchema: z.ZodType;
  updateInputSchema: z.ZodType;
  list: (runtimeStore: RuntimeStore) => Promise<unknown[]>;
  get: (runtimeStore: RuntimeStore, id: string) => Promise<unknown | undefined>;
  upsert: (runtimeStore: RuntimeStore, value: unknown) => Promise<unknown>;
  delete: (runtimeStore: RuntimeStore, id: string) => Promise<boolean>;
};

export type RuntimeAdminRelation = {
  tag: string;
  path: string;
  schema: z.ZodType;
  inputSchema: z.ZodType;
  list: (runtimeStore: RuntimeStore) => Promise<unknown[]>;
  add: (runtimeStore: RuntimeStore, value: unknown) => Promise<unknown>;
  delete: (runtimeStore: RuntimeStore, botID: string, agentProfileID: string) => Promise<boolean>;
};

export const errorResponseSchema = z
  .object({
    error: z.string().min(1),
  })
  .openapi("ErrorResponse");

const idSchema = z.string().min(1).openapi({ example: "bot-default" });
const slugSchema = z.string().min(1).openapi({ example: "default" });
const displayNameSchema = z.string().min(1).openapi({ example: "Default" });
const opencodeConfigSchema = z.record(z.string(), z.unknown()).openapi({
  example: { default_agent: "coder", agent: { coder: { prompt: "You are a coding agent." } } },
});

export const botSchema = z
  .object({
    defaultAgentProfileID: idSchema,
    displayName: displayNameSchema,
    enabled: z.boolean(),
    id: idSchema,
    sandboxProfileID: idSchema,
    slug: slugSchema,
  })
  .openapi("Bot");
const botUpdateSchema = botSchema.extend({ id: idSchema.optional() }).openapi("BotUpdate");

export const sandboxProfileSchema = z
  .object({
    enabled: z.boolean(),
    id: idSchema,
    slug: slugSchema,
    templateName: z.string().min(1).openapi({ example: "opencode-template" }),
    warmpool: z.string().min(1).openapi({ example: "none" }),
  })
  .openapi("SandboxProfile");
const sandboxProfileUpdateSchema = sandboxProfileSchema.extend({ id: idSchema.optional() }).openapi("SandboxProfileUpdate");

export const opencodeConfigInputSchema = z
  .object({
    config: opencodeConfigSchema,
    displayName: displayNameSchema,
    enabled: z.boolean(),
    id: idSchema,
    slug: slugSchema,
  })
  .openapi("OpencodeConfigInput");
const opencodeConfigUpdateSchema = opencodeConfigInputSchema.extend({ id: idSchema.optional() }).openapi("OpencodeConfigUpdate");

export const opencodeConfigRecordSchema = opencodeConfigInputSchema
  .extend({
    configHash: z.string().min(1),
    updatedAt: z.string().datetime(),
  })
  .openapi("OpencodeConfigRecord");

export const agentProfileSchema = z
  .object({
    displayName: displayNameSchema,
    enabled: z.boolean(),
    id: idSchema,
    opencodeAgentName: z.string().min(1).openapi({ example: "coder" }),
    opencodeConfigID: idSchema,
    slug: slugSchema,
  })
  .openapi("AgentProfile");
const agentProfileUpdateSchema = agentProfileSchema.extend({ id: idSchema.optional() }).openapi("AgentProfileUpdate");

export const botAgentProfileSchema = z
  .object({
    agentProfileID: idSchema,
    botID: idSchema,
  })
  .openapi("BotAgentProfile");

export const idParamSchema = z.object({ id: idSchema });
export const botAgentProfileParamSchema = z.object({
  agentProfileID: idSchema,
  botID: idSchema,
});

export const runtimeAdminResources = [
  {
    tag: "bots",
    path: "/bots",
    schema: botSchema,
    inputSchema: botSchema,
    updateInputSchema: botUpdateSchema,
    list: (runtimeStore) => runtimeStore.listBots(),
    get: (runtimeStore, id) => runtimeStore.getBot(id),
    upsert: (runtimeStore, value) => runtimeStore.upsertBot(botSchema.parse(value)),
    delete: (runtimeStore, id) => runtimeStore.deleteBot(id),
  },
  {
    tag: "sandbox-profiles",
    path: "/sandbox-profiles",
    schema: sandboxProfileSchema,
    inputSchema: sandboxProfileSchema,
    updateInputSchema: sandboxProfileUpdateSchema,
    list: (runtimeStore) => runtimeStore.listSandboxProfiles(),
    get: (runtimeStore, id) => runtimeStore.getSandboxProfile(id),
    upsert: (runtimeStore, value) => runtimeStore.upsertSandboxProfile(sandboxProfileSchema.parse(value)),
    delete: (runtimeStore, id) => runtimeStore.deleteSandboxProfile(id),
  },
  {
    tag: "opencode-configs",
    path: "/opencode-configs",
    schema: opencodeConfigRecordSchema,
    inputSchema: opencodeConfigInputSchema,
    updateInputSchema: opencodeConfigUpdateSchema,
    list: (runtimeStore) => runtimeStore.listOpencodeConfigs(),
    get: (runtimeStore, id) => runtimeStore.getOpencodeConfig(id),
    upsert: (runtimeStore, value) => runtimeStore.upsertOpencodeConfig(opencodeConfigInputSchema.parse(value)),
    delete: (runtimeStore, id) => runtimeStore.deleteOpencodeConfig(id),
  },
  {
    tag: "agent-profiles",
    path: "/agent-profiles",
    schema: agentProfileSchema,
    inputSchema: agentProfileSchema,
    updateInputSchema: agentProfileUpdateSchema,
    list: (runtimeStore) => runtimeStore.listAgentProfiles(),
    get: (runtimeStore, id) => runtimeStore.getAgentProfile(id),
    upsert: (runtimeStore, value) => runtimeStore.upsertAgentProfile(agentProfileSchema.parse(value)),
    delete: (runtimeStore, id) => runtimeStore.deleteAgentProfile(id),
  },
] satisfies RuntimeAdminResource[];

export const runtimeAdminRelation = {
  tag: "bot-agent-profiles",
  path: "/bot-agent-profiles",
  schema: botAgentProfileSchema,
  inputSchema: botAgentProfileSchema,
  list: (runtimeStore) => runtimeStore.listBotAgentProfiles(),
  add: (runtimeStore, value) => runtimeStore.addBotAgentProfile(botAgentProfileSchema.parse(value)),
  delete: (runtimeStore, botID, agentProfileID) => runtimeStore.deleteBotAgentProfile(botID, agentProfileID),
} satisfies RuntimeAdminRelation;

export function createListRoute(resource: RuntimeAdminResource | RuntimeAdminRelation) {
  return createRoute({
    method: "get",
    path: resource.path,
    tags: [resource.tag],
    summary: `List ${resource.tag}`,
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse("Resource list.", z.array(resource.schema)),
      400: jsonResponse("Bad request.", errorResponseSchema),
      401: { description: "Missing or invalid bearer token." },
    },
  });
}

export function createCreateRoute(resource: RuntimeAdminResource | RuntimeAdminRelation, summary: string) {
  return createRoute({
    method: "post",
    path: resource.path,
    tags: [resource.tag],
    summary,
    security: [{ bearerAuth: [] }],
    request: jsonRequest(resource.inputSchema),
    responses: {
      201: jsonResponse("Resource saved.", resource.schema),
      400: jsonResponse("Bad request.", errorResponseSchema),
      401: { description: "Missing or invalid bearer token." },
    },
  });
}

export function createGetRoute(resource: RuntimeAdminResource) {
  return createRoute({
    method: "get",
    path: `${resource.path}/{id}`,
    tags: [resource.tag],
    summary: `Read ${resource.tag}`,
    security: [{ bearerAuth: [] }],
    request: { params: idParamSchema },
    responses: {
      200: jsonResponse("Resource found.", resource.schema),
      400: jsonResponse("Bad request.", errorResponseSchema),
      401: { description: "Missing or invalid bearer token." },
      404: { description: "Resource not found." },
    },
  });
}

export function createUpdateRoute(resource: RuntimeAdminResource) {
  return createRoute({
    method: "put",
    path: `${resource.path}/{id}`,
    tags: [resource.tag],
    summary: `Replace ${resource.tag}`,
    security: [{ bearerAuth: [] }],
    request: {
      params: idParamSchema,
      ...jsonRequest(resource.updateInputSchema),
    },
    responses: {
      200: jsonResponse("Resource saved.", resource.schema),
      400: jsonResponse("Bad request.", errorResponseSchema),
      401: { description: "Missing or invalid bearer token." },
    },
  });
}

export function createDeleteRoute(resource: RuntimeAdminResource) {
  return createRoute({
    method: "delete",
    path: `${resource.path}/{id}`,
    tags: [resource.tag],
    summary: `Delete ${resource.tag}`,
    security: [{ bearerAuth: [] }],
    request: { params: idParamSchema },
    responses: deleteResponses,
  });
}

const deleteResponses = {
  204: { description: "Deleted." },
  400: jsonResponse("Bad request.", errorResponseSchema),
  401: { description: "Missing or invalid bearer token." },
  404: { description: "Resource not found." },
};

export const deleteBotAgentProfileRoute = createRoute({
  method: "delete",
  path: `${runtimeAdminRelation.path}/{botID}/{agentProfileID}`,
  tags: [runtimeAdminRelation.tag],
  summary: "Remove an allowed agent profile from a bot",
  security: [{ bearerAuth: [] }],
  request: { params: botAgentProfileParamSchema },
  responses: deleteResponses,
});

function jsonRequest(schema: z.ZodType) {
  return {
    body: {
      required: true,
      content: {
        "application/json": {
          schema,
        },
      },
    },
  };
}

function jsonResponse(description: string, schema: z.ZodType) {
  return {
    description,
    content: {
      "application/json": {
        schema,
      },
    },
  };
}
