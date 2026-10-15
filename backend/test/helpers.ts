import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as k8s from '@kubernetes/client-node'
import { createApp } from '../src/app.js'
import { AuthService, hashPassword, LoginThrottle, type Role, type UserRecord } from '../src/auth.js'
import type { KubeClients } from '../src/kube.js'
import { attachWebSockets } from '../src/sockets.js'
import { ConsoleStore } from '../src/store.js'

export const passwords: Record<Role, string> = {
  viewer: 'viewer password 1',
  operator: 'operator password 1',
  admin: 'admin password 1',
}

let cachedUsers: Promise<UserRecord[]> | undefined
export function testUsers(): Promise<UserRecord[]> {
  cachedUsers ??= Promise.all((Object.keys(passwords) as Role[]).map(async (role) => ({
    username: role,
    role,
    passwordHash: await hashPassword(passwords[role]),
  })))
  return cachedUsers
}

const pod = {
  metadata: { name: 'web-1', namespace: 'default', creationTimestamp: new Date('2026-01-01T00:00:00Z') },
  spec: { nodeName: 'node-a', containers: [{ name: 'app' }] },
  status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 2 }] },
}

export interface FakeCall {
  api: 'core' | 'apps' | 'batch' | 'object'
  method: string
  args: unknown[]
}

type Overrides = Partial<Record<string, (...args: unknown[]) => Promise<unknown>>>

const deployment = {
  metadata: { name: 'web', namespace: 'default' },
  spec: { replicas: 2, template: { spec: { containers: [{ name: 'app', image: 'nginx:1.26' }] } } },
}

/** A stand-in for the Kubernetes client that returns one of everything and records every call. */
const secret = { metadata: { name: 'db', namespace: 'default' }, type: 'Opaque', data: { password: Buffer.from('s3cret!').toString('base64'), 'tls.der': Buffer.from([0, 159, 146, 150]).toString('base64') } }

/** objectApi.read returns these by kind; anything else is 404. */
const objects: Record<string, unknown> = {
  Deployment: deployment,
  StatefulSet: { ...deployment, kind: 'StatefulSet', metadata: { name: 'db', namespace: 'default' } },
  DaemonSet: { metadata: { name: 'agent', namespace: 'default' }, spec: { template: { spec: { containers: [{ name: 'agent', image: 'agent:1' }] } } } },
  Pod: pod,
  Service: { metadata: { name: 'web', namespace: 'default' }, spec: { type: 'ClusterIP', ports: [{ port: 80 }] } },
  Secret: secret,
  ConfigMap: { metadata: { name: 'settings', namespace: 'default' }, data: { mode: 'fast' } },
  Job: { metadata: { name: 'once', namespace: 'default' }, spec: { template: { spec: { containers: [{ name: 'job', image: 'busybox' }] } } } },
  CronJob: { metadata: { name: 'nightly', namespace: 'default' }, spec: { schedule: '0 1 * * *' } },
}

