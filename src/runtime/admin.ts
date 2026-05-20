import { timingSafeEqual } from "node:crypto";
import { OpenAPIHono, type Hook } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Config } from "../config.js";
import {
  createCreateRoute,
  createDeleteRoute,
  createGetRoute,
  createListRoute,
  createUpdateRoute,
  deleteBotAgentProfileRoute,
  runtimeAdminRelation,
  runtimeAdminResources,
} from "./admin-schema.js";
import type { RuntimeStore } from "./store.js";

export function mountRuntimeAdmin(app: OpenAPIHono<any>, config: Config, runtimeStore: RuntimeStore): void {
  if (!config.adminToken) return;
  const adminToken = config.adminToken;

  const admin = new OpenAPIHono({ defaultHook: validationHook });
  admin.use("*", async (context, next) => {
    if (!isAuthorized(context, adminToken)) return context.text("Unauthorized", 401);
    await next();
  });

  for (const resource of runtimeAdminResources) {
    admin.openapi(createListRoute(resource), (context) => json(context, () => resource.list(runtimeStore)) as never);
    admin.openapi(
      createCreateRoute(resource, `Create or replace ${resource.tag}`),
      (context) => json(context, async () => resource.upsert(runtimeStore, context.req.valid("json")), 201) as never,
    );
    admin.openapi(createGetRoute(resource), (context) => {
      const { id } = context.req.valid("param") as { id: string };
      return getOne(context, () => resource.get(runtimeStore, id)) as never;
    });
    admin.openapi(createUpdateRoute(resource), (context) => {
      const { id } = context.req.valid("param") as { id: string };
      return json(context, async () => resource.upsert(runtimeStore, withPathID(context.req.valid("json"), id))) as never;
    });
    admin.openapi(createDeleteRoute(resource), (context) => {
      const { id } = context.req.valid("param") as { id: string };
      return deleteOne(context, () => resource.delete(runtimeStore, id)) as never;
    });
  }

  admin.openapi(createListRoute(runtimeAdminRelation), (context) => json(context, () => runtimeAdminRelation.list(runtimeStore)) as never);
  admin.openapi(
    createCreateRoute(runtimeAdminRelation, "Allow an agent profile for a bot"),
    (context) => json(context, async () => runtimeAdminRelation.add(runtimeStore, context.req.valid("json")), 201) as never,
  );
  admin.openapi(deleteBotAgentProfileRoute, (context) => {
    const { agentProfileID, botID } = context.req.valid("param") as { agentProfileID: string; botID: string };
    return deleteOne(context, () => runtimeAdminRelation.delete(runtimeStore, botID, agentProfileID)) as never;
  });

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

const validationHook: Hook<unknown, any, any, any> = (result, context) => {
  if (!result.success) return context.json({ error: result.error.issues.map((issue) => issue.message).join("; ") }, 400);
};

function withPathID(body: unknown, id: string): unknown {
  if (!isRecord(body)) return body;
  if (body.id !== undefined && body.id !== id) throw new Error("Body id must match path id");
  return { ...body, id };
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
