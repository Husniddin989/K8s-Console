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
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed as Record<string, any> }
}

/** Every write endpoint with the lowest role allowed to use it. */
const writes: Array<{ method: string; path: string; body?: unknown; role: Role }> = [
  { method: 'POST', path: '/api/deployments/default/web/restart', role: 'operator' },
  { method: 'POST', path: '/api/deployments/default/web/scale', body: { replicas: 3 }, role: 'operator' },
  { method: 'POST', path: '/api/deployments/default/web/image', body: { container: 'app', image: 'nginx:1.27' }, role: 'operator' },
  { method: 'POST', path: '/api/statefulsets/default/db/restart', role: 'operator' },
  { method: 'POST', path: '/api/statefulsets/default/db/scale', body: { replicas: 2 }, role: 'operator' },
  { method: 'POST', path: '/api/daemonsets/default/agent/restart', role: 'operator' },
  { method: 'POST', path: '/api/daemonsets/default/agent/image', body: { container: 'agent', image: 'agent:2' }, role: 'operator' },
  { method: 'POST', path: '/api/cronjobs/default/nightly/trigger', role: 'operator' },
  { method: 'POST', path: '/api/cronjobs/default/nightly/suspend', body: { suspend: true }, role: 'operator' },
  { method: 'POST', path: '/api/pods/default/web-1/debug', body: { target: 'app' }, role: 'operator' },
  { method: 'DELETE', path: '/api/pods/default/web-1', role: 'operator' },
  { method: 'DELETE', path: '/api/deployments/default/web', role: 'admin' },
  { method: 'DELETE', path: '/api/statefulsets/default/db', role: 'admin' },
  { method: 'DELETE', path: '/api/jobs/default/once', role: 'admin' },
  { method: 'DELETE', path: '/api/services/default/web', role: 'admin' },
  { method: 'DELETE', path: '/api/configmaps/default/settings', role: 'admin' },
  { method: 'DELETE', path: '/api/secrets/default/db', role: 'admin' },
  { method: 'DELETE', path: '/api/namespaces/team-a', role: 'admin' },
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
    const server = await start({ clusterWrites: false })
    const cookie = await server.login('admin')
    for (const { method, path, body } of writes) {
      const result = await call(server, cookie, method, path, body)
      expect(result.status, path).toBe(403)
      expect(result.body.error).toMatch(/turned off/)
    }
    expect((await call(server, cookie, 'GET', '/api/auth/me')).body.clusterWrites).toBe(false)
    expect((await fetch(server.url + '/api/yaml/pods/default/web-1', { headers: { Cookie: cookie } })).status).toBe(200)
  })

  it('rejects writes without a session and from other origins', async () => {
    const server = await start()
    expect((await fetch(server.url + '/api/deployments/default/web/restart', { method: 'POST' })).status).toBe(401)
    const cookie = await server.login('admin')
    const crossSite = await fetch(server.url + '/api/deployments/default/web/restart', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.test' } })
    expect(crossSite.status).toBe(403)
  })

  it('refuses actions a kind does not support', async () => {
    const server = await start()
    const cookie = await server.login('admin')
    expect((await call(server, cookie, 'POST', '/api/daemonsets/default/agent/scale', { replicas: 2 })).status).toBe(404)
    expect((await call(server, cookie, 'POST', '/api/services/default/web/restart')).status).toBe(404)
    expect((await call(server, cookie, 'DELETE', '/api/nodes/_/node-a')).status).toBe(404)
    expect((await call(server, cookie, 'DELETE', '/api/widgets/default/x')).status).toBe(404)
  })
})

