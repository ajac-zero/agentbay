import { readFile as nodeReadFile } from "node:fs/promises";
import { createPrivateKey } from "node:crypto";

const DEFAULT_CREDENTIAL_PATHS = Object.freeze({
  appId: "/var/run/agentbay/github-app/app-id",
  installationId: "/var/run/agentbay/github-app/installation-id",
  privateKey: "/var/run/agentbay/github-app/private-key.pem",
});

function requiredString(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`Invalid or missing ${name}`);
  }
  return value;
}

function parsePositiveSafeInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

function assertSimpleValue(value, name, maximum) {
  if (value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${name}`);
}

function credentialPath(env, name, fallback) {
  if (!(name in env)) return fallback;
  return requiredString(env, name);
}

export function parseStartupConfig(env = process.env) {
  const tenantId = requiredString(env, "AGENTBAY_GITHUB_TENANT");
  const connectionRef = requiredString(env, "AGENTBAY_GITHUB_CONNECTION");
  const owner = requiredString(env, "AGENTBAY_GITHUB_REPOSITORY_OWNER");
  const repository = requiredString(env, "AGENTBAY_GITHUB_REPOSITORY_NAME");
  const repositoryId = parsePositiveSafeInteger(
    requiredString(env, "AGENTBAY_GITHUB_REPOSITORY_ID"),
    "AGENTBAY_GITHUB_REPOSITORY_ID",
  );

  assertSimpleValue(tenantId, "AGENTBAY_GITHUB_TENANT", 128);
  assertSimpleValue(connectionRef, "AGENTBAY_GITHUB_CONNECTION", 128);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    throw new Error("Invalid AGENTBAY_GITHUB_REPOSITORY_OWNER");
  }
  if (repository.length > 100 || repository === "." || repository === ".." || !/^[A-Za-z0-9._-]+$/.test(repository)) {
    throw new Error("Invalid AGENTBAY_GITHUB_REPOSITORY_NAME");
  }

  let connections;
  try {
    connections = JSON.parse(requiredString(env, "AGENTBAY_CONNECTIONS"));
  } catch {
    throw new Error("Invalid AGENTBAY_CONNECTIONS");
  }
  if (connections === null || typeof connections !== "object" || Array.isArray(connections)) {
    throw new Error("Invalid AGENTBAY_CONNECTIONS");
  }
  const keys = Object.keys(connections).sort();
  if (keys.length !== 3 || keys[0] !== "refs" || keys[1] !== "schemaVersion" || keys[2] !== "tenantId") {
    throw new Error("Invalid AGENTBAY_CONNECTIONS keys");
  }
  if (
    connections.schemaVersion !== 1 ||
    connections.tenantId !== tenantId ||
    !Array.isArray(connections.refs) ||
    connections.refs.length !== 1 ||
    connections.refs[0] !== connectionRef
  ) {
    throw new Error("AGENTBAY_CONNECTIONS does not match this sidecar");
  }

  return Object.freeze({
    tenantId,
    connectionRef,
    owner,
    repository,
    repositoryId,
    credentialPaths: Object.freeze({
      appId: credentialPath(env, "AGENTBAY_GITHUB_APP_ID_FILE", DEFAULT_CREDENTIAL_PATHS.appId),
      installationId: credentialPath(
        env,
        "AGENTBAY_GITHUB_INSTALLATION_ID_FILE",
        DEFAULT_CREDENTIAL_PATHS.installationId,
      ),
      privateKey: credentialPath(env, "AGENTBAY_GITHUB_PRIVATE_KEY_FILE", DEFAULT_CREDENTIAL_PATHS.privateKey),
    }),
  });
}

export async function readGitHubAppCredentials(paths, options = {}) {
  const readFile = options.readFile ?? nodeReadFile;
  let appIdText;
  let installationIdText;
  let privateKey;
  try {
    [appIdText, installationIdText, privateKey] = await Promise.all([
      readFile(paths.appId, "utf8"),
      readFile(paths.installationId, "utf8"),
      readFile(paths.privateKey, "utf8"),
    ]);
  } catch {
    throw new Error("Unable to read GitHub App credentials");
  }

  const appId = parsePositiveSafeInteger(appIdText.trim(), "GitHub App ID credential");
  const installationId = parsePositiveSafeInteger(installationIdText.trim(), "GitHub installation ID credential");
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "rsa") throw new Error("Not an RSA key");
  } catch {
    throw new Error("Invalid GitHub App private key credential");
  }
  return Object.freeze({ appId, installationId, privateKey });
}

export { DEFAULT_CREDENTIAL_PATHS };
