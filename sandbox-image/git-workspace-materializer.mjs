#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

const GIT = "/usr/bin/git";
const DEFAULT_WORKSPACE = "/workspace";
const MAX_ERROR_LENGTH = 512;
const GIT_CONFIG = [
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "credential.helper=",
  "-c", "core.askPass=/bin/false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "http.followRedirects=false",
];

function isPublicIpv4(address) {
  const [a, b, c] = address.split(".").map(Number);
  return !(
    a === 0 || a === 10 || a === 127 ||
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

function isPublicHostname(hostname) {
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

export function validatePublicHttpsGitUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("Git workspace URL must be a non-empty HTTPS URL of at most 2048 characters");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Git workspace URL must be a valid public HTTPS URL");
  }

  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname) {
    throw new Error("Git workspace URL must be a public HTTPS URL without credentials or a fragment");
  }

  if (!isPublicHostname(url.hostname)) {
    throw new Error("Git workspace URL host must be public");
  }

  return url.href;
}

export function validateCommit(value) {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error("Git workspace commit must be a full 40 character hexadecimal SHA-1 object ID");
  }
  return value.toLowerCase();
}

export function createCommandRunner() {
  return (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, { ...options, shell: false, encoding: "utf8", maxBuffer: 64 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function boundedError(error) {
  const candidate = error && typeof error === "object" && "stderr" in error ? error.stderr : "";
  const text = typeof candidate === "string" ? candidate : "";
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? `: ${clean.slice(0, MAX_ERROR_LENGTH)}` : "";
}

function gitEnvironment(environment) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    // Preserve custom CA settings, but never proxy resolution around the pinned destination.
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => /^SSL_CERT_(?:FILE|DIR)$/i.test(key))),
  };
}

async function requireEmptyTarget(directory) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory()) throw new Error(`Workspace path must be a directory: ${directory}`);
    const entries = await readdir(directory);
    if (entries.length !== 0) throw new Error(`Workspace directory must be empty: ${directory}`);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return;
    }
    throw error;
  }
}

export async function materializeWorkspace({
  environment = process.env,
  runner = createCommandRunner(),
  resolver = lookup,
  urlValidator = validatePublicHttpsGitUrl,
} = {}) {
  const type = environment.AGENTBAY_WORKSPACE_TYPE;
  if (type === undefined || type === "" || type === "empty") return;
  if (type !== "git") throw new Error(`Unsupported workspace type: ${String(type).slice(0, 64)}`);

  const directory = environment.AGENTBAY_WORKSPACE_DIRECTORY || DEFAULT_WORKSPACE;
  if (!directory.startsWith("/")) throw new Error("Workspace directory must be an absolute path");
  const url = urlValidator(environment.AGENTBAY_WORKSPACE_GIT_URL);
  const commit = validateCommit(environment.AGENTBAY_WORKSPACE_GIT_COMMIT);
  await requireEmptyTarget(directory);

  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "");
  const answers = await resolver(hostname, { all: true, verbatim: true });
  if (!Array.isArray(answers) || answers.length === 0) throw new Error("Git workspace URL hostname did not resolve");
  for (const answer of answers) {
    const version = typeof answer?.address === "string" ? isIP(answer.address) : 0;
    if (version !== 4 || !isPublicIpv4(answer.address)) {
      throw new Error("Git workspace URL hostname resolved to a non-public address");
    }
  }
  const address = answers[0].address;
  const curlResolve = `${hostname}:${parsedUrl.port || "443"}:${address}`;

  const env = gitEnvironment(environment);
  const runGit = async (operation, args) => {
    try {
      return await runner(GIT, [
        ...GIT_CONFIG,
        "-c", `safe.directory=${directory}`,
        "-c", `http.curloptResolve=${curlResolve}`,
        ...args,
      ], { env, shell: false });
    } catch (error) {
      throw new Error(`Git workspace ${operation} failed${boundedError(error)}`);
    }
  };

  await runGit("initialization", ["init", "--quiet", directory]);
  await runGit("fetch", ["-C", directory, "fetch", "--quiet", "--no-tags", "--depth=1", "--no-recurse-submodules", url, commit]);
  await runGit("checkout", ["-C", directory, "checkout", "--quiet", "--detach", "--force", "FETCH_HEAD"]);
  const result = await runGit("verification", ["-C", directory, "rev-parse", "--verify", "HEAD^{commit}"]);
  if (result.stdout.trim().toLowerCase() !== commit) throw new Error("Git workspace verification returned an unexpected commit");
}

async function runEntrypoint() {
  await materializeWorkspace();
  const [command, ...args] = process.argv.slice(2);
  if (!command) return;

  const child = spawn(command, args, { env: process.env, shell: false, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`Command terminated by ${signal}`)) : resolve(code ?? 1));
  }).then((code) => { process.exitCode = code; });
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  runEntrypoint().catch((error) => {
    const message = error instanceof Error ? error.message : "Workspace materialization failed";
    console.error(message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 1024));
    process.exitCode = 1;
  });
}