describe('workload actions', () => {
  it('scales with a merge patch and audits before and after', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('operator')
    expect((await call(server, cookie, 'POST', '/api/deployments/default/web/scale', { replicas: 5 })).status).toBe(200)
    const patch = kube.calls.find((item) => item.method === 'patch')!
    expect(patch.args[0]).toEqual({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'default' }, spec: { replicas: 5 } })
    expect(patch.args[5]).toBe('application/merge-patch+json')
    const [entry] = server.store.queryAudit({ action: 'deployment.scale' })
    expect(entry).toMatchObject({ username: 'operator', role: 'operator', namespace: 'default', name: 'web', result: 'success', details: { before: { replicas: 2 }, after: { replicas: 5 } } })
  })

  it('validates replica counts', async () => {
    const server = await start()
    const cookie = await server.login('operator')
    for (const replicas of [-1, 1.5, '3', 5000]) {
      expect((await call(server, cookie, 'POST', '/api/statefulsets/default/db/scale', { replicas })).status).toBe(400)
    }
  })

  it('restarts statefulsets and daemonsets by stamping the pod template', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('operator')
    await call(server, cookie, 'POST', '/api/daemonsets/default/agent/restart')
    const body = kube.calls.find((item) => item.method === 'patch')!.args[0] as { kind: string; spec: { template: { metadata: { annotations: Record<string, string> } } } }
    expect(body.kind).toBe('DaemonSet')
    expect(Date.parse(body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'])).not.toBeNaN()
    expect(server.store.queryAudit({ action: 'daemonset.restart' })).toHaveLength(1)
  })

  it('updates one container image with a strategic merge patch and records the old image', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('operator')
    expect((await call(server, cookie, 'POST', '/api/deployments/default/web/image', { container: 'app', image: ' nginx:1.27 ' })).status).toBe(200)
    const patch = kube.calls.find((item) => item.method === 'patch')!
    expect((patch.args[0] as { spec: unknown }).spec).toEqual({ template: { spec: { containers: [{ name: 'app', image: 'nginx:1.27' }] } } })
    expect(patch.args[5]).toBe('application/strategic-merge-patch+json')
    expect(server.store.queryAudit({ action: 'deployment.image' })[0].details).toMatchObject({ before: { image: 'nginx:1.26' }, after: { image: 'nginx:1.27' } })
    expect((await call(server, cookie, 'POST', '/api/deployments/default/web/image', { container: 'missing', image: 'nginx:1.27' })).status).toBe(404)
    expect(server.store.queryAudit({ action: 'deployment.image', result: 'failure' })).toHaveLength(1)
  })

  it('reports Kubernetes errors with their message and audits the failure', async () => {
    const forbidden = Object.assign(new Error('HTTP-Code: 403'), { code: 403, body: JSON.stringify({ message: 'deployments.apps "web" is forbidden: cannot patch' }) })
    const server = await start({ kube: fakeKube({}, undefined, { object: { patch: async () => { throw forbidden } } }) })
    const cookie = await server.login('operator')
    const result = await call(server, cookie, 'POST', '/api/deployments/default/web/restart')
    expect(result).toEqual({ status: 403, body: { error: 'deployments.apps "web" is forbidden: cannot patch' } })
    expect(server.store.queryAudit({ result: 'failure' })[0]).toMatchObject({ action: 'deployment.restart', error: 'deployments.apps "web" is forbidden: cannot patch' })
  })
})

describe('cronjobs', () => {
  it('runs a cronjob now by creating an owned job from its template', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('operator')
    const result = await call(server, cookie, 'POST', '/api/cronjobs/default/nightly/trigger')
    expect(result.body.job).toMatch(/^nightly-manual-[0-9a-f]{4}$/)
    const job = kube.calls.find((item) => item.method === 'create')!.args[0] as Record<string, any>
    expect(job).toMatchObject({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: result.body.job, namespace: 'default', labels: { app: 'nightly' }, annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' }, ownerReferences: [{ kind: 'CronJob', name: 'nightly', uid: 'cron-uid', controller: true }] },
      spec: { template: { spec: { containers: [{ name: 'job', image: 'busybox' }] } } },
    })
  })

  it('suspends and resumes', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('operator')
    await call(server, cookie, 'POST', '/api/cronjobs/default/nightly/suspend', { suspend: true })
    await call(server, cookie, 'POST', '/api/cronjobs/default/nightly/suspend', { suspend: false })
    expect(kube.calls.filter((item) => item.method === 'patch').map((item) => (item.args[0] as { spec: unknown }).spec)).toEqual([{ suspend: true }, { suspend: false }])
    expect(server.store.queryAudit().map((entry) => entry.action).slice(0, 2)).toEqual(['cronjob.resume', 'cronjob.suspend'])
    expect((await call(server, cookie, 'POST', '/api/cronjobs/default/nightly/suspend', { suspend: 'yes' })).status).toBe(400)
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

  it('deletes through the generic client with the right propagation and audits a summary', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const operator = await server.login('operator')
    await call(server, operator, 'DELETE', '/api/pods/default/web-1')
    const admin = await server.login('admin')
    await call(server, admin, 'DELETE', '/api/jobs/default/once')
    const deletes = kube.calls.filter((item) => item.method === 'delete')
    expect(deletes.map((item) => [(item.args[0] as { kind: string }).kind, item.args[5]])).toEqual([['Pod', undefined], ['Job', 'Background']])
    expect(server.store.queryAudit({ action: 'pod.delete' })[0]).toMatchObject({ username: 'operator', name: 'web-1', result: 'success', details: { before: { phase: 'Running' } } })
  })

  it('never stores secret values when deleting a secret', async () => {
    const server = await start()
    const cookie = await server.login('admin')
    await call(server, cookie, 'DELETE', '/api/secrets/default/db')
    const [entry] = server.store.queryAudit({ action: 'secret.delete' })
    expect(entry.details).toEqual({ before: { type: 'Opaque', keys: ['password', 'tls.der'] } })
    expect(JSON.stringify(entry)).not.toContain(Buffer.from('s3cret!').toString('base64'))
  })
})

