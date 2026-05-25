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
      // In-cluster Redis and Postgres are on by default
      expect(result.stdout).toMatch(/name: demo-agentbay-redis/);
      expect(result.stdout).toMatch(/name: demo-agentbay-postgres/);
      expect(result.stdout).toMatch(/name: AGENTBAY_DATABASE_HOST/);
      expect(result.stdout).toMatch(/name: AGENTBAY_DATABASE_PASSWORD/);
      expect(result.stdout).toMatch(/name: demo-agentbay-migrate-1/);
      expect(result.stdout).not.toMatch(/helm\.sh\/hook: "post-install,pre-upgrade"/);
      expect(result.stdout).toMatch(/command: \["node", "dist\/migrate\.js"\]/);
      expect(result.stdout).not.toMatch(/name: demo-agentbay-runtime-seed/);
      // No SandboxTemplate / WarmPool / Ingress unless opted in
      expect(result.stdout).not.toMatch(/kind: SandboxTemplate/);
      expect(result.stdout).not.toMatch(/kind: SandboxWarmPool/);
      expect(result.stdout).not.toMatch(/kind: Ingress/);
    });

    it("renders a runtime seed hook without opinionated records when enabled", () => {
      const result = helm([
        "template",
        "demo",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--set",
        "runtimeSeed.enabled=true",
      ]);
      expect(result.status, formatStderr(result)).toBe(0);
      expect(result.stdout).toMatch(/name: demo-agentbay-runtime-seed/);
      expect(result.stdout).toMatch(/helm\.sh\/hook: post-install,post-upgrade/);
      expect(result.stdout).toMatch(/key: AGENTBAY_ADMIN_TOKEN/);
      expect(result.stdout).not.toMatch(/\/admin\/runtime\/opencode-configs\/opencode-config-default/);
      expect(result.stdout).not.toMatch(/\/admin\/runtime\/sandbox-profiles\/sandbox-profile-default/);
      expect(result.stdout).not.toMatch(/\/admin\/runtime\/agent-profiles\/agent-profile-agentbay/);
      expect(result.stdout).not.toMatch(/\/admin\/runtime\/bots\/bot-agentbay/);
    });

    it("renders explicit runtime seed records when configured", () => {
      const result = helm([
        "template",
        "demo",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--set",
        "runtimeSeed.enabled=true",
        "--set",
        "runtimeSeed.opencodeConfigs[0].id=opencode-config-default",
        "--set",
        "runtimeSeed.opencodeConfigs[0].slug=default",
        "--set",
        "runtimeSeed.opencodeConfigs[0].displayName=Default",
        "--set",
        "runtimeSeed.opencodeConfigs[0].enabled=true",
        "--set",
        "runtimeSeed.opencodeConfigs[0].config.default_agent=agentbay",
        "--set",
        "runtimeSeed.opencodeConfigs[0].config.agent.agentbay.prompt=Prompt",
        "--set",
        "runtimeSeed.sandboxProfiles[0].id=sandbox-profile-default",
        "--set",
        "runtimeSeed.sandboxProfiles[0].slug=default",
        "--set",
        "runtimeSeed.sandboxProfiles[0].templateName=opencode-template",
        "--set",
        "runtimeSeed.sandboxProfiles[0].warmpool=none",
        "--set",
        "runtimeSeed.sandboxProfiles[0].enabled=true",
        "--set",
        "runtimeSeed.agentProfiles[0].id=agent-profile-agentbay",
        "--set",
        "runtimeSeed.agentProfiles[0].slug=agentbay",
        "--set",
        "runtimeSeed.agentProfiles[0].displayName=agentbay",
        "--set",
        "runtimeSeed.agentProfiles[0].opencodeConfigID=opencode-config-default",
        "--set",
        "runtimeSeed.agentProfiles[0].opencodeAgentName=agentbay",
        "--set",
        "runtimeSeed.agentProfiles[0].enabled=true",
        "--set",
        "runtimeSeed.bots[0].id=bot-agentbay",
        "--set",
        "runtimeSeed.bots[0].slug=agentbay",
        "--set",
        "runtimeSeed.bots[0].displayName=agentbay",
        "--set",
        "runtimeSeed.bots[0].adapters.telegram.botTokenEnv=TELEGRAM_BOT_TOKEN",
        "--set",
        "runtimeSeed.bots[0].sandboxProfileID=sandbox-profile-default",
        "--set",
        "runtimeSeed.bots[0].defaultAgentProfileID=agent-profile-agentbay",
        "--set",
        "runtimeSeed.bots[0].enabled=true",
      ]);
      expect(result.status, formatStderr(result)).toBe(0);
      expect(result.stdout).toMatch(/PUT "\/admin\/runtime\/opencode-configs\/opencode-config-default"/);
      expect(result.stdout).toMatch(/PUT "\/admin\/runtime\/sandbox-profiles\/sandbox-profile-default"/);
      expect(result.stdout).toMatch(/PUT "\/admin\/runtime\/agent-profiles\/agent-profile-agentbay"/);
      expect(result.stdout).toMatch(/PUT "\/admin\/runtime\/bots\/bot-agentbay"/);
      expect(result.stdout).toMatch(/"slug":"agentbay"/);
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

    it("renders SandboxTemplate sidecars and extra volumes", async () => {
      const workDir = await mkdtemp(join(tmpdir(), "agentbay-helm-values-"));
      try {
        const valuesPath = join(workDir, "values.yaml");
        await writeFile(
          valuesPath,
          `sandboxTemplates:
  enabled: true
  templates:
    - name: opencode-template
      image:
        repository: ghcr.io/example/opencode-sandbox
        tag: latest
      port: 4096
      workingDir: /workspace
      command: ["opencode"]
      args: ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
      workspace:
        type: emptyDir
      networkPolicy:
        ingressFromOrchestrator: true
        extraIngress: []
        egress:
          allowDNS: true
          allowInternetExceptPrivate: false
          extra: []
      extraVolumeMounts:
        - name: opencode-cache
          mountPath: /tmp/opencode-cache
      sidecars:
        - name: agentbay-authz
          image: example/agentbay-authz:latest
          ports:
            - name: authz
              containerPort: 8080
          volumeMounts:
            - name: agentbay-authz-token
              mountPath: /var/run/secrets/agentbay-authz
              readOnly: true
      extraVolumes:
        - name: opencode-cache
          emptyDir: {}
        - name: agentbay-authz-token
          emptyDir:
            medium: Memory
`,
        );
        const result = helm(["template", "demo", CHART_PATH, "--namespace", NAMESPACE, "-f", valuesPath]);
        expect(result.status, formatStderr(result)).toBe(0);
        expect(result.stdout).toMatch(/name: opencode/);
        expect(result.stdout).toMatch(/mountPath: \/tmp\/opencode-cache/);
        expect(result.stdout).toMatch(/name: agentbay-authz/);
        expect(result.stdout).toMatch(/image: example\/agentbay-authz:latest/);
        expect(result.stdout).toMatch(/containerPort: 8080/);
        expect(result.stdout).toMatch(/mountPath: \/var\/run\/secrets\/agentbay-authz/);
        expect(result.stdout).toMatch(/name: agentbay-authz-token/);
        expect(result.stdout).toMatch(/medium: Memory/);
      } finally {
        await rm(workDir, { force: true, recursive: true });
      }
    });

    it("renders aiGatewayAuthz resources and sandbox proxy wiring", async () => {
      const workDir = await mkdtemp(join(tmpdir(), "agentbay-helm-values-"));
      try {
        const valuesPath = join(workDir, "values.yaml");
        await writeFile(
          valuesPath,
          `aiGatewayAuthz:
  enabled: true
  upstreamBaseURL: http://envoy-ai-gateway.ai-gateway.svc.cluster.local:8080
  networkPolicy:
    egress:
      namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ai-gateway
      podSelector:
        matchLabels:
          app.kubernetes.io/name: envoy-ai-gateway
      ports:
        - protocol: TCP
          port: 8080
sandboxTemplates:
  enabled: true
  templates:
    - name: opencode-template
      image:
        repository: ghcr.io/example/opencode-sandbox
        tag: latest
      port: 4096
      workingDir: /workspace
      command: ["opencode"]
      args: ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
      workspace:
        type: emptyDir
      networkPolicy:
        ingressFromOrchestrator: true
        extraIngress: []
        egress:
          allowDNS: true
          allowInternetExceptPrivate: false
          extra: []
`,
        );
        const result = helm(["template", "demo", CHART_PATH, "--namespace", NAMESPACE, "-f", valuesPath]);
        expect(result.status, formatStderr(result)).toBe(0);
        expect(result.stdout).toMatch(/name: demo-agentbay-authz/);
        expect(result.stdout).toMatch(/kind: ClusterRole/);
        expect(result.stdout).toMatch(/resources: \["tokenreviews"\]/);
        expect(result.stdout).toMatch(/name: sandbox-runtime/);
        expect(result.stdout).toMatch(/serviceAccountName: sandbox-runtime/);
        expect(result.stdout).toMatch(/name: agentbay-gateway-proxy/);
        expect(result.stdout).toMatch(/name: UPSTREAM_BASE_URL/);
        expect(result.stdout).toMatch(/http:\/\/envoy-ai-gateway\.ai-gateway\.svc\.cluster\.local:8080/);
        expect(result.stdout).toMatch(/name: agentbay-ai-gateway-token/);
        expect(result.stdout).toMatch(/audience: "ai-gateway"/);
        expect(result.stdout).toMatch(/agentbay-gateway/);
        expect(result.stdout).toMatch(/app\.kubernetes\.io\/name: envoy-ai-gateway/);
        expect(result.stdout).toMatch(/name: SANDBOX_CLAIM_API_VERSION/);
        expect(result.stdout).toMatch(/value: "v1alpha1"/);
      } finally {
        await rm(workDir, { force: true, recursive: true });
      }
    });

    it("renders beta agent-sandbox API versions when configured", () => {
      const result = helm([
        "template",
        "demo",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--set",
        "claims.apiVersion=v1beta1",
        "--set",
        "sandboxTemplates.enabled=true",
        "--set",
        "sandboxWarmPools.enabled=true",
      ]);
      expect(result.status, formatStderr(result)).toBe(0);
      expect(result.stdout).toMatch(/name: AGENTBAY_SANDBOX_CLAIM_API_VERSION\s+value: "v1beta1"/);
      expect(result.stdout).toMatch(/apiVersion: extensions\.agents\.x-k8s\.io\/v1beta1/);
      expect(result.stdout).toMatch(/kind: SandboxTemplate/);
      expect(result.stdout).toMatch(/kind: SandboxWarmPool/);
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

    it("uses an external Postgres URL from an existing Secret when configured", () => {
      const result = helm([
        "template",
        "demo",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--set",
        "database.enabled=false",
        "--set",
        "database.external.existingSecret=my-postgres",
      ]);
      expect(result.status, formatStderr(result)).toBe(0);
      expect(result.stdout).toMatch(/name: AGENTBAY_DATABASE_URL/);
      expect(result.stdout).toMatch(/secretKeyRef:\s+name: my-postgres/);
      expect(result.stdout).toMatch(/helm\.sh\/hook: "pre-install,pre-upgrade"/);
      expect(result.stdout).not.toMatch(/name: demo-agentbay-migrate[\s\S]*envFrom:\s+- secretRef:\s+name: demo-agentbay/);
      expect(result.stdout).not.toMatch(/name: demo-agentbay-postgres/);
    });

    it("uses a generic existing Secret for migration database config when database mode is unset", () => {
      const result = helm([
        "template",
        "demo",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--set",
        "database.enabled=false",
        "--set",
        "secrets.existingSecret=agentbay-secrets",
      ]);
      expect(result.status, formatStderr(result)).toBe(0);
      expect(result.stdout).toMatch(/name: demo-agentbay-migrate/);
      expect(result.stdout).toMatch(/helm\.sh\/hook: "pre-install,pre-upgrade"/);
      expect(result.stdout).toMatch(/name: demo-agentbay-migrate[\s\S]*envFrom:\s+- secretRef:\s+name: agentbay-secrets\s+optional: false/);
    });

    it("rejects chart-managed Secret database URLs for migration hooks", () => {
      const result = helm([
        "template",
        "demo",
        CHART_PATH,
        "--namespace",
        NAMESPACE,
        "--set",
        "database.enabled=false",
        "--set-string",
        "secrets.data.AGENTBAY_DATABASE_URL=postgres://agentbay:agentbay@example:5432/agentbay",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/migrations\.enabled=true cannot use secrets\.data\.AGENTBAY_DATABASE_URL/);
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