export function fakeKube(overrides: Overrides = {}, kubeConfig = new k8s.KubeConfig(), extra: { apps?: Overrides; batch?: Overrides; object?: Overrides } = {}): KubeClients & { calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const record = (api: FakeCall['api'], methods: Record<string, (...args: unknown[]) => Promise<unknown>>) => Object.fromEntries(
    Object.entries(methods).map(([method, implementation]) => [method, async (...args: unknown[]) => {
      calls.push({ api, method, args })
      return implementation(...args)
    }]),
  )
  const list = (items: unknown[]) => async () => ({ items })
  const ok = async () => ({})
  const coreApi = {
    listNamespace: list([{ metadata: { name: 'default' }, status: { phase: 'Active' } }]),
    listNode: list([{ metadata: { name: 'node-a', labels: { 'node-role.kubernetes.io/control-plane': '' } }, status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.34.0' } } }]),
    listPodForAllNamespaces: list([pod]),
    listNamespacedPod: list([pod]),
    listEventForAllNamespaces: list([]),
    listNamespacedEvent: list([]),
    readNamespacedPodLog: async () => 'log line\n',
    listServiceForAllNamespaces: list([{ metadata: { name: 'kubernetes', namespace: 'default' }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.1', ports: [{ port: 443, protocol: 'TCP' }] } }]),
    listNamespacedService: list([]),
    readNamespacedPod: async () => structuredClone(pod),
    deleteNamespacedPod: ok,
    readNamespacedService: async () => ({ spec: { type: 'ClusterIP', clusterIP: '10.96.0.20', ports: [{ port: 80 }] } }),
    deleteNamespacedService: ok,
    deleteNamespace: ok,
    readNamespacedSecret: async () => structuredClone(secret),
    listSecretForAllNamespaces: list([secret]),
    listNamespacedSecret: list([secret]),
    listConfigMapForAllNamespaces: list([]),
    listNamespacedConfigMap: list([]),
    replaceNamespacedPodEphemeralcontainers: ok,
    ...overrides,
  }
  const appsApi = {
    listDeploymentForAllNamespaces: list([]),
    listNamespacedDeployment: list([]),
    readNamespacedDeployment: async () => structuredClone(deployment),
    patchNamespacedDeployment: ok,
    deleteNamespacedDeployment: ok,
    listStatefulSetForAllNamespaces: list([]),
    listNamespacedStatefulSet: list([]),
    listDaemonSetForAllNamespaces: list([]),
    listNamespacedDaemonSet: list([]),
    ...extra.apps,
  }
  const batchApi = {
    listJobForAllNamespaces: list([]),
    listNamespacedJob: list([]),
    listCronJobForAllNamespaces: list([]),
    listNamespacedCronJob: list([]),
    readNamespacedCronJob: async () => ({
      metadata: { name: 'nightly', namespace: 'default', uid: 'cron-uid' },
      spec: { schedule: '0 1 * * *', jobTemplate: { metadata: { labels: { app: 'nightly' } }, spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name: 'job', image: 'busybox' }] } } } } },
    }),
    ...extra.batch,
  }
  const objectApi = {
    read: async (header: { kind: string }) => {
      if (objects[header.kind]) return structuredClone(objects[header.kind])
      throw Object.assign(new Error('not found'), { code: 404 })
    },
    create: async (body: unknown) => body,
    delete: ok,
    patch: async (body: unknown) => ({ ...(body as object), metadata: { ...(body as { metadata: object }).metadata, resourceVersion: '2' } }),
    ...extra.object,
  }
  return {
    kubeConfig,
    coreApi: record('core', coreApi),
    appsApi: record('apps', appsApi),
    batchApi: record('batch', batchApi),
    objectApi: record('object', objectApi),
    clusterName: 'test-cluster',
    calls,
  } as unknown as KubeClients & { calls: FakeCall[] }
}

export interface TestServer {
  url: string
  host: string
  server: Server
  auth: AuthService
  store: ConsoleStore
  close: () => Promise<void>
  login: (role: Role | string, password?: string) => Promise<string>
}

export async function startTestServer(options: { kube?: KubeClients; sessionTtlMs?: number; trustedOrigins?: string[]; clusterWrites?: boolean; users?: UserRecord[] } = {}): Promise<TestServer> {
  const store = new ConsoleStore(':memory:')
  const auth = new AuthService({ users: options.users ?? await testUsers(), store, sessionSecret: 's'.repeat(40), sessionTtlMs: options.sessionTtlMs ?? 60_000 })
  const kube = options.kube ?? fakeKube()
  const clusterWrites = options.clusterWrites ?? true
  const app = createApp({ kube, auth, store, clusterWrites, cookieSecurity: 'auto', trustedOrigins: options.trustedOrigins ?? [], loginThrottle: new LoginThrottle(3, 60_000), protectedNamespaces: ['default', 'kube-system'] })
  const server = createServer(app)
  const sockets = attachWebSockets(server, { kube, auth, store, trustedOrigins: options.trustedOrigins ?? [], clusterWrites })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const host = '127.0.0.1:' + port
  const url = 'http://' + host

  const login = async (role: Role | string, password?: string) => {
    const response = await fetch(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ username: role, password: password ?? passwords[role as Role] }),
    })
    if (response.status !== 200) throw new Error('Login failed with ' + response.status)
    const cookie = response.headers.get('set-cookie') || ''
    return cookie.split(';')[0]
  }

  const close = async () => {
    for (const client of sockets.clients) client.terminate()
    await new Promise<void>((resolve) => sockets.close(() => resolve()))
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
  }

  return { url, host, server, auth, store, close, login }
}
