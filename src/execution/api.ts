import { randomUUID } from "node:crypto";
import { ConnectionNotFoundError } from "../connection/index.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  cancelExecutionRoute,
  getExecutionRoute,
  getProfileVersionRoute,
  publishProfileVersionRoute,
} from "./api-schema.js";
import type { ExecutionStore } from "./store.js";
import {
  ExecutionCancellationConflictError,
  ExecutionNotFoundError,
  ProfileVersionAlreadyExistsError,
  ProfileVersionNotFoundError,
} from "./types.js";

const TENANT_ID = "default";

export function registerExecutionApi(api: OpenAPIHono<any>, store: ExecutionStore): void {
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

  api.openapi(getExecutionRoute, async (context) => {
    const { id } = context.req.valid("param");
    return handle(context, async () => {
      const execution = await store.getExecutionDetail(TENANT_ID, id);
      if (!execution) throw new ExecutionNotFoundError(id);
      return context.json(execution, 200);
    }) as never;
  });

  api.openapi(cancelExecutionRoute, async (context) => {
    const { id } = context.req.valid("param");
    const { reason = "cancellation requested" } = context.req.valid("json");
    if (!/^application\/json(?:\s*;|$)/i.test(context.req.header("content-type") ?? "")) {
      return context.json({ error: "Invalid request" }, 400) as never;
    }
    return handle(context, async () => {
      const result = await store.requestExecutionCancellation({
        tenantId: TENANT_ID,
        executionId: id,
        transitionId: randomUUID(),
        actor: "control-api",
        reason,
        requestedAt: new Date().toISOString(),
      });
      if (!result) throw new ExecutionNotFoundError(id);
      return context.json({ id: result.id, state: result.state }, result.outcome === "CANCELLED" ? 200 : 202);
    }) as never;
  });
}

async function handle(context: Context, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProfileVersionNotFoundError || error instanceof ExecutionNotFoundError || error instanceof ConnectionNotFoundError) {
      return context.json({ error: error.message }, 404);
    }
    if (error instanceof ProfileVersionAlreadyExistsError || error instanceof ExecutionCancellationConflictError) {
      return context.json({ error: error.message }, 409);
    }
    return context.json({ error: "Internal server error" }, 500);
  }
}
