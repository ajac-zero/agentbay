import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { K3sContainer, type StartedK3sContainer } from "@testcontainers/k3s";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHART_PATH = resolve(__dirname, "..", "..", "deploy", "helm", "agentbay");
const K3S_IMAGE = process.env.AGENTBAY_E2E_K3S_IMAGE ?? "rancher/k3s:v1.31.2-k3s1";
const AGENT_SANDBOX_VERSION = "v0.4.6";
const AGENT_SANDBOX_MANIFEST_URLS = [
  `https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml`,
  `https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/extensions.yaml`,
];
const NAMESPACE = "agentbay-helm-e2e";
const AGENT_SANDBOX_CRDS = [
  "sandboxes.agents.x-k8s.io",
  "sandboxclaims.extensions.agents.x-k8s.io",
  "sandboxtemplates.extensions.agents.x-k8s.io",
  "sandboxwarmpools.extensions.agents.x-k8s.io",
];

describe("agentbay Helm chart", () => {
  describe("static validation", () => {
    it("passes helm lint", () => {
      const result = helm(["lint", CHART_PATH]);
      expect(result.status, formatStderr(result)).toBe(0);
      expect(result.stdout).toMatch(/0 chart\(s\) failed/);
    });

    it("renders the default install", () => {
      const result = helm(["template", "demo", CHART_PATH, "--namespace", NAMESPACE]);
      expect(result.status, formatStderr(result)).toBe(0);
      expect(result.stdout).toMatch(/kind: Deployment/);
      expect(result.stdout).toMatch(/kind: ServiceAccount/);
      expect(result.stdout).toMatch(/kind: Role\b/);
      expect(result.stdout).toMatch(/kind: RoleBinding/);
      // In-cluster Redis is on by default
      expect(result.stdout).toMatch(/name: demo-agentbay-redis/);
      // No SandboxTemplate / WarmPool / Ingress unless opted in
      expect(result.stdout).not.toMatch(/kind: SandboxTemplate/);
      expect(result.stdout).not.toMatch(/kind: SandboxWarmPool/);
      expect(result.stdout).not.toMatch(/kind: Ingress/);
    });

    it("renders SandboxTemplates with a NetworkPolicy ingress selector that matches the orchestrator", () => {
      const result = helm([
        "template",
        "demo",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--set",
        "sandboxTemplates.enabled=true",
      ]);
      expect(result.status, formatStderr(result)).toBe(0);

      // The auto-rendered NetworkPolicy must reference the orchestrator's labels;
      // if these ever drift, sandbox pods will not accept orchestrator traffic.
      expect(result.stdout).toMatch(/kind: SandboxTemplate/);
      expect(result.stdout).toMatch(/app\.kubernetes\.io\/name: agentbay/);
      expect(result.stdout).toMatch(/app\.kubernetes\.io\/instance: demo/);
    });

    it("uses an external Redis URL from an existing Secret when configured", () => {
      const result = helm([
        "template",
        "demo",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--set",
        "redis.enabled=false",
        "--set",
        "redis.external.existingSecret=my-redis",
      ]);
      expect(result.status, formatStderr(result)).toBe(0);
      expect(result.stdout).not.toMatch(/name: demo-agentbay-redis/);
      expect(result.stdout).toMatch(/secretKeyRef:\s+name: my-redis/);
    });

    it("falls back to in-memory Chat SDK state when no Redis is configured", () => {
      const result = helm([
        "template",
        "demo",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--set",
        "redis.enabled=false",
      ]);
      expect(result.status, formatStderr(result)).toBe(0);
      expect(result.stdout).not.toMatch(/name: demo-agentbay-redis/);
      expect(result.stdout).not.toMatch(/REDIS_URL/);
    });

    it("renders the helm test connection Pod", () => {
      const result = helm(["template", "demo", CHART_PATH, "--namespace", NAMESPACE]);
      expect(result.status, formatStderr(result)).toBe(0);
      expect(result.stdout).toMatch(/name: demo-agentbay-test-connection/);
      expect(result.stdout).toMatch(/helm\.sh\/hook: test/);
    });
  });

  describe("against a live cluster", () => {
    let k3s: StartedK3sContainer | undefined;
    let workDir: string;
    let kubeConfigPath: string;

    beforeAll(async () => {
      k3s = await new K3sContainer(K3S_IMAGE).start();
      workDir = await mkdtemp(join(tmpdir(), "agentbay-helm-e2e-"));
      kubeConfigPath = join(workDir, "kubeconfig.yaml");
      await writeFile(kubeConfigPath, k3s.getKubeConfig());

      for (const url of AGENT_SANDBOX_MANIFEST_URLS) {
        const result = kubectl(kubeConfigPath, ["apply", "-f", url]);
        if (result.status !== 0) throw new Error(`kubectl apply ${url} failed: ${result.stderr}`);
      }

      for (const crd of AGENT_SANDBOX_CRDS) {
        const result = kubectl(kubeConfigPath, [
          "wait",
          "--for=condition=Established",
          `crd/${crd}`,
          "--timeout=60s",
        ]);
        if (result.status !== 0) {
          throw new Error(`CRD ${crd} did not become Established: ${result.stderr}`);
        }
      }

      const ns = kubectl(kubeConfigPath, ["create", "namespace", NAMESPACE]);
      if (ns.status !== 0 && !ns.stderr.includes("already exists")) {
        throw new Error(`kubectl create namespace failed: ${ns.stderr}`);
      }
    }, 180_000);

    afterAll(async () => {
      if (workDir) await rm(workDir, { force: true, recursive: true });
      await k3s?.stop();
    });

    it("server-side validates the default install", () => {
      const result = helm([
        "install",
        "agentbay-default",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--dry-run=server",
        "--kubeconfig",
        kubeConfigPath,
      ]);
      expect(result.status, formatStderr(result)).toBe(0);
    });

    it("server-side validates the kitchen-sink install (SandboxTemplate + WarmPool + Ingress)", () => {
      const result = helm([
        "install",
        "agentbay-full",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--dry-run=server",
        "--kubeconfig",
        kubeConfigPath,
        "--set",
        "sandboxTemplates.enabled=true",
        "--set",
        "sandboxWarmPools.enabled=true",
        "--set",
        "ingress.enabled=true",
      ]);
      expect(result.status, formatStderr(result)).toBe(0);
      // server-side dry-run echoes the rendered manifest; confirm the CRDs accept it
      expect(result.stdout).toMatch(/kind: SandboxTemplate/);
      expect(result.stdout).toMatch(/kind: SandboxWarmPool/);
    });

    it("server-side validates an external-Redis configuration", () => {
      const result = helm([
        "install",
        "agentbay-extredis",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--dry-run=server",
        "--kubeconfig",
        kubeConfigPath,
        "--set",
        "redis.enabled=false",
        "--set",
        "redis.external.url=redis://example:6379",
      ]);
      expect(result.status, formatStderr(result)).toBe(0);
    });
  });
});

function helm(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("helm", args, { encoding: "utf8" });
}

function kubectl(kubeConfigPath: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("kubectl", ["--kubeconfig", kubeConfigPath, ...args], { encoding: "utf8" });
}

function formatStderr(result: SpawnSyncReturns<string>): string {
  return `exit=${result.status}\nstderr=${result.stderr}\nstdout=${result.stdout}`;
}

