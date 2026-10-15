import { afterEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth.js'
import { ConsoleStore } from '../src/store.js'
import { startTestServer, type TestServer } from './helpers.js'

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

describe('user management', () => {
  it('is admin only', async () => {
    const server = await start()
    for (const role of ['viewer', 'operator'] as const) {
      const cookie = await server.login(role)
      expect((await call(server, cookie, 'GET', '/api/admin/users')).status).toBe(403)
      expect((await call(server, cookie, 'GET', '/api/admin/audit')).status).toBe(403)
    }
  })

  it('creates a user who can sign in with the chosen role', async () => {
    const server = await start()
    const admin = await server.login('admin')
    const created = await call(server, admin, 'POST', '/api/admin/users', { username: 'dana', role: 'operator', password: 'dana password 1' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ username: 'dana', role: 'operator', source: 'console', createdBy: 'admin' })
    const dana = await server.login('dana', 'dana password 1')
    expect((await call(server, dana, 'GET', '/api/auth/me')).body.user.role).toBe('operator')
    const list = (await call(server, admin, 'GET', '/api/admin/users')).body as Array<{ username: string; source: string; lastLoginAt: string | null }>
    expect(list.map((user) => user.username + ':' + user.source)).toEqual(['admin:config', 'dana:console', 'operator:config', 'viewer:config'])
    expect(list.find((user) => user.username === 'dana')!.lastLoginAt).not.toBeNull()
  })

  it('rejects duplicate names, weak passwords and unknown roles', async () => {
    const server = await start()
    const admin = await server.login('admin')
    expect((await call(server, admin, 'POST', '/api/admin/users', { username: 'VIEWER', role: 'viewer', password: 'long enough 1' })).status).toBe(409)
    expect((await call(server, admin, 'POST', '/api/admin/users', { username: 'erin', role: 'viewer', password: 'short' })).status).toBe(400)
    expect((await call(server, admin, 'POST', '/api/admin/users', { username: 'erin', role: 'root', password: 'long enough 1' })).status).toBe(400)
    expect((await call(server, admin, 'POST', '/api/admin/users', { username: 'bad name', role: 'viewer', password: 'long enough 1' })).status).toBe(400)
  })

  it('changing a role applies to the existing session', async () => {
    const server = await start()
    const admin = await server.login('admin')
    await call(server, admin, 'POST', '/api/admin/users', { username: 'dana', role: 'admin', password: 'dana password 1' })
    const dana = await server.login('dana', 'dana password 1')
    await call(server, admin, 'PATCH', '/api/admin/users/dana', { role: 'viewer' })
    expect((await call(server, dana, 'GET', '/api/auth/me')).body.user.role).toBe('viewer')
    expect((await call(server, dana, 'GET', '/api/admin/users')).status).toBe(403)
  })

  it('a password reset or disabling ends existing sessions', async () => {
    const server = await start()
    const admin = await server.login('admin')
    await call(server, admin, 'POST', '/api/admin/users', { username: 'dana', role: 'viewer', password: 'dana password 1' })
    let dana = await server.login('dana', 'dana password 1')
    await call(server, admin, 'PATCH', '/api/admin/users/dana', { password: 'dana password 2' })
    expect((await call(server, dana, 'GET', '/api/pods')).status).toBe(401)
    dana = await server.login('dana', 'dana password 2')
    await call(server, admin, 'PATCH', '/api/admin/users/dana', { disabled: true })
    expect((await call(server, dana, 'GET', '/api/pods')).status).toBe(401)
    await expect(server.login('dana', 'dana password 2')).rejects.toThrow(/401/)
  })

  it('protects config users, the current admin and the last admin', async () => {
    // The only admin cannot lock themselves (and so everyone) out of user management.
    const server = await start({ users: [{ username: 'root', role: 'admin', passwordHash: await hashPassword('root password 1') }] })
    const root = await server.login('root', 'root password 1')
    expect((await call(server, root, 'PATCH', '/api/admin/users/root', { role: 'viewer' })).status).toBe(409)
    expect((await call(server, root, 'DELETE', '/api/admin/users/root')).status).toBe(409)

    await call(server, root, 'POST', '/api/admin/users', { username: 'ops', role: 'admin', password: 'ops password 1' })
    const ops = await server.login('ops', 'ops password 1')
    expect((await call(server, ops, 'PATCH', '/api/admin/users/ops', { disabled: true })).body.error).toMatch(/your own/)
    expect((await call(server, ops, 'DELETE', '/api/admin/users/ops')).status).toBe(409)
    expect((await call(server, root, 'DELETE', '/api/admin/users/ops')).status).toBe(204)
  })

  it('refuses to change users defined in config', async () => {
    const server = await start()
    const admin = await server.login('admin')
    expect((await call(server, admin, 'PATCH', '/api/admin/users/viewer', { role: 'admin' })).body.error).toMatch(/Helm values/)
    expect((await call(server, admin, 'DELETE', '/api/admin/users/viewer')).status).toBe(409)
  })
})

describe('audit log', () => {
  it('records sign-ins, failures and admin actions, newest first, with filters', async () => {
    const server = await start()
    await fetch(server.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url }, body: JSON.stringify({ username: 'viewer', password: 'wrong password' }) })
    const admin = await server.login('admin')
    await call(server, admin, 'POST', '/api/admin/users', { username: 'dana', role: 'viewer', password: 'dana password 1' })
    await call(server, admin, 'POST', '/api/deployments/default/web/scale', { replicas: 4 })

    const all = (await call(server, admin, 'GET', '/api/admin/audit')).body
    expect(all.entries.map((entry: { action: string; result: string }) => entry.action + ':' + entry.result)).toEqual([
      'deployment.scale:success',
      'user.create:success',
      'auth.login:success',
      'auth.login:failure',
    ])
    expect(all.actions).toEqual(['auth.login', 'deployment.scale', 'user.create'])

    const failures = (await call(server, admin, 'GET', '/api/admin/audit?result=failure')).body.entries
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ username: 'viewer', action: 'auth.login' })
    expect((await call(server, admin, 'GET', '/api/admin/audit?search=dana')).body.entries).toHaveLength(1)
    expect((await call(server, admin, 'GET', '/api/admin/audit?user=ADMIN&action=deployment.scale')).body.entries[0].details).toEqual({ before: { replicas: 2 }, after: { replicas: 4 } })
  })
})

describe('ConsoleStore', () => {
  it('escapes LIKE wildcards in searches and pages with beforeId', () => {
    const store = new ConsoleStore(':memory:')
    for (const name of ['web_1', 'web-2', 'api']) store.addAudit({ username: 'a', role: 'admin', ip: null, action: 'pod.delete', kind: 'Pod', namespace: 'default', name, result: 'success', error: null, details: null })
    expect(store.queryAudit({ search: 'web_' }).map((entry) => entry.name)).toEqual(['web_1'])
    const [newest] = store.queryAudit({ limit: 1 })
    expect(store.queryAudit({ beforeId: newest.id }).map((entry) => entry.name)).toEqual(['web-2', 'web_1'])
    store.close()
  })

  it('truncates very large details', () => {
    const store = new ConsoleStore(':memory:')
    const entry = store.addAudit({ username: 'a', role: 'admin', ip: null, action: 'resource.apply', kind: 'ConfigMap', namespace: 'default', name: 'big', result: 'success', error: null, details: { blob: 'x'.repeat(100_000) } })
    expect(entry.details).toMatchObject({ truncated: true })
    store.close()
  })
})
