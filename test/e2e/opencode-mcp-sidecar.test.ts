import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The sidecar intentionally ships as dependency-free Node ESM.
import { startServer } from "../../github-mcp-sidecar/server.mjs";

type RunningServer = { server: http.Server; close: () => Promise<void> };

const execFileAsync = promisify(execFile);
const IMAGE = "agentbay-opencode-mcp-e2e:1.14.50";
const enabled = process.env.AGENTBAY_E2E_OPENCODE_MCP === "1";
let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe.skipIf(!enabled)("OpenCode MCP sidecar compatibility", () => {
  it("connects OpenCode 1.14.50 and discovers the sidecar tools", async () => {
    const methods: string[] = [];
    running = await startServer({
      initialize: async () => {},
      createIssueComment: async () => ({ id: 1, html_url: "https://github.test/comment/1" }),
      branchCreate: async () => ({ branch: "test", sha: "a".repeat(40), replayed: false }),
      contentsPut: async () => ({ path: "test", sha: "b".repeat(40), replayed: false }),
      pullRequestCreate: async () => ({ number: 1, state: "open", replayed: false }),
    }, { host: "0.0.0.0", port: 0 }) as RunningServer;

    running.server.on("request", (request) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        try {
          const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof message.method === "string") methods.push(message.method);
        } catch {
          // The sidecar owns request validation; this listener only records valid RPCs.
        }
      });
    });

    await execFileAsync("docker", [
      "build",
      "--file", "opencode-sandbox.Dockerfile",
      "--build-arg", "OPENCODE_VERSION=1.14.50",
      "--tag", IMAGE,
      ".",
    ], { maxBuffer: 10 * 1024 * 1024 });

    const port = (running.server.address() as AddressInfo).port;
    const config = JSON.stringify({
      mcp: {
        github: {
          type: "remote",
          url: `http://host.docker.internal:${port}/mcp`,
          oauth: false,
          enabled: true,
        },
      },
    });
    const { stdout, stderr } = await execFileAsync("docker", [
      "run", "--rm",
      "--add-host", "host.docker.internal:host-gateway",
      "--env", `OPENCODE_CONFIG_CONTENT=${config}`,
      "--entrypoint", "opencode",
      IMAGE,
      "mcp", "list",
    ], { maxBuffer: 10 * 1024 * 1024 });

    const output = `${stdout}\n${stderr}`.replaceAll(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    expect(output).toMatch(/github\s+connected/);
    expect(methods).toContain("initialize");
    expect(methods).toContain("tools/list");

    const discovered = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const payload = await discovered.json() as { result: { tools: Array<{ name: string }> } };
    expect(payload.result.tools.map((tool) => tool.name)).toEqual([
      "issue_comment", "branch_create", "contents_put", "pull_request_create",
    ]);
  }, 600_000);
});
