import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { sessionCookieName } from './app.js'
import { hasRole, isAllowedOrigin, parseCookies, type AuthService, type AuthUser, type Role } from './auth.js'
import type { KubeClients } from './kube.js'
import { streamPodLogs } from './logs.js'
import type { ConsoleStore } from './store.js'
import { openTerminal } from './terminal.js'

export interface SocketOptions {
  kube: KubeClients
  auth: AuthService
  store: ConsoleStore
  trustedOrigins: string[]
  clusterWrites?: boolean
}

/** Close code sent when the session behind a socket expires. */
export const sessionExpiredCloseCode = 4401
const maxTimer = 2 ** 31 - 1

interface SocketRoute {
  role: Role
  writes: boolean
  handle: (webSocket: WebSocket, request: IncomingMessage, user: AuthUser) => Promise<void>
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end('HTTP/1.1 ' + status + ' ' + message + '\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ' + Buffer.byteLength(message) + '\r\n\r\n' + message)
  socket.destroy()
}

/** One upgrade handler for every socket: checks origin, session, role and write mode before the handshake. */
export function attachWebSockets(server: Server, options: SocketOptions): WebSocketServer {
  const { auth, kube, store } = options
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const routes: Record<string, SocketRoute> = {
    '/ws/logs': { role: 'viewer', writes: false, handle: (webSocket, request) => streamPodLogs(webSocket, request, kube.kubeConfig) },
    '/ws/exec': { role: 'operator', writes: true, handle: (webSocket, request, user) => openTerminal('exec', webSocket, request, { kube, store, user }) },
    '/ws/attach': { role: 'operator', writes: true, handle: (webSocket, request, user) => openTerminal('attach', webSocket, request, { kube, store, user }) },
  }

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy())
    const route = routes[new URL(request.url || '/', 'http://localhost').pathname]
    if (!route) {
      socket.destroy()
      return
    }
    if (!isAllowedOrigin(request.headers.origin, request.headers.host, options.trustedOrigins)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    const user = auth.resolveSession(parseCookies(request.headers.cookie)[sessionCookieName])
    if (!user) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return
    }
    if (!hasRole(user.role, route.role) || (route.writes && options.clusterWrites === false)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      const sessionTimer = setTimeout(() => {
        if (webSocket.readyState === WebSocket.OPEN) webSocket.close(sessionExpiredCloseCode, 'Session expired')
      }, Math.min(Math.max(user.expiresAt - Date.now(), 0), maxTimer))
      sessionTimer.unref()
      webSocket.once('close', () => clearTimeout(sessionTimer))
      route.handle(webSocket, request, { username: user.username, role: user.role }).catch((error: unknown) => {
        console.error('WebSocket handler failed:', error instanceof Error ? error.message : 'unknown error')
        if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1011, 'Internal error')
      })
    })
  })

  return sockets
}
