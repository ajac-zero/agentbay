import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Config } from "./config.js";
import { errorResponseSchema } from "./runtime/admin-schema.js";
import type { RuntimeStore } from "./runtime/store.js";

export function createOpenApiApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Bearer authentication for agentbay management and execution APIs.",
  });
  registerWebhookDocs(app);
  return app;
}

export function mountHealthRoute(app: OpenAPIHono, config: Config, runtimeStore: RuntimeStore): void {
  app.openapi(healthRoute, async (context) =>
    context.json(
      {
        ok: true,
        service: "agentbay",
        bots: (await runtimeStore.listBots()).map((bot) => ({ slug: bot.slug, enabled: bot.enabled })),
        adapters: {
          discord: config.discord.enabled,
          gchat: config.gchat.enabled,
          github: config.github.enabled,
          linear: config.linear.enabled,
          messenger: config.messenger.enabled,
          slack: config.slack.enabled,
          teams: config.teams.enabled,
          telegram: config.telegram.enabled,
          whatsapp: config.whatsapp.enabled,
        },
      },
      200,
    ),
  );
}

export function mountOpenApiDocs(app: OpenAPIHono): void {
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "agentbay API",
      version: "1.0.0",
      description: "HTTP API for agentbay health checks, asynchronous executions, chat adapter webhooks, and runtime administration.",
    },
  });
  app.get("/docs", swaggerUI({ url: "/openapi.json", displayRequestDuration: true }));
  app.get("/docs/", (context) => context.redirect("/docs", 308));
}

const adapterNameSchema = z.enum(["discord", "gchat", "github", "linear", "messenger", "slack", "teams", "telegram", "whatsapp"]);

const healthResponseSchema = z
  .object({
    adapters: z.object({
      discord: z.boolean(),
      gchat: z.boolean(),
      github: z.boolean(),
      linear: z.boolean(),
      messenger: z.boolean(),
      slack: z.boolean(),
      teams: z.boolean(),
      telegram: z.boolean(),
      whatsapp: z.boolean(),
    }),
    bots: z.array(
      z.object({
        enabled: z.boolean(),
        slug: z.string().min(1),
      }),
    ),
    ok: z.boolean(),
    service: z.literal("agentbay"),
  })
  .openapi("HealthResponse");

const healthRoute = createRoute({
  method: "get",
  path: "/healthz",
  tags: ["health"],
  summary: "Read service health",
  responses: {
    200: {
      description: "Service health and enabled adapters.",
      content: {
        "application/json": {
          schema: healthResponseSchema,
        },
      },
    },
    400: {
      description: "Bad request.",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

function registerWebhookDocs(app: OpenAPIHono): void {
  const request = {
    params: z.object({
      adapterName: adapterNameSchema,
      botSlug: z.string().min(1),
    }),
  };

  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/agents/{botSlug}/webhooks/{adapterName}",
    tags: ["webhooks"],
    summary: "Handle adapter webhook verification requests",
    description: "Pass-through route for bot-configured Chat SDK adapter webhooks. The exact request and response shapes are adapter-specific.",
    request,
    responses: webhookResponses,
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/agents/{botSlug}/webhooks/{adapterName}",
    tags: ["webhooks"],
    summary: "Handle adapter webhook event requests",
    description: "Pass-through route for bot-configured Chat SDK adapter webhooks. The exact request and response shapes are adapter-specific.",
    request: {
      ...request,
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.unknown()) },
          "application/x-www-form-urlencoded": { schema: z.record(z.string(), z.unknown()) },
          "text/plain": { schema: z.string() },
        },
      },
    },
    responses: webhookResponses,
  });
}

const webhookResponses = {
  200: { description: "Adapter-specific success response." },
  400: { description: "Adapter-specific bad request response." },
  404: { description: "Unknown bot or disabled adapter." },
};
