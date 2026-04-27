import { config } from "../src/config.ts";
import { getKubernetesClients, listSandboxClaims } from "../src/k8s/client.ts";

async function main() {
  const clients = getKubernetesClients();
  const claims = await listSandboxClaims();

  console.log(
    JSON.stringify(
      {
        kubeConfigSource: clients.source,
        namespace: config.kubernetes.namespace,
        claimCount: claims.items.length,
        claims: claims.items
          .map((claim) => claim.metadata?.name)
          .filter((name) => name !== undefined),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error("Failed to list SandboxClaims", error);
  process.exit(1);
});
