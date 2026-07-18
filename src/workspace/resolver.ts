import { isIP } from "node:net";
import { resolveJsonPointer, type JsonValue } from "../json.js";
import type { BindingWorkspace, ResolvedWorkspace } from "./types.js";

const MAX_URL_BYTES = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_CONTROL_CHARACTERS = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;
const FULL_COMMIT = /^[0-9a-f]{40}$/i;

export class WorkspaceResolutionError extends Error {
  readonly code = "WORKSPACE_RESOLUTION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceResolutionError";
  }
}

export function resolveWorkspace(workspace: BindingWorkspace, eventData: JsonValue): ResolvedWorkspace {
  if (workspace.type === "empty") return workspace;

  const repositoryUrl = resolveString(eventData, workspace.repository.url.path, "repository URL");
  const commit = resolveString(eventData, workspace.revision.commit.path, "revision commit");

  return {
    type: "git",
    repository: { url: canonicalizeRepositoryUrl(repositoryUrl) },
    revision: { type: "commit", commit: canonicalizeCommit(commit) },
  };
}

function resolveString(eventData: JsonValue, path: string, field: string): string {
  let resolution;
  try {
    resolution = resolveJsonPointer(eventData, path);
  } catch {
    throw new WorkspaceResolutionError(`Workspace ${field} selector ${JSON.stringify(path)} must be an RFC 6901 JSON pointer`);
  }
  if (!resolution.found) throw new WorkspaceResolutionError(`Workspace ${field} is missing at event.data pointer ${JSON.stringify(path)}`);
  if (typeof resolution.value !== "string") {
    throw new WorkspaceResolutionError(`Workspace ${field} at event.data pointer ${JSON.stringify(path)} must be a string`);
  }
  return resolution.value;
}

export function canonicalizeRepositoryUrl(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_URL_BYTES) {
    throw new WorkspaceResolutionError(`Workspace repository URL must be at most ${MAX_URL_BYTES} bytes`);
  }
  if (CONTROL_CHARACTERS.test(value) || ENCODED_CONTROL_CHARACTERS.test(value)) {
    throw new WorkspaceResolutionError("Workspace repository URL must not contain control characters");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkspaceResolutionError("Workspace repository URL must be a valid public HTTPS URL");
  }

  if (url.protocol !== "https:") throw new WorkspaceResolutionError("Workspace repository URL must use HTTPS");
  if (!url.hostname) throw new WorkspaceResolutionError("Workspace repository URL must have a nonempty hostname");
  if (url.username || url.password) throw new WorkspaceResolutionError("Workspace repository URL must not contain credentials");
  if (url.hash) throw new WorkspaceResolutionError("Workspace repository URL must not contain a fragment");
  if (!isPublicHostname(url.hostname)) throw new WorkspaceResolutionError("Workspace repository URL hostname must be public");
  if (Buffer.byteLength(url.href, "utf8") > MAX_URL_BYTES) {
    throw new WorkspaceResolutionError(`Workspace repository URL must be at most ${MAX_URL_BYTES} bytes after canonicalization`);
  }
  return url.href;
}

export function canonicalizeCommit(value: string): string {
  if (!FULL_COMMIT.test(value)) {
    throw new WorkspaceResolutionError("Workspace revision commit must be a full 40 character hexadecimal SHA-1 object ID");
  }
  return value.toLowerCase();
}

function isPublicHostname(hostname: string): boolean {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const normalized = unbracketed.toLowerCase().replace(/\.$/, "");
  const localName = normalized === "localhost" || normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") || normalized.endsWith(".internal");
  if (localName) return false;

  const version = isIP(normalized);
  if (version === 4) return isPublicIpv4(normalized);
  if (version === 6) return false;
  return normalized.includes(".");
}

function isPublicIpv4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}
