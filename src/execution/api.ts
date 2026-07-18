import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  getExecutionRoute,
  getProfileVersionRoute,
  publishProfileVersionRoute,
} from "./api-schema.js";
import type { ExecutionStore } from "./store.js";
import {
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
      const execution = await store.getExecution(TENANT_ID, id);
      if (!execution) throw new ExecutionNotFoundError(id);
      return context.json(execution, 200);
    }) as never;
  });
}

async function handle(context: Context, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProfileVersionNotFoundError || error instanceof ExecutionNotFoundError) {
      return context.json({ error: error.message }, 404);
    }
    if (error instanceof ProfileVersionAlreadyExistsError) {
      return context.json({ error: error.message }, 409);
    }
    return context.json({ error: "Internal server error" }, 500);
  }
}
