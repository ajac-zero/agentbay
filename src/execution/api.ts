import { randomUUID, timingSafeEqual } from "node:crypto";
import { OpenAPIHono, type Hook } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Config } from "../config.js";
import {
  createExecutionRoute,
  getExecutionRoute,
  getProfileVersionRoute,
  publishProfileVersionRoute,
} from "./api-schema.js";
import { hashCanonicalRequest, type ExecutionStore } from "./store.js";
import {
  ExecutionNotFoundError,
  IdempotencyConflictError,
  ProfileVersionAlreadyExistsError,
  ProfileVersionNotFoundError,
  type JsonObject,
} from "./types.js";

const TENANT_ID = "default";
const MAX_BODY_BYTES = 128 * 1024;

export function mountExecutionApi(app: OpenAPIHono<any>, config: Config, store: ExecutionStore): void {
  if (!config.adminToken) return;
  const token = config.adminToken;
  const api = new OpenAPIHono({ defaultHook: validationHook });

  api.use("*", bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (context) => context.json({ error: "Request body too large" }, 413),
  }));
  api.use("*", async (context, next) => {
    if (!isAuthorized(context, token)) return context.json({ error: "Unauthorized" }, 401);
    await next();
  });

  api.openapi(publishProfileVersionRoute, async (context) => {
    const { profileID } = context.req.valid("param");
    const body = context.req.valid("json");
    const createdAt = new Date().toISOString();
    return handle(context, async () => {
      const profile = await store.publishProfileVersion({
        id: randomUUID(),
        tenantId: TENANT_ID,
        profileId: profileID,
        version: body.version,
        definition: body.definition,
        createdAt,
      });
      return context.json(profile, 201);
    }) as never;
  });

  api.openapi(getProfileVersionRoute, async (context) => {
    const { profileID, version } = context.req.valid("param");
    return handle(context, async () => {
      const profile = await store.getProfileVersion(TENANT_ID, profileID, version);
      if (!profile) throw new ProfileVersionNotFoundError(profileID, version);
      return context.json(profile, 200);
    }) as never;
  });

  api.openapi(createExecutionRoute, async (context) => {
    const body = context.req.valid("json");
    const idempotencyKey = context.req.header("idempotency-key")!;
    return handle(context, async () => {
      const createdAt = new Date().toISOString();
      const executionId = randomUUID();
      const eventId = randomUUID();
      const requestHash = hashCanonicalRequest(body);
      const result = await store.createExecution({
        id: executionId,
        tenantId: TENANT_ID,
        profile: body.profile,
        input: body.input,
        workspace: body.workspace,
        event: {
          id: eventId,
          time: createdAt,
          source: "/v1/executions",
          type: "dev.agentbay.execution.submitted",
        data: body as JsonObject,
        },
        idempotencyKey,
        requestHash,
        createdAt,
      });
      context.header("Location", `/v1/executions/${result.execution.id}`);
      return context.json(result.execution, 202);
    }) as never;
  });

  api.openapi(getExecutionRoute, async (context) => {
    const { id } = context.req.valid("param");
    return handle(context, async () => {
      const execution = await store.getExecution(TENANT_ID, id);
      if (!execution) throw new ExecutionNotFoundError(id);
      return context.json(execution, 200);
    }) as never;
  });

  app.route("/v1", api);
}

async function handle(context: Context, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProfileVersionNotFoundError || error instanceof ExecutionNotFoundError) {
      return context.json({ error: error.message }, 404);
    }
    if (error instanceof ProfileVersionAlreadyExistsError || error instanceof IdempotencyConflictError) {
      return context.json({ error: error.message }, 409);
    }
    return context.json({ error: "Internal server error" }, 500);
  }
}

const validationHook: Hook<unknown, any, any, any> = (result, context) => {
  if (!result.success) return context.json({ error: "Invalid request" }, 400);
};

function isAuthorized(context: Context, token: string): boolean {
  const header = context.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const expected = Buffer.from(token);
  const supplied = Buffer.from(header.slice("Bearer ".length));
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
