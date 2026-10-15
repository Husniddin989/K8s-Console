import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Role } from '../src/auth.js'
import { fakeKube, startTestServer, type TestServer } from './helpers.js'

let running: TestServer | undefined
async function start(...args: Parameters<typeof startTestServer>) {
  running = await startTestServer(...args)
  return running
}
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function call(server: TestServer, cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(server.url + path, {
    method,
    headers: { Cookie: cookie, Origin: server.url, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

/** Every write endpoint with the lowest role allowed to use it. */
const writes: Array<{ method: string; path: string; body?: unknown; role: Role }> = [
  { method: 'POST', path: '/api/deployments/default/web/restart', role: 'operator' },
  { method: 'POST', path: '/api/deployments/default/web/scale', body: { replicas: 3 }, role: 'operator' },
  { method: 'POST', path: '/api/deployments/default/web/image', body: { container: 'app', image: 'nginx:1.27' }, role: 'operator' },
  { method: 'DELETE', path: '/api/pods/default/web-1', role: 'operator' },
  { method: 'DELETE', path: '/api/deployments/default/web', role: 'admin' },
  { method: 'DELETE', path: '/api/services/default/web', role: 'admin' },
  { method: 'DELETE', path: '/api/namespaces/team-a', role: 'admin' },
  { method: 'POST', path: '/api/pods/default/web-1/debug', body: { target: 'app' }, role: 'admin' },
  { method: 'POST', path: '/api/apply', body: { yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n  namespace: default\n' }, role: 'admin' },
]
const rank: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

describe('role enforcement on cluster changes', () => {
  it.each(writes)('$method $path is allowed from $role up', async ({ method, path, body, role }) => {
    const server = await start()
    for (const actor of ['viewer', 'operator', 'admin'] as Role[]) {
      const cookie = await server.login(actor)
      const result = await call(server, cookie, method, path, body)
      if (rank[actor] < rank[role]) expect(result.status, actor).toBe(403)
      else expect(result.status, actor + ' ' + JSON.stringify(result.body)).toBe(200)
    }
  })

  it('rejects every change when cluster writes are off, but still allows reading YAML', async () => {
    const server = await start({ clusterWrites: false, kube: fakeKube({}, undefined, { object: { read: async () => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web-1' } }) } }) })
    const cookie = await server.login('admin')
    for (const { method, path, body } of writes) {
      const result = await call(server, cookie, method, path, body)
      expect(result.status, path).toBe(403)
      expect(result.body.error).toMatch(/turned off/)
    }
    expect((await call(server, cookie, 'GET', '/api/auth/me')).body.clusterWrites).toBe(false)
    const yaml = await fetch(server.url + '/api/yaml/pod/default/web-1', { headers: { Cookie: cookie } })
    expect(yaml.status).toBe(200)
  })

  it('rejects writes without a session and from other origins', async () => {
    const server = await start()
    expect((await fetch(server.url + '/api/deployments/default/web/restart', { method: 'POST' })).status).toBe(401)
    const cookie = await server.login('admin')
    const crossSite = await fetch(server.url + '/api/deployments/default/web/restart', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.test' } })
    expect(crossSite.status).toBe(403)
  })
})

describe('deployment actions', () => {
  it('scales with a merge patch and audits before and after', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('operator')
    expect((await call(server, cookie, 'POST', '/api/deployments/default/web/scale', { replicas: 5 })).status).toBe(200)
    const patch = kube.calls.find((item) => item.method === 'patchNamespacedDeployment')!
    expect(patch.args[0]).toEqual({ name: 'web', namespace: 'default', body: { spec: { replicas: 5 } } })
    const [entry] = server.store.queryAudit({ action: 'deployment.scale' })
    expect(entry).toMatchObject({ username: 'operator', role: 'operator', namespace: 'default', name: 'web', result: 'success', details: { before: { replicas: 2 }, after: { replicas: 5 } } })
  })

  it('validates replica counts', async () => {
    const server = await start()
    const cookie = await server.login('operator')
    for (const replicas of [-1, 1.5, '3', 5000]) {
      expect((await call(server, cookie, 'POST', '/api/deployments/default/web/scale', { replicas })).status).toBe(400)
    }
  })

  it('restarts by stamping the pod template', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('operator')
    await call(server, cookie, 'POST', '/api/deployments/default/web/restart')
    const body = (kube.calls.find((item) => item.method === 'patchNamespacedDeployment')!.args[0] as { body: { spec: { template: { metadata: { annotations: Record<string, string> } } } } }).body
    expect(Date.parse(body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'])).not.toBeNaN()
  })

  it('updates one container image and records the old image', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('operator')
    expect((await call(server, cookie, 'POST', '/api/deployments/default/web/image', { container: 'app', image: ' nginx:1.27 ' })).status).toBe(200)
    expect((kube.calls.find((item) => item.method === 'patchNamespacedDeployment')!.args[0] as { body: unknown }).body).toEqual({ spec: { template: { spec: { containers: [{ name: 'app', image: 'nginx:1.27' }] } } } })
    expect(server.store.queryAudit({ action: 'deployment.image' })[0].details).toMatchObject({ before: { image: 'nginx:1.26' }, after: { image: 'nginx:1.27' } })
    expect((await call(server, cookie, 'POST', '/api/deployments/default/web/image', { container: 'missing', image: 'nginx:1.27' })).status).toBe(404)
    expect(server.store.queryAudit({ action: 'deployment.image', result: 'failure' })).toHaveLength(1)
  })

  it('reports Kubernetes errors with their message and audits the failure', async () => {
    const forbidden = Object.assign(new Error('HTTP-Code: 403'), { code: 403, body: JSON.stringify({ message: 'deployments.apps "web" is forbidden: cannot patch' }) })
    const server = await start({ kube: fakeKube({}, undefined, { apps: { patchNamespacedDeployment: async () => { throw forbidden } } }) })
    const cookie = await server.login('operator')
    const result = await call(server, cookie, 'POST', '/api/deployments/default/web/restart')
    expect(result).toEqual({ status: 403, body: { error: 'deployments.apps "web" is forbidden: cannot patch' } })
    expect(server.store.queryAudit({ result: 'failure' })[0]).toMatchObject({ action: 'deployment.restart', error: 'deployments.apps "web" is forbidden: cannot patch' })
  })
})

describe('deletes', () => {
  it('refuses to delete protected namespaces', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('admin')
    expect((await call(server, cookie, 'DELETE', '/api/namespaces/kube-system')).status).toBe(403)
    expect(kube.calls.some((item) => item.method === 'deleteNamespace')).toBe(false)
  })

  it('deletes a pod and audits who did it', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('operator')
    await call(server, cookie, 'DELETE', '/api/pods/default/web-1')
    expect(kube.calls.find((item) => item.method === 'deleteNamespacedPod')!.args[0]).toEqual({ name: 'web-1', namespace: 'default' })
    expect(server.store.queryAudit({ action: 'pod.delete' })[0]).toMatchObject({ username: 'operator', name: 'web-1', result: 'success' })
  })
})

describe('apply and YAML', () => {
  it('server-side applies each document and reports created objects', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('admin')
    const yaml = [
      'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: team-a',
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n  namespace: team-a\n  resourceVersion: "99"\n  managedFields: []\ndata:\n  mode: fast',
    ].join('\n---\n')
    const result = await call(server, cookie, 'POST', '/api/apply', { yaml })
    expect(result.status).toBe(200)
    expect(result.body.results).toEqual([
      { kind: 'Namespace', namespace: null, name: 'team-a', operation: 'created' },
      { kind: 'ConfigMap', namespace: 'team-a', name: 'settings', operation: 'created' },
    ])
    const patches = kube.calls.filter((item) => item.method === 'patch')
    expect(patches[1].args[0]).toEqual({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'team-a' }, data: { mode: 'fast' } })
    expect(patches[1].args.slice(2, 6)).toEqual([undefined, 'k8s-ui', true, 'application/apply-patch+yaml'])
    expect(server.store.queryAudit({ action: 'resource.apply' })).toHaveLength(2)
  })

  it('dry runs without writing audit records', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('admin')
    const result = await call(server, cookie, 'POST', '/api/apply', { yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n', dryRun: true })
    expect(result.body).toMatchObject({ ok: true, dryRun: true })
    expect(kube.calls.find((item) => item.method === 'patch')!.args[2]).toBe('All')
    expect(server.store.queryAudit({ action: 'resource.apply' })).toHaveLength(0)
  })

  it('rejects invalid YAML and objects without names', async () => {
    const server = await start()
    const cookie = await server.login('admin')
    expect((await call(server, cookie, 'POST', '/api/apply', { yaml: 'kind: [' })).status).toBe(400)
    expect((await call(server, cookie, 'POST', '/api/apply', { yaml: 'apiVersion: v1\nkind: ConfigMap\n' })).body.error).toMatch(/metadata.name/)
  })

  it('shows YAML without managed fields', async () => {
    const server = await start({ kube: fakeKube({}, undefined, { object: { read: async () => ({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: 'default', managedFields: [{ manager: 'x' }] }, spec: { type: 'ClusterIP' } }) } }) })
    const cookie = await server.login('viewer')
    const response = await fetch(server.url + '/api/yaml/service/default/web', { headers: { Cookie: cookie } })
    const text = await response.text()
    expect(text).toContain('kind: Service')
    expect(text).not.toContain('managedFields')
    expect((await fetch(server.url + '/api/yaml/secret/default/web', { headers: { Cookie: cookie } })).status).toBe(404)
  })
})

describe('debug and shell', () => {
  it('adds an ephemeral debug container targeting the chosen container', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('admin')
    const result = await call(server, cookie, 'POST', '/api/pods/default/web-1/debug', { target: 'app', image: 'nicolaka/netshoot:v0.13' })
    expect(result.body.container).toMatch(/^debugger-[0-9a-f]{6}$/)
    const replaced = kube.calls.find((item) => item.method === 'replaceNamespacedPodEphemeralcontainers')!.args[0] as { body: { spec: { ephemeralContainers: unknown[] } } }
    expect(replaced.body.spec.ephemeralContainers).toEqual([expect.objectContaining({ name: result.body.container, image: 'nicolaka/netshoot:v0.13', targetContainerName: 'app', stdin: true, tty: true })])
  })

  it.each(['/ws/exec', '/ws/attach'])('%s handshakes need an admin', async (path) => {
    const server = await start()
    for (const [role, expected] of [['viewer', 403], ['operator', 403]] as const) {
      const cookie = await server.login(role)
      const socket = new WebSocket('ws://' + server.host + path + '?namespace=default&pod=web-1&container=app', { headers: { Cookie: cookie } })
      const status = await new Promise<number>((resolve) => socket.once('unexpected-response', (_request, response) => resolve(response.statusCode || 0)))
      expect(status, role).toBe(expected)
    }
  })
})
