import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { requireRole } from '../src/app.js'
import type { Role } from '../src/auth.js'
import { fakeKube, passwords, startTestServer, type TestServer } from './helpers.js'

const protectedPaths = [
  '/api/auth/me',
  '/api/namespaces',
  '/api/cluster/summary?namespace=all',
  '/api/pods?namespace=all',
  '/api/deployments?namespace=all',
  '/api/nodes',
  '/api/services?namespace=all',
  '/api/events?namespace=all',
  '/api/pods/default/web-1/logs',
  '/api/does-not-exist',
]

let running: TestServer | undefined
async function start(...args: Parameters<typeof startTestServer>) {
  running = await startTestServer(...args)
  return running
}
afterEach(async () => {
  await running?.close()
  running = undefined
})

function postLogin(server: TestServer, body: unknown, headers: Record<string, string> = {}) {
  return fetch(server.url + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: server.url, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('public endpoints', () => {
  it('serves liveness and health without a session or cluster details', async () => {
    const server = await start()
    expect(await (await fetch(server.url + '/api/live')).json()).toEqual({ status: 'ok' })
    const health = await fetch(server.url + '/api/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
  })

  it('reports health 503 when Kubernetes is unreachable', async () => {
    const server = await start({ kube: fakeKube({ listNamespace: async () => { throw new Error('offline') } }) })
    expect((await fetch(server.url + '/api/health')).status).toBe(503)
  })

  it('sends security headers', async () => {
    const server = await start()
    const response = await fetch(server.url + '/api/live')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

describe('authentication', () => {
  it('rejects every cluster endpoint without a session', async () => {
    const server = await start()
    for (const path of protectedPaths) {
      const response = await fetch(server.url + path)
      expect(response.status, path).toBe(401)
    }
  })

  it('rejects a forged session cookie', async () => {
    const server = await start()
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', iat: Date.now(), exp: Date.now() + 60_000 })).toString('base64url') + '.AAAA'
    const response = await fetch(server.url + '/api/pods', { headers: { Cookie: 'k8s_ui_session=' + forged } })
    expect(response.status).toBe(401)
  })

  it('rejects bad credentials and malformed bodies', async () => {
    const server = await start()
    expect((await postLogin(server, { username: 'admin', password: 'nope' })).status).toBe(401)
    expect((await postLogin(server, { username: 'ghost', password: 'nope' })).status).toBe(401)
    expect((await postLogin(server, { username: 'admin' })).status).toBe(400)
    expect((await postLogin(server, '{not json')).status).toBe(400)
  })

  it('blocks cross-origin login attempts', async () => {
    const server = await start()
    const response = await postLogin(server, { username: 'admin', password: passwords.admin }, { Origin: 'http://evil.test' })
    expect(response.status).toBe(403)
  })

  it('throttles repeated failures even when the right password follows', async () => {
    const server = await start()
    for (let attempt = 0; attempt < 3; attempt += 1) await postLogin(server, { username: 'admin', password: 'wrong' })
    const blocked = await postLogin(server, { username: 'admin', password: passwords.admin })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    // Other accounts are not locked out by someone else's failures.
    expect((await postLogin(server, { username: 'viewer', password: passwords.viewer })).status).toBe(200)
  })

  it('issues an HttpOnly, SameSite=Strict session cookie', async () => {
    const server = await start()
    const response = await postLogin(server, { username: 'ADMIN', password: passwords.admin })
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie') || ''
    expect(cookie).toMatch(/^k8s_ui_session=/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).not.toContain('Secure')
    expect((await response.json()).user).toMatchObject({ username: 'admin', role: 'admin' })
  })

  it('logs out by clearing the cookie', async () => {
    const server = await start()
    const response = await fetch(server.url + '/api/auth/logout', { method: 'POST', headers: { Origin: server.url } })
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toMatch(/k8s_ui_session=;.*Expires=Thu, 01 Jan 1970/)
  })

  it('stops accepting a session after it expires', async () => {
    const server = await start({ sessionTtlMs: 50 })
    const cookie = await server.login('viewer')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect((await fetch(server.url + '/api/pods', { headers: { Cookie: cookie } })).status).toBe(401)
  })
})

describe('roles', () => {
  it.each(['viewer', 'operator', 'admin'] as Role[])('%s can read cluster data and sees matching permissions', async (role) => {
    const server = await start()
    const cookie = await server.login(role)
    const me = await (await fetch(server.url + '/api/auth/me', { headers: { Cookie: cookie } })).json()
    expect(me.user).toEqual({
      username: role,
      role,
      permissions: { read: true, operate: role !== 'viewer', administer: role === 'admin' },
    })
    const pods = await fetch(server.url + '/api/pods?namespace=default', { headers: { Cookie: cookie } })
    expect(pods.status).toBe(200)
    expect((await pods.json())[0]).toMatchObject({ name: 'web-1', restarts: 2, ready: 1, containers: 1 })
  })

  it('requireRole returns 403 below the required role and 401 without a user', async () => {
    const app = express()
    app.use((request, response, next) => {
      const role = request.get('x-role')
      if (role) response.locals.user = { username: 'test', role }
      next()
    })
    app.post('/write', requireRole('operator'), (_request, response) => { response.json({ ok: true }) })
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/write'
    try {
      expect((await fetch(url, { method: 'POST' })).status).toBe(401)
      expect((await fetch(url, { method: 'POST', headers: { 'x-role': 'viewer' } })).status).toBe(403)
      expect((await fetch(url, { method: 'POST', headers: { 'x-role': 'operator' } })).status).toBe(200)
      expect((await fetch(url, { method: 'POST', headers: { 'x-role': 'admin' } })).status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('API errors', () => {
  it('validates namespace names', async () => {
    const server = await start()
    const cookie = await server.login('viewer')
    const response = await fetch(server.url + '/api/pods?namespace=Bad_Name', { headers: { Cookie: cookie } })
    expect(response.status).toBe(400)
  })

  it('returns JSON 404 for unknown API routes instead of the SPA', async () => {
    const server = await start()
    const cookie = await server.login('viewer')
    const response = await fetch(server.url + '/api/nope', { headers: { Cookie: cookie } })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'API route not found' })
  })

  it('maps Kubernetes 404 to 404 and other failures to 502, and keeps serving', async () => {
    const notFound = Object.assign(new Error('pods "x" not found'), { code: 404 })
    const server = await start({ kube: fakeKube({
      readNamespacedPodLog: async () => { throw notFound },
      listNode: async () => { throw new Error('connection refused') },
    }) })
    const cookie = await server.login('viewer')
    const logs = await fetch(server.url + '/api/pods/default/gone/logs', { headers: { Cookie: cookie } })
    expect(logs.status).toBe(404)
    const nodes = await fetch(server.url + '/api/nodes', { headers: { Cookie: cookie } })
    expect(nodes.status).toBe(502)
    expect((await nodes.json()).error).toMatch(/Kubernetes API request failed/)
    expect((await fetch(server.url + '/api/live')).status).toBe(200)
  })
})
