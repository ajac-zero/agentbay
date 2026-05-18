import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { Config } from "../config.js";
import type { RuntimeStore, UpsertOpencodeConfigInput } from "./store.js";
import type { AgentProfile, Bot, BotAgentProfile, OpencodeConfig, SandboxProfile } from "./types.js";

export function mountRuntimeAdmin(app: Hono, config: Config, runtimeStore: RuntimeStore): void {
  if (!config.adminToken) return;
  const adminToken = config.adminToken;

  const admin = new Hono();
  admin.use("*", async (context, next) => {
    if (!isAuthorized(context, adminToken)) return context.text("Unauthorized", 401);
    await next();
  });

  admin.get("/bots", (context) => json(context, () => runtimeStore.listBots()));
  admin.post("/bots", (context) => json(context, async () => runtimeStore.upsertBot(readBot(await readBody(context))), 201));
  admin.get("/bots/:id", (context) => getOne(context, () => runtimeStore.getBot(context.req.param("id"))));
  admin.put("/bots/:id", (context) => json(context, async () => runtimeStore.upsertBot(readBot(await readBody(context), context.req.param("id")))));
  admin.delete("/bots/:id", (context) => deleteOne(context, () => runtimeStore.deleteBot(context.req.param("id"))));

  admin.get("/sandbox-profiles", (context) => json(context, () => runtimeStore.listSandboxProfiles()));
  admin.post("/sandbox-profiles", (context) =>
    json(context, async () => runtimeStore.upsertSandboxProfile(readSandboxProfile(await readBody(context))), 201),
  );
  admin.get("/sandbox-profiles/:id", (context) => getOne(context, () => runtimeStore.getSandboxProfile(context.req.param("id"))));
  admin.put("/sandbox-profiles/:id", (context) =>
    json(context, async () => runtimeStore.upsertSandboxProfile(readSandboxProfile(await readBody(context), context.req.param("id")))),
  );
  admin.delete("/sandbox-profiles/:id", (context) => deleteOne(context, () => runtimeStore.deleteSandboxProfile(context.req.param("id"))));

  admin.get("/opencode-configs", (context) => json(context, () => runtimeStore.listOpencodeConfigs()));
  admin.post("/opencode-configs", (context) =>
    json(context, async () => runtimeStore.upsertOpencodeConfig(readOpencodeConfig(await readBody(context))), 201),
  );
  admin.get("/opencode-configs/:id", (context) => getOne(context, () => runtimeStore.getOpencodeConfig(context.req.param("id"))));
  admin.put("/opencode-configs/:id", (context) =>
    json(context, async () => runtimeStore.upsertOpencodeConfig(readOpencodeConfig(await readBody(context), context.req.param("id")))),
  );
  admin.delete("/opencode-configs/:id", (context) => deleteOne(context, () => runtimeStore.deleteOpencodeConfig(context.req.param("id"))));

  admin.get("/agent-profiles", (context) => json(context, () => runtimeStore.listAgentProfiles()));
  admin.post("/agent-profiles", (context) =>
    json(context, async () => runtimeStore.upsertAgentProfile(readAgentProfile(await readBody(context))), 201),
  );
  admin.get("/agent-profiles/:id", (context) => getOne(context, () => runtimeStore.getAgentProfile(context.req.param("id"))));
  admin.put("/agent-profiles/:id", (context) =>
    json(context, async () => runtimeStore.upsertAgentProfile(readAgentProfile(await readBody(context), context.req.param("id")))),
  );
  admin.delete("/agent-profiles/:id", (context) => deleteOne(context, () => runtimeStore.deleteAgentProfile(context.req.param("id"))));

  admin.get("/bot-agent-profiles", (context) => json(context, () => runtimeStore.listBotAgentProfiles()));
  admin.post("/bot-agent-profiles", (context) =>
    json(context, async () => runtimeStore.addBotAgentProfile(readBotAgentProfile(await readBody(context))), 201),
  );
  admin.delete("/bot-agent-profiles/:botID/:agentProfileID", (context) =>
    deleteOne(context, () => runtimeStore.deleteBotAgentProfile(context.req.param("botID"), context.req.param("agentProfileID"))),
  );

  app.route("/admin/runtime", admin);
}

async function json(context: Context, run: () => Promise<unknown>, status: 200 | 201 = 200): Promise<Response> {
  try {
    return context.json(await run(), status);
  } catch (error) {
    return context.json({ error: formatError(error) }, 400);
  }
}

async function getOne(context: Context, run: () => Promise<unknown | undefined>): Promise<Response> {
  try {
    const value = await run();
    return value === undefined ? context.text("Not found", 404) : context.json(value);
  } catch (error) {
    return context.json({ error: formatError(error) }, 400);
  }
}

async function deleteOne(context: Context, run: () => Promise<boolean>): Promise<Response> {
  try {
    return (await run()) ? context.body(null, 204) : context.text("Not found", 404);
  } catch (error) {
    return context.json({ error: formatError(error) }, 400);
  }
}

async function readBody(context: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new Error("Request body must be valid JSON");
  }

  if (!isRecord(body)) throw new Error("Request body must be a JSON object");
  return body;
}

function readBot(body: Record<string, unknown>, pathID?: string): Bot {
  return {
    defaultAgentProfileID: readString(body, "defaultAgentProfileID"),
    displayName: readString(body, "displayName"),
    enabled: readBoolean(body, "enabled"),
    id: readID(body, pathID),
    sandboxProfileID: readString(body, "sandboxProfileID"),
    slug: readString(body, "slug"),
  };
}

function readSandboxProfile(body: Record<string, unknown>, pathID?: string): SandboxProfile {
  return {
    enabled: readBoolean(body, "enabled"),
    id: readID(body, pathID),
    slug: readString(body, "slug"),
    templateName: readString(body, "templateName"),
    warmpool: readString(body, "warmpool"),
  };
}

function readOpencodeConfig(body: Record<string, unknown>, pathID?: string): UpsertOpencodeConfigInput {
  return {
    config: readConfig(body),
    displayName: readString(body, "displayName"),
    enabled: readBoolean(body, "enabled"),
    id: readID(body, pathID),
    slug: readString(body, "slug"),
  };
}

function readAgentProfile(body: Record<string, unknown>, pathID?: string): AgentProfile {
  return {
    displayName: readString(body, "displayName"),
    enabled: readBoolean(body, "enabled"),
    id: readID(body, pathID),
    opencodeAgentName: readString(body, "opencodeAgentName"),
    opencodeConfigID: readString(body, "opencodeConfigID"),
    slug: readString(body, "slug"),
  };
}

function readBotAgentProfile(body: Record<string, unknown>): BotAgentProfile {
  return {
    agentProfileID: readString(body, "agentProfileID"),
    botID: readString(body, "botID"),
  };
}

function readID(body: Record<string, unknown>, pathID: string | undefined): string {
  const bodyID = body.id;
  if (pathID && bodyID !== undefined && bodyID !== pathID) throw new Error("Body id must match path id");
  if (pathID) return pathID;
  return readString(body, "id");
}

function readString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function readBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function readConfig(body: Record<string, unknown>): OpencodeConfig {
  const value = body.config;
  if (!isRecord(value)) throw new Error("config must be a JSON object");
  return value;
}

function isAuthorized(context: Context, token: string): boolean {
  const header = context.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
