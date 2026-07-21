import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Registry } from "prom-client";

export function createOpenApiApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Bearer authentication for the agentbay API.",
  });
  return app;
}

export function mountHealthRoute(app: OpenAPIHono): void {
  app.openapi(healthRoute, (context) =>
    context.json(
      {
        ok: true,
        service: "agentbay",
      },
      200,
    ),
  );
}

export function mountMetricsRoute(app: OpenAPIHono, registry: Registry): void {
  app.get("/metrics", async (context) => context.body(await registry.metrics(), 200, { "content-type": registry.contentType }));
}

export function mountOpenApiDocs(app: OpenAPIHono): void {
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "agentbay API",
      version: "1.0.0",
      description: "HTTP API for agentbay control, event admission, and asynchronous executions.",
    },
  });
  app.get("/docs", swaggerUI({ url: "/openapi.json", displayRequestDuration: true }));
  app.get("/docs/", (context) => context.redirect("/docs", 308));
}

const healthResponseSchema = z
  .object({
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
      description: "Service health.",
      content: {
        "application/json": {
          schema: healthResponseSchema,
        },
      },
    },
  },
});
