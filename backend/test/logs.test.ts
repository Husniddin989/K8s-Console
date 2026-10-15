import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as k8s from '@kubernetes/client-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { sessionExpiredCloseCode } from '../src/sockets.js'
import { fakeKube, startTestServer, type TestServer } from './helpers.js'

let upstream: Server
let upstreamRequests: IncomingMessage[]
let upstreamClosed: number
let console_: TestServer

function upstreamKubeConfig() {
  const kubeConfig = new k8s.KubeConfig()
  kubeConfig.loadFromOptions({
    // The client only allows plain HTTP API servers with skipTLSVerify.
    clusters: [{ name: 'test', server: 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port, skipTLSVerify: true }],
    users: [{ name: 'test', token: 'test-token' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  })
  return kubeConfig
}

beforeEach(async () => {
  upstreamRequests = []
  upstreamClosed = 0
  // Fake Kubernetes API that follows logs until the client goes away.
  upstream = createServer((request, response) => {
    upstreamRequests.push(request)
    // Mirror the real API server, which rejects a text/plain-only Accept header (regression).
    if (request.headers.accept === 'text/plain') {
      response.writeHead(406)
      response.end()
      return
    }
    if (request.url?.includes('/pods/broken/')) {
      response.writeHead(500)
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.write('2026-01-01T00:00:00.000000001Z first line\n')
    request.on('close', () => { upstreamClosed += 1 })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  console_ = await startTestServer({ kube: fakeKube({}, upstreamKubeConfig()), sessionTtlMs: 60_000 })
})

afterEach(async () => {
  await console_.close()
  upstream.closeAllConnections()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

function socketUrl(server: TestServer, pod = 'web-1') {
  return 'ws://' + server.host + '/ws/logs?namespace=default&pod=' + pod + '&container=app'
}

function rejectedStatus(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode || 0))
    socket.once('open', () => reject(new Error('Socket unexpectedly opened')))
  })
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once('message', (data) => resolve(String(data))))
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)))
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('log WebSocket', () => {
  it('rejects the handshake without a session', async () => {
    expect(await rejectedStatus(new WebSocket(socketUrl(console_)))).toBe(401)
    expect(upstreamRequests).toHaveLength(0)
  })

  it('rejects a cross-site handshake even with a valid cookie', async () => {
    const cookie = await console_.login('viewer')
    const socket = new WebSocket(socketUrl(console_), { headers: { Cookie: cookie, Origin: 'http://evil.test' } })
    expect(await rejectedStatus(socket)).toBe(403)
  })

  it('streams logs to a signed-in viewer', async () => {
    const cookie = await console_.login('viewer')
    const socket = new WebSocket(socketUrl(console_), { headers: { Cookie: cookie, Origin: console_.url } })
    expect(await nextMessage(socket)).toContain('first line')
    expect(upstreamRequests[0].url).toContain('follow=true')
    expect(upstreamRequests[0].headers.authorization).toBe('Bearer test-token')
    socket.close()
  })

  it('survives an abrupt client disconnect and releases the upstream stream (regression)', async () => {
    const cookie = await console_.login('viewer')
    const first = new WebSocket(socketUrl(console_), { headers: { Cookie: cookie } })
    await nextMessage(first)
    first.terminate()
    await waitFor(() => upstreamClosed === 1)

    expect((await fetch(console_.url + '/api/live')).status).toBe(200)
    const second = new WebSocket(socketUrl(console_), { headers: { Cookie: cookie } })
    expect(await nextMessage(second)).toContain('first line')
    second.close()
  })

  it('reports an upstream failure and closes with 1011', async () => {
    const cookie = await console_.login('viewer')
    const socket = new WebSocket(socketUrl(console_, 'broken'), { headers: { Cookie: cookie } })
    const closed = closeCode(socket)
    expect(JSON.parse(await nextMessage(socket))).toEqual({ error: 'Unable to stream pod logs' })
    expect(await closed).toBe(1011)
  })

  it('closes with 1008 for invalid parameters', async () => {
    const cookie = await console_.login('viewer')
    const socket = new WebSocket('ws://' + console_.host + '/ws/logs?namespace=Bad&pod=x&container=y', { headers: { Cookie: cookie } })
    expect(await closeCode(socket)).toBe(1008)
    expect(upstreamRequests).toHaveLength(0)
  })

  it('closes the stream when the session expires', async () => {
    await console_.close()
    console_ = await startTestServer({ kube: fakeKube({}, upstreamKubeConfig()), sessionTtlMs: 300 })
    const cookie = await console_.login('viewer')
    const socket = new WebSocket(socketUrl(console_), { headers: { Cookie: cookie } })
    await nextMessage(socket)
    expect(await closeCode(socket)).toBe(sessionExpiredCloseCode)
    await waitFor(() => upstreamClosed === 1)
  })
})
