import { CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";

export function createCustomObjectsApi(): CustomObjectsApi {
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

  return kubeConfig.makeApiClient(CustomObjectsApi);
}
