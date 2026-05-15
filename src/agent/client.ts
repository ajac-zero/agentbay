import { Buffer } from "node:buffer";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import type { Config } from "../config.js";

export type AgentEndpoint = {
  password: string;
  podFQDN: string;
};

export function createAgentClient(endpoint: AgentEndpoint, config: Config): OpencodeClient {
  return createOpencodeClient({
    baseUrl: baseUrl(endpoint.podFQDN, config.opencodePort),
    directory: config.opencodeDirectory,
    headers: authHeaders(endpoint.password),
  });
}

export async function waitForOpencodeReady(endpoint: AgentEndpoint, config: Config): Promise<void> {
  const deadline = Date.now() + config.claimReadyTimeoutMs;
  const url = `${baseUrl(endpoint.podFQDN, config.opencodePort)}/global/health`;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url, { headers: authHeaders(endpoint.password) });
      if (response.ok) return;
    } catch {
      // The sandbox Pod can be Ready before opencode has bound its HTTP port.
    }

    await sleep(500);
  }

  throw new Error(`opencode server at ${url} did not become ready`);
}

function baseUrl(podFQDN: string, port: number): string {
  return `http://${formatHost(podFQDN)}:${port}`;
}

function formatHost(host: string): string {
  if (host.startsWith("[") || !host.includes(":")) return host;
  return `[${host}]`;
}

function authHeaders(password: string): Record<string, string> {
  const token = Buffer.from(`opencode:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
