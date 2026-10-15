import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createApp } from './app.js'
import { AuthService } from './auth.js'
import { assertUsersExist, loadAuthConfig, type AuthConfig } from './config.js'
import { loadKubeClients } from './kube.js'
import { attachWebSockets } from './sockets.js'
import { ConsoleStore } from './store.js'

const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '127.0.0.1'
const here = path.dirname(fileURLToPath(import.meta.url))
const frontendDirectory = path.resolve(here, '../..', 'frontend', 'dist')

let authConfig: AuthConfig
try {
  authConfig = loadAuthConfig()
} catch (error) {
  console.error('Authentication is not configured: ' + (error instanceof Error ? error.message : 'unknown error'))
  process.exit(1)
}
for (const warning of authConfig.warnings) console.warn('Warning: ' + warning)

const store = new ConsoleStore(authConfig.dataDirectory ? path.join(authConfig.dataDirectory, 'console.db') : ':memory:')
try {
  assertUsersExist(authConfig.users.length, store.countUsers())
} catch (error) {
  console.error('Authentication is not configured: ' + (error instanceof Error ? error.message : 'unknown error'))
  process.exit(1)
}

const kube = loadKubeClients()
const auth = new AuthService({ ...authConfig, store })
// The console's own namespace is protected so it cannot delete itself.
const protectedNamespaces = ['default', 'kube-system', 'kube-public', 'kube-node-lease', ...(process.env.POD_NAMESPACE ? [process.env.POD_NAMESPACE] : [])]
const app = createApp({
  kube,
  auth,
  cookieSecurity: authConfig.cookieSecurity,
  trustedOrigins: authConfig.trustedOrigins,
  trustProxy: process.env.TRUST_PROXY,
  frontendDirectory,
  store,
  clusterWrites: authConfig.clusterWrites,
  debugImage: authConfig.debugImage,
  protectedNamespaces,
})
const server = createServer(app)
const logSockets = attachWebSockets(server, { kube, auth, store, trustedOrigins: authConfig.trustedOrigins, clusterWrites: authConfig.clusterWrites })

server.listen(port, host, () => {
  console.log('Kubernetes UI API listening on ' + host + ':' + port + ' (' + kube.clusterName + ', ' + authConfig.users.length + ' config users, ' + store.countUsers() + ' console users, data: ' + (authConfig.dataDirectory || 'memory') + ', cluster writes ' + (authConfig.clusterWrites ? 'on' : 'off') + ')')
})

let shuttingDown = false
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(signal + ' received; closing log streams and HTTP server')

  const forceExit = setTimeout(() => {
    for (const webSocket of logSockets.clients) webSocket.terminate()
    server.closeAllConnections()
    process.exit(1)
  }, 10000)
  forceExit.unref()

  for (const webSocket of logSockets.clients) webSocket.close(1001, 'Server is shutting down')
  server.close((error) => {
    if (error) console.error('HTTP server shutdown failed:', error.message)
    logSockets.close(() => {
      clearTimeout(forceExit)
      store.close()
      process.exit(error ? 1 : 0)
    })
  })
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
