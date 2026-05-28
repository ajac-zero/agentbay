import { CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";

export function createKubeConfig(): KubeConfig {
  const kubeConfig = new KubeConfig();

  if (process.env.KUBECONFIG) {
    kubeConfig.loadFromFile(process.env.KUBECONFIG);
  } else {
    try {
      kubeConfig.loadFromCluster();
    } catch {
      kubeConfig.loadFromDefault();
    }
  }

  return kubeConfig;
}

export function createCustomObjectsApi(): CustomObjectsApi {
  return createKubeConfig().makeApiClient(CustomObjectsApi);
}
