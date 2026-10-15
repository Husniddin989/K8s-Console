export type PageId =
  | 'overview' | 'namespaces' | 'nodes'
  | 'pods' | 'deployments' | 'statefulsets' | 'daemonsets' | 'jobs' | 'cronjobs'
  | 'services' | 'configmaps' | 'secrets'
  | 'events' | 'logs' | 'users' | 'audit'

/** Kinds as the API names them in URLs (kubectl plurals). */
export type ResourceKind = 'pods' | 'deployments' | 'statefulsets' | 'daemonsets' | 'jobs' | 'cronjobs' | 'services' | 'configmaps' | 'secrets' | 'namespaces' | 'nodes'

export interface NamespaceItem {
  name: string
  phase: string
  labels: Record<string, string>
  createdAt: string | null
}

export interface ClusterSummary {
  cluster: string
  kubernetesVersion: string
  nodeCount: number
  readyNodeCount: number
  namespaceCount: number
  podCount: number
  podCounts: Record<string, number>
  deploymentCount: number
  readyDeploymentCount: number
  serviceCount: number
}

export interface PodItem {
  name: string
  namespace: string
  phase: string
  /** kubectl STATUS column, e.g. Running, CrashLoopBackOff, Init:0/1. */
  status: string
  node: string
  restarts: number
  lastRestartAt: string | null
  ready: number
  containers: number
  containerNames: string[]
  images: string[]
  createdAt: string | null
  ip: string
  labels: Record<string, string>
}

export interface DeploymentItem {
  name: string
  namespace: string
  desired: number
  ready: number
  upToDate: number
  available: number
  containers: string[]
  images: string[]
  selector: string
  createdAt: string | null
}

export interface ServiceItem {
  name: string
  namespace: string
  type: string
  clusterIp: string
  externalIp: string
  ports: string
  selector: string
  createdAt: string | null
}

export interface NodeItem {
  name: string
  ready: boolean
  status: string
  roles: string[]
  kubeletVersion: string
  internalIp: string
  externalIp: string
  osImage: string
  kernelVersion: string
  containerRuntime: string
  architecture: string
  cpu: string
  memory: string
  pods: string
  createdAt: string | null
}

export interface EventItem {
  name: string
  namespace: string
  type: string
  reason: string
  message: string
  object: string
  count: number
  time: string | null
}

export type Role = 'viewer' | 'operator' | 'admin'

export interface SessionUser {
  username: string
  role: Role
  permissions: { read: boolean; operate: boolean; administer: boolean }
}

export interface AuthSession {
  user: SessionUser
  expiresAt: string
  /** False when the console runs read-only (CLUSTER_WRITES=false). */
  clusterWrites: boolean
}

export interface AdminUser {
  username: string
  role: Role
  /** config = Helm values / users file (read-only here); console = created in this UI. */
  source: 'config' | 'console'
  disabled: boolean
  createdAt: string | null
  createdBy: string | null
  lastLoginAt: string | null
}

export interface AuditEntry {
  id: number
  time: string
  username: string
  role: string
  action: string
  kind: string | null
  namespace: string | null
  name: string | null
  result: 'success' | 'failure'
  error: string | null
  details: Record<string, unknown> | null
  ip: string | null
}

export interface ApplyResult {
  ok: boolean
  dryRun: boolean
  results: Array<{ kind: string; namespace: string | null; name: string; operation: 'created' | 'configured' | 'unchanged' | 'failed'; error?: string }>
}

export interface StatefulSetItem {
  name: string
  namespace: string
  desired: number
  ready: number
  upToDate: number
  serviceName: string
  containers: string[]
  images: string[]
  createdAt: string | null
}

export interface DaemonSetItem {
  name: string
  namespace: string
  desired: number
  current: number
  ready: number
  upToDate: number
  available: number
  nodeSelector: string
  containers: string[]
  images: string[]
  createdAt: string | null
}

export interface JobItem {
  name: string
  namespace: string
  status: string
  succeeded: number
  completions: number
  active: number
  failed: number
  startTime: string | null
  completionTime: string | null
  owner: string | null
  containers: string[]
  images: string[]
  createdAt: string | null
}

export interface CronJobItem {
  name: string
  namespace: string
  schedule: string
  timeZone: string
  suspend: boolean
  active: number
  lastScheduleTime: string | null
  lastSuccessfulTime: string | null
  containers: string[]
  images: string[]
  createdAt: string | null
}

export interface ConfigMapItem {
  name: string
  namespace: string
  keys: string[]
  immutable: boolean
  createdAt: string | null
}

export interface SecretItem {
  name: string
  namespace: string
  type: string
  keys: string[]
  immutable: boolean
  createdAt: string | null
}

export interface SecretValues {
  name: string
  namespace: string
  type: string
  entries: Array<{ key: string; value: string; binary: boolean }>
}

/** The rows each extra list page shows, by page id. */
export interface ExtraLists {
  statefulsets: StatefulSetItem[]
  daemonsets: DaemonSetItem[]
  jobs: JobItem[]
  cronjobs: CronJobItem[]
  configmaps: ConfigMapItem[]
  secrets: SecretItem[]
}

/** Workloads with a pod template: they share restart, scale and image dialogs. */
export interface WorkloadRow {
  namespace: string
  name: string
  desired: number
  ready: number
  containers: string[]
  images: string[]
}
