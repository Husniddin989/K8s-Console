export type PageId = 'overview' | 'namespaces' | 'pods' | 'deployments' | 'services' | 'nodes' | 'events' | 'logs' | 'users' | 'audit'

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

export type YamlKind = 'pod' | 'deployment' | 'service' | 'namespace' | 'node'
