import type { AdminUser, ApplyResult, AuditEntry, AuthSession, ClusterSummary, DeploymentItem, EventItem, NamespaceItem, NodeItem, PodItem, Role, ServiceItem, YamlKind } from './types'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Thrown when the session is missing or expired; the app returns to the sign-in page. */
export class AuthRequiredError extends ApiError {
  constructor(message = 'Sign in to continue') {
    super(message, 401)
  }
}

async function request<T>(path: string, init: RequestInit = {}, as: 'json' | 'text' = 'json'): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init, headers: { Accept: 'application/json', ...init.headers } })
  } catch (error) {
    if (init.signal?.aborted) throw error
    throw new ApiError('Cannot reach the console API. Check that the backend or port-forward is running.', 0)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    const message = body.error || (response.status >= 502 && response.status <= 504
      ? 'The console API is not responding (' + response.status + '). Check that the backend or port-forward is running.'
      : 'Request failed (' + response.status + ')')
    if (response.status === 401) throw new AuthRequiredError(message)
    throw new ApiError(message, response.status)
  }
  if (response.status === 204) return undefined as T
  return (as === 'text' ? response.text() : response.json()) as Promise<T>
}

function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { signal })
}

function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const segment = encodeURIComponent

function query(namespace: string): string {
  return '?namespace=' + encodeURIComponent(namespace)
}

export const api = {
  me: async (): Promise<AuthSession | null> => {
    try {
      return await request<AuthSession>('/api/auth/me')
    } catch (error) {
      if (error instanceof AuthRequiredError) return null
      throw error
    }
  },
  login: (username: string, password: string) => request<AuthSession>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  namespaces: (signal?: AbortSignal) => getJson<NamespaceItem[]>('/api/namespaces', signal),
  summary: (namespace: string, signal?: AbortSignal) => getJson<ClusterSummary>('/api/cluster/summary' + query(namespace), signal),
  pods: (namespace: string, signal?: AbortSignal) => getJson<PodItem[]>('/api/pods' + query(namespace), signal),
  deployments: (namespace: string, signal?: AbortSignal) => getJson<DeploymentItem[]>('/api/deployments' + query(namespace), signal),
  services: (namespace: string, signal?: AbortSignal) => getJson<ServiceItem[]>('/api/services' + query(namespace), signal),
  nodes: (signal?: AbortSignal) => getJson<NodeItem[]>('/api/nodes', signal),
  events: (namespace: string, signal?: AbortSignal) => getJson<EventItem[]>('/api/events' + query(namespace), signal),

  yaml: (kind: YamlKind, namespace: string, name: string) => request<string>('/api/yaml/' + kind + '/' + segment(namespace || '_') + '/' + segment(name), { headers: { Accept: 'application/yaml' } }, 'text'),
  apply: (yaml: string, dryRun: boolean) => send<ApplyResult>('POST', '/api/apply', { yaml, dryRun }),
  restartDeployment: (namespace: string, name: string) => send<void>('POST', '/api/deployments/' + segment(namespace) + '/' + segment(name) + '/restart'),
  scaleDeployment: (namespace: string, name: string, replicas: number) => send<void>('POST', '/api/deployments/' + segment(namespace) + '/' + segment(name) + '/scale', { replicas }),
  setImage: (namespace: string, name: string, container: string, image: string) => send<void>('POST', '/api/deployments/' + segment(namespace) + '/' + segment(name) + '/image', { container, image }),
  deletePod: (namespace: string, name: string) => send<void>('DELETE', '/api/pods/' + segment(namespace) + '/' + segment(name)),
  deleteDeployment: (namespace: string, name: string) => send<void>('DELETE', '/api/deployments/' + segment(namespace) + '/' + segment(name)),
  deleteService: (namespace: string, name: string) => send<void>('DELETE', '/api/services/' + segment(namespace) + '/' + segment(name)),
  deleteNamespace: (name: string) => send<void>('DELETE', '/api/namespaces/' + segment(name)),
  debugPod: (namespace: string, name: string, target: string, image: string) => send<{ container: string }>('POST', '/api/pods/' + segment(namespace) + '/' + segment(name) + '/debug', { target, image }),

  users: () => request<AdminUser[]>('/api/admin/users'),
  createUser: (user: { username: string; role: Role; password: string }) => send<AdminUser>('POST', '/api/admin/users', user),
  updateUser: (username: string, changes: { role?: Role; password?: string; disabled?: boolean }) => send<AdminUser>('PATCH', '/api/admin/users/' + segment(username), changes),
  deleteUser: (username: string) => send<void>('DELETE', '/api/admin/users/' + segment(username)),
  audit: (filters: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    return request<{ entries: AuditEntry[]; actions: string[] }>('/api/admin/audit?' + params.toString())
  },
}