describe('secrets', () => {
  it('lists secrets for admins only and without values', async () => {
    const server = await start()
    for (const role of ['viewer', 'operator'] as const) {
      expect((await call(server, await server.login(role), 'GET', '/api/secrets?namespace=all')).status).toBe(403)
    }
    const list = await call(server, await server.login('admin'), 'GET', '/api/secrets?namespace=all')
    expect(list.body).toEqual([{ name: 'db', namespace: 'default', type: 'Opaque', keys: ['password', 'tls.der'], immutable: false, createdAt: null }])
  })

  it('reveals decoded values to admins and audits every reveal', async () => {
    const server = await start()
    expect((await call(server, await server.login('operator'), 'GET', '/api/secrets/default/db/data')).status).toBe(403)
    expect((await call(server, await server.login('operator'), 'GET', '/api/yaml/secrets/default/db')).status).toBe(403)
    const admin = await server.login('admin')
    const revealed = await call(server, admin, 'GET', '/api/secrets/default/db/data')
    expect(revealed.body.entries).toEqual([
      { key: 'password', value: 's3cret!', binary: false },
      { key: 'tls.der', value: Buffer.from([0, 159, 146, 150]).toString('base64'), binary: true },
    ])
    expect((await call(server, admin, 'GET', '/api/yaml/secrets/default/db')).status).toBe(200)
    const reveals = server.store.queryAudit({ action: 'secret.reveal' })
    expect(reveals.map((entry) => (entry.details as { via: string }).via)).toEqual(['yaml', 'values'])
    expect(JSON.stringify(reveals)).not.toContain('s3cret!')
  })

  it('applies secrets without writing their values to the audit log', async () => {
    const server = await start()
    const cookie = await server.login('admin')
    const yaml = 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: api-token\n  namespace: default\nstringData:\n  token: very-private-value\n'
    expect((await call(server, cookie, 'POST', '/api/apply', { yaml })).status).toBe(200)
    const [entry] = server.store.queryAudit({ action: 'resource.apply' })
    expect(JSON.stringify(entry)).not.toContain('very-private-value')
    expect(entry.details).toMatchObject({ after: { keys: ['token'] } })
  })
})

describe('apply and YAML', () => {
  it('server-side applies each document and reports created objects', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('admin')
    const yaml = [
      'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: team-a',
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: other-settings\n  namespace: team-a\n  resourceVersion: "99"\n  managedFields: []\ndata:\n  mode: fast',
    ].join('\n---\n')
    const result = await call(server, cookie, 'POST', '/api/apply', { yaml })
    expect(result.status).toBe(200)
    expect(result.body.results).toEqual([
      { kind: 'Namespace', namespace: null, name: 'team-a', operation: 'created' },
      { kind: 'ConfigMap', namespace: 'team-a', name: 'other-settings', operation: 'configured' },
    ])
    const patches = kube.calls.filter((item) => item.method === 'patch')
    expect(patches[1].args[0]).toEqual({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'other-settings', namespace: 'team-a' }, data: { mode: 'fast' } })
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
    const response = await fetch(server.url + '/api/yaml/services/default/web', { headers: { Cookie: cookie } })
    const text = await response.text()
    expect(text).toContain('kind: Service')
    expect(text).not.toContain('managedFields')
    expect((await fetch(server.url + '/api/yaml/widgets/default/web', { headers: { Cookie: cookie } })).status).toBe(404)
  })
})

describe('debug and shell', () => {
  it('adds an ephemeral debug container targeting the chosen container', async () => {
    const kube = fakeKube()
    const server = await start({ kube })
    const cookie = await server.login('operator')
    const result = await call(server, cookie, 'POST', '/api/pods/default/web-1/debug', { target: 'app', image: 'nicolaka/netshoot:v0.13' })
    expect(result.body.container).toMatch(/^debugger-[0-9a-f]{6}$/)
    const replaced = kube.calls.find((item) => item.method === 'replaceNamespacedPodEphemeralcontainers')!.args[0] as { body: { spec: { ephemeralContainers: unknown[] } } }
    expect(replaced.body.spec.ephemeralContainers).toEqual([expect.objectContaining({ name: result.body.container, image: 'nicolaka/netshoot:v0.13', targetContainerName: 'app', stdin: true, tty: true })])
  })

  it.each(['/ws/exec', '/ws/attach'])('%s handshakes need an operator', async (path) => {
    const server = await start()
    const url = 'ws://' + server.host + path + '?namespace=default&pod=web-1&container=app'
    const viewer = new WebSocket(url, { headers: { Cookie: await server.login('viewer') } })
    expect(await new Promise<number>((resolve) => viewer.once('unexpected-response', (_request, response) => resolve(response.statusCode || 0)))).toBe(403)
    // An operator passes the handshake; the fake cluster then fails the session itself.
    const operator = new WebSocket(url, { headers: { Cookie: await server.login('operator') } })
    expect(await new Promise<string>((resolve) => {
      operator.once('open', () => resolve('open'))
      operator.once('unexpected-response', (_request, response) => resolve('rejected ' + response.statusCode))
    })).toBe('open')
    operator.close()
  })
})
