import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { createOpenApiApp, mountHealthRoute, mountOpenApiDocs } from "../../src/openapi.js";
import { mountRuntimeAdmin } from "../../src/runtime/admin.js";
import { runtimeAdminRelation, runtimeAdminResources } from "../../src/runtime/admin-schema.js";
import { TestRuntimeStore } from "./runtime-store-fixture.js";

describe("OpenAPI docs", () => {
  it("serves the OpenAPI document", async () => {
    const app = createTestApp();
    mountOpenApiDocs(app);

    const response = await app.request("/openapi.json");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ openapi: "3.1.0", info: { title: "agentbay API" } });
    expect(body.paths).toMatchObject({
      "/healthz": expect.any(Object),
      "/admin/runtime/bots": expect.any(Object),
      "/agents/{botSlug}/webhooks/{adapterName}": expect.any(Object),
    });
  });

  it("serves Swagger UI", async () => {
    const app = createTestApp();
    mountOpenApiDocs(app);

    const response = await app.request("/docs");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("SwaggerUIBundle");
    expect(body).toContain("/openapi.json");
  });

  it("documents every runtime admin route definition", async () => {
    const app = createTestApp();
    mountOpenApiDocs(app);

    const response = await app.request("/openapi.json");
    const body = (await response.json()) as { components: { schemas: Record<string, unknown> }; paths: Record<string, unknown> };

    for (const resource of runtimeAdminResources) {
      expect(body.paths[`/admin/runtime${resource.path}`]).toBeDefined();
      expect(body.paths[`/admin/runtime${resource.path}/{id}`]).toBeDefined();
    }

    expect(body.paths[`/admin/runtime${runtimeAdminRelation.path}`]).toBeDefined();
    expect(body.paths[`/admin/runtime${runtimeAdminRelation.path}/{botID}/{agentProfileID}`]).toBeDefined();
  });
});

function createTestApp() {
  const app = createOpenApiApp();
  const runtimeStore = new TestRuntimeStore();
  mountHealthRoute(app, testConfig(), runtimeStore);
  mountRuntimeAdmin(app, testConfig(), runtimeStore);
  return app;
}

function testConfig(): Config {
  const disabled = { enabled: false };
    return {
      adminToken: "test-token",
      botUserName: "agentbay",
      claimPollIntervalMs: 10,
    claimReadyTimeoutMs: 5_000,
    claimShutdownHours: 1,
    claimTtlSecondsAfterFinished: 60,
    kubeNamespace: "unused",
    opencodeDirectory: "/workspace",
    opencodePort: 4096,
    port: 3000,
    sandboxClaimApiVersion: "v1alpha1",
    discord: disabled,
    gchat: disabled,
    github: disabled,
    linear: disabled,
    messenger: disabled,
    slack: disabled,
    teams: disabled,
    telegram: disabled,
    whatsapp: disabled,
  };
}
