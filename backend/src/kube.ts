import * as k8s from '@kubernetes/client-node'

export interface KubeClients {
  kubeConfig: k8s.KubeConfig
  coreApi: k8s.CoreV1Api
  appsApi: k8s.AppsV1Api
  batchApi: k8s.BatchV1Api
  /** Generic client for any kind, used for YAML view and server-side apply. */
  objectApi: k8s.KubernetesObjectApi
  clusterName: string
}

export function createKubeClients(kubeConfig: k8s.KubeConfig, clusterName?: string): KubeClients {
  return {
    kubeConfig,
    coreApi: kubeConfig.makeApiClient(k8s.CoreV1Api),
    appsApi: kubeConfig.makeApiClient(k8s.AppsV1Api),
    batchApi: kubeConfig.makeApiClient(k8s.BatchV1Api),
    objectApi: k8s.KubernetesObjectApi.makeApiClient(kubeConfig),
    clusterName: clusterName || kubeConfig.getCurrentContext() || 'kubernetes',
  }
}

export function loadKubeClients(env: Record<string, string | undefined> = process.env): KubeClients {
  const kubeConfig = new k8s.KubeConfig()
  if (env.KUBERNETES_SERVICE_HOST) {
    kubeConfig.loadFromCluster()
  } else {
    kubeConfig.loadFromDefault()
  }
  return createKubeClients(kubeConfig, env.CLUSTER_NAME)
}
