import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { createOpenApiApp, mountHealthRoute, mountOpenApiDocs } from "../../src/openapi.js";
import { mountControlApi, type ControlApiStore } from "../../src/control/api.js";

describe("OpenAPI docs", () => {
  it("serves the OpenAPI document", async () => {
    const app = createTestApp();
    mountOpenApiDocs(app);

    const response = await app.request("/openapi.json");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ openapi: "3.1.0", info: { title: "agentbay API" } });
    expect(Object.keys(body.paths as object)).toEqual([
      "/healthz",
      "/v1/agent-profiles/{profileID}/versions",
      "/v1/agent-profiles/{profileID}/versions/{version}",
      "/v1/executions/{id}",
      "/v1/triggers",
      "/v1/triggers/{triggerID}",
      "/v1/triggers/{triggerID}/disable",
      "/v1/bindings/{bindingID}/versions",
      "/v1/bindings/{bindingID}/versions/{version}",
      "/v1/bindings/{bindingID}/versions/{version}/disable",
      "/v1/triggers/{triggerID}/events",
    ]);
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

  it("serves simple health", async () => {
    const response = await createTestApp().request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "agentbay" });
  });
});

function createTestApp() {
  const app = createOpenApiApp();
  mountHealthRoute(app);
  mountControlApi(app, testConfig(), emptyControlStore());
  return app;
}

function emptyControlStore(): ControlApiStore {
  return {
    publishProfileVersion: async () => {
      throw new Error("not used");
    },
    getProfileVersion: async () => undefined,
    getExecution: async () => undefined,
    createTrigger: async () => { throw new Error("not used"); },
    getTrigger: async () => undefined,
    disableTrigger: async () => undefined,
    publishBindingVersion: async () => { throw new Error("not used"); },
    getBindingVersion: async () => undefined,
    disableBindingVersion: async () => undefined,
    listBindingCandidates: async () => [],
    admitEvent: async () => { throw new Error("not used"); },
  };
}

function testConfig(): Config {
  return {
    adminToken: "test-token",
    dispatcherEnabled: false,
    dispatcherIdlePollMs: 500,
    dispatcherLeaseDurationMs: 60_000,
    dispatcherRenewIntervalMs: 20_000,
    dispatcherWorkerId: "test-worker",
    executionMaintenanceBatchSize: 100,
    executionMaintenanceEnabled: true,
    executionMaintenanceIntervalMs: 5_000,
    executionMaxAttempts: 3,
    executionRetryDelayMs: 30_000,
    claimReadyTimeoutMs: 5_000,
    kubeNamespace: "unused",
    opencodeDirectory: "/workspace",
    opencodePort: 4096,
    port: 3000,
    sandboxClaimApiVersion: "v1alpha1",
  };
}
