import type { AddressInfo } from "node:net";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error The broker intentionally ships as dependency-free Node ESM.
import { startBroker } from "../../github-token-broker/server.mjs";

const IMAGE = "ghcr.io/github/github-mcp-server@sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3";

describe("official GitHub MCP through token broker", () => {
  let official: StartedTestContainer;
  let broker: { server: import("node:http").Server; close: () => Promise<void> };

  beforeAll(async () => {
    official = await new GenericContainer(IMAGE)
      .withCommand(["http", "--listen-host=0.0.0.0", "--port=8082", "--tools=issue_read,issue_write,pull_request_review_write"])
      .withExposedPorts(8082)
      .withWaitStrategy(Wait.forLogMessage(/HTTP server listening/))
      .start();
    broker = await startBroker({
      host: "127.0.0.1",
      port: 0,
      upstream: `http://${official.getHost()}:${official.getMappedPort(8082)}/`,
    }, {
      getToken: async () => "ghs_test",
      invalidate: () => {},
    });
  });

  afterAll(async () => {
    await broker?.close();
    await official?.stop();
  });

  it("initializes Streamable HTTP and exposes only registered tools", async () => {
    const url = `http://127.0.0.1:${(broker.server.address() as AddressInfo).port}/`;
    const initialized = await rpc(url, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agentbay-test", version: "1" },
    });
    expect(initialized.result.serverInfo).toMatchObject({ name: "github-mcp-server", version: "v1.6.0" });

    const listed = await rpc(url, 2, "tools/list", {});
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["issue_read", "issue_write", "pull_request_review_write"]);
    const reviewTool = listed.result.tools.find((tool: { name: string }) => tool.name === "pull_request_review_write");
    expect(reviewTool.inputSchema.properties.method.enum).toEqual(expect.arrayContaining(["create", "submit_pending"]));
    expect(reviewTool.inputSchema.properties.event.enum).toEqual(expect.arrayContaining(["APPROVE", "REQUEST_CHANGES", "COMMENT"]));
    expect(reviewTool.inputSchema.properties).toHaveProperty("commitID");
  });
});

async function rpc(url: string, id: number, method: string, params: object): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  if (!data) throw new Error(`Official GitHub MCP returned no SSE data: ${text}`);
  return JSON.parse(data.slice("data: ".length));
}
