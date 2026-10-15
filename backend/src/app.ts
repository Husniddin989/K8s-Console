import path from 'node:path'
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { AuthService, hasRole, isAllowedOrigin, LoginThrottle, parseCookies, permissionsFor, type AuthUser, type Role } from './auth.js'
import type { CookieSecurity } from './config.js'
import type { KubeClients } from './kube.js'
import { createActionsRouter } from './actions.js'
import { createAdminRouter } from './admin.js'
import type { ConsoleStore } from './store.js'
import { byNamespaceAndName, mapConfigMap, mapCronJob, mapDaemonSet, mapDeployment, mapEvent, mapJob, mapNode, mapPod, mapSecret, mapService, mapStatefulSet, nodeIsReady } from './resources.js'

export const sessionCookieName = 'k8s_ui_session'
export const namespacePattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/
export const resourceNamePattern = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/

export interface AppOptions {
  kube: KubeClients
  auth: AuthService
  cookieSecurity: CookieSecurity
  trustedOrigins: string[]
  trustProxy?: string
  frontendDirectory?: string
  loginThrottle?: LoginThrottle
  store: ConsoleStore
  clusterWrites?: boolean
  debugImage?: string
  protectedNamespaces?: string[]
}

function validNamespace(value: string): boolean {
  return value === 'all' || namespacePattern.test(value)
}

function namespaceFrom(request: Request, response: Response): string | null {
  const namespace = String(request.query.namespace || 'all')
  if (validNamespace(namespace)) return namespace
  response.status(400).json({ error: 'Invalid namespace name' })
  return null
}

export function currentUser(response: Response): AuthUser {
  return response.locals.user as AuthUser
}

export function requireRole(role: Role): RequestHandler {
  return (_request, response, next) => {
    const user = response.locals.user as AuthUser | undefined
    if (!user) {
      response.status(401).json({ error: 'Sign in to continue' })
      return
    }
    if (!hasRole(user.role, role)) {
      response.status(403).json({ error: 'Your role (' + user.role + ') does not allow this action' })
      return
    }
    next()
  }
}

function kubernetesStatus(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'number' && code >= 400 && code < 600 ? code : undefined
}

export function createApp(options: AppOptions) {
  const { kube, auth, store } = options
  const clusterWrites = options.clusterWrites ?? true
  const { coreApi, appsApi, batchApi } = kube
  const throttle = options.loginThrottle || new LoginThrottle()
  const app = express()

  async function listPods(namespace: string) {
    if (namespace !== 'all') return (await coreApi.listNamespacedPod({ namespace, limit: 500 })).items
    return (await coreApi.listPodForAllNamespaces({ limit: 500 })).items
  }

  async function listDeployments(namespace: string) {
    if (namespace !== 'all') return (await appsApi.listNamespacedDeployment({ namespace, limit: 500 })).items
    return (await appsApi.listDeploymentForAllNamespaces({ limit: 500 })).items
  }

  async function listServices(namespace: string) {
    if (namespace !== 'all') return (await coreApi.listNamespacedService({ namespace, limit: 500 })).items
    return (await coreApi.listServiceForAllNamespaces({ limit: 500 })).items
  }

  const cookieOptions = (request: Request) => ({
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure: options.cookieSecurity === 'always' || (options.cookieSecurity === 'auto' && request.secure),
  })

  app.disable('x-powered-by')
  if (options.trustProxy) app.set('trust proxy', options.trustProxy)
  app.use((_request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    })
    next()
  })
  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store')
    next()
  })
  app.use(express.json({ limit: '32kb' }))

  app.get('/api/live', (_request, response) => {
    response.json({ status: 'ok' })
  })

  app.get('/api/health', async (_request, response) => {
    try {
      await coreApi.listNamespace({ limit: 1 })
      response.json({ status: 'ok' })
    } catch {
      response.status(503).json({ status: 'unavailable' })
    }
  })

  app.use('/api', (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next()
    if (!isAllowedOrigin(request.get('origin'), request.get('host'), options.trustedOrigins)) {
      response.status(403).json({ error: 'Cross-origin requests are not allowed' })
      return
    }
    next()
  })

  app.post('/api/auth/login', async (request, response, next) => {
    try {
      const { username, password } = (request.body ?? {}) as { username?: unknown; password?: unknown }
      if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password || username.length > 64 || password.length > 1024) {
        response.status(400).json({ error: 'Username and password are required' })
        return
      }
      const throttleKey = (request.ip || 'unknown') + '|' + username.trim().toLowerCase()
      const retryAfter = throttle.retryAfterMs(throttleKey)
      if (retryAfter > 0) {
        response.set('Retry-After', String(Math.ceil(retryAfter / 1000)))
        response.status(429).json({ error: 'Too many failed sign-in attempts. Try again in a few minutes.' })
        return
      }
      const user = await auth.authenticate(username.trim(), password)
      if (!user) {
        throttle.recordFailure(throttleKey)
        store.addAudit({ username: username.trim().slice(0, 64), role: 'none', ip: request.ip || null, action: 'auth.login', kind: null, namespace: null, name: null, result: 'failure', error: 'Invalid username or password', details: null })
        console.warn('Failed sign-in for "' + username.trim().slice(0, 64) + '" from ' + (request.ip || 'unknown'))
        response.status(401).json({ error: 'Invalid username or password' })
        return
      }
      throttle.reset(throttleKey)
      if (!auth.isConfigUser(user.username)) store.recordLogin(user.username)
      store.addAudit({ username: user.username, role: user.role, ip: request.ip || null, action: 'auth.login', kind: null, namespace: null, name: null, result: 'success', error: null, details: null })
      const session = auth.issueSession(user)
      response.cookie(sessionCookieName, session.token, { ...cookieOptions(request), maxAge: auth.sessionTtlMs })
      console.log('User ' + user.username + ' (' + user.role + ') signed in from ' + (request.ip || 'unknown'))
      response.json({ user: { ...user, permissions: permissionsFor(user.role) }, expiresAt: new Date(session.expiresAt).toISOString(), clusterWrites })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/auth/logout', (request, response) => {
    const user = auth.resolveSession(parseCookies(request.headers.cookie)[sessionCookieName])
    if (user) store.addAudit({ username: user.username, role: user.role, ip: request.ip || null, action: 'auth.logout', kind: null, namespace: null, name: null, result: 'success', error: null, details: null })
    response.clearCookie(sessionCookieName, cookieOptions(request))
    response.status(204).end()
  })

  app.use('/api', (request, response, next) => {
    const user = auth.resolveSession(parseCookies(request.headers.cookie)[sessionCookieName])
    if (!user) {
      response.status(401).json({ error: 'Sign in to continue' })
      return
    }
    response.locals.user = { username: user.username, role: user.role } satisfies AuthUser
    response.locals.sessionExpiresAt = user.expiresAt
    next()
  })

  app.get('/api/auth/me', (_request, response) => {
    const user = currentUser(response)
    response.json({
      user: { ...user, permissions: permissionsFor(user.role) },
      expiresAt: new Date(response.locals.sessionExpiresAt as number).toISOString(),
      clusterWrites,
    })
  })

  const reader = express.Router()
  reader.use(requireRole('viewer'))

  reader.get('/namespaces', async (_request, response, next) => {
    try {
      const namespaces = await coreApi.listNamespace({ limit: 500 })
      response.json(namespaces.items.map((item) => ({
        name: item.metadata?.name || 'unknown',
        phase: item.metadata?.deletionTimestamp ? 'Terminating' : item.status?.phase || 'Unknown',
        labels: item.metadata?.labels || {},
        createdAt: item.metadata?.creationTimestamp || null,
      })).sort((a, b) => a.name.localeCompare(b.name)))
    } catch (error) {
      next(error)
    }
  })

  reader.get('/cluster/summary', async (request, response, next) => {
    try {
      const namespace = namespaceFrom(request, response)
      if (!namespace) return

      const [nodeList, namespaceList, pods, deployments, services] = await Promise.all([
        coreApi.listNode({ limit: 500 }),
        coreApi.listNamespace({ limit: 500 }),
        listPods(namespace),
        listDeployments(namespace),
        listServices(namespace),
      ])
      const nodes = nodeList.items
      const podCounts = pods.reduce((counts, pod) => {
        const phase = pod.status?.phase || 'Unknown'
        counts[phase] = (counts[phase] || 0) + 1
        return counts
      }, {} as Record<string, number>)
      const readyDeployments = deployments.filter((deployment) => {
        const desired = deployment.spec?.replicas ?? 1
        return (deployment.status?.readyReplicas ?? 0) >= desired
      }).length

      response.json({
        cluster: kube.clusterName,
        kubernetesVersion: nodes[0]?.status?.nodeInfo?.kubeletVersion || '—',
        nodeCount: nodes.length,
        readyNodeCount: nodes.filter(nodeIsReady).length,
        namespaceCount: namespaceList.items.length,
        podCount: pods.length,
        podCounts,
        deploymentCount: deployments.length,
        readyDeploymentCount: readyDeployments,
        serviceCount: services.length,
      })
    } catch (error) {
      next(error)
    }
  })

  reader.get('/pods', async (request, response, next) => {
    try {
      const namespace = namespaceFrom(request, response)
      if (!namespace) return
      const pods = await listPods(namespace)
      response.json(pods.map(mapPod).sort(byNamespaceAndName))
    } catch (error) {
      next(error)
    }
  })

  reader.get('/deployments', async (request, response, next) => {
    try {
      const namespace = namespaceFrom(request, response)
      if (!namespace) return
      const deployments = await listDeployments(namespace)
      response.json(deployments.map(mapDeployment).sort(byNamespaceAndName))
    } catch (error) {
      next(error)
    }
  })

  reader.get('/services', async (request, response, next) => {
    try {
      const namespace = namespaceFrom(request, response)
      if (!namespace) return
      response.json((await listServices(namespace)).map(mapService).sort(byNamespaceAndName))
    } catch (error) {
      next(error)
    }
  })

  /** Registers GET /<path>?namespace=… for a list-all / list-in-namespace pair of API calls. */
  function listRoute<T>(path: string, all: () => Promise<{ items: T[] }>, inNamespace: (namespace: string) => Promise<{ items: T[] }>, map: (item: T) => { namespace: string; name: string }, ...guards: RequestHandler[]) {
    reader.get(path, ...guards, async (request, response, next) => {
      try {
        const namespace = namespaceFrom(request, response)
        if (!namespace) return
        const list = namespace === 'all' ? await all() : await inNamespace(namespace)
        response.json(list.items.map(map).sort(byNamespaceAndName))
      } catch (error) {
        next(error)
      }
    })
  }

  listRoute('/statefulsets', () => appsApi.listStatefulSetForAllNamespaces({ limit: 500 }), (namespace) => appsApi.listNamespacedStatefulSet({ namespace, limit: 500 }), mapStatefulSet)
  listRoute('/daemonsets', () => appsApi.listDaemonSetForAllNamespaces({ limit: 500 }), (namespace) => appsApi.listNamespacedDaemonSet({ namespace, limit: 500 }), mapDaemonSet)
  listRoute('/jobs', () => batchApi.listJobForAllNamespaces({ limit: 500 }), (namespace) => batchApi.listNamespacedJob({ namespace, limit: 500 }), mapJob)
  listRoute('/cronjobs', () => batchApi.listCronJobForAllNamespaces({ limit: 500 }), (namespace) => batchApi.listNamespacedCronJob({ namespace, limit: 500 }), mapCronJob)
  listRoute('/configmaps', () => coreApi.listConfigMapForAllNamespaces({ limit: 500 }), (namespace) => coreApi.listNamespacedConfigMap({ namespace, limit: 500 }), mapConfigMap)
  // Secrets are admin-only; the list carries key names, never values.
  listRoute('/secrets', () => coreApi.listSecretForAllNamespaces({ limit: 500 }), (namespace) => coreApi.listNamespacedSecret({ namespace, limit: 500 }), mapSecret, requireRole('admin'))

  reader.get('/nodes', async (_request, response, next) => {
    try {
      const nodes = await coreApi.listNode({ limit: 500 })
      response.json(nodes.items.map(mapNode).sort((a, b) => a.name.localeCompare(b.name)))
    } catch (error) {
      next(error)
    }
  })

  reader.get('/events', async (request, response, next) => {
    try {
      const namespace = namespaceFrom(request, response)
      if (!namespace) return
      const events = namespace === 'all'
        ? await coreApi.listEventForAllNamespaces({ limit: 100 })
        : await coreApi.listNamespacedEvent({ namespace, limit: 100 })
      response.json(events.items.map(mapEvent).sort((a, b) => String(b.time || '').localeCompare(String(a.time || ''))))
    } catch (error) {
      next(error)
    }
  })

  reader.get('/pods/:namespace/:name/logs', async (request, response, next) => {
    try {
      const { namespace, name } = request.params
      const container = String(request.query.container || '')
      const tailLines = Math.min(Math.max(Number(request.query.tailLines || 200) || 200, 1), 1000)
      if (!namespacePattern.test(namespace) || !resourceNamePattern.test(name) || (container && !resourceNamePattern.test(container))) {
        response.status(400).json({ error: 'Invalid pod name or namespace' })
        return
      }
      const logs = await coreApi.readNamespacedPodLog({ name, namespace, container: container || undefined, tailLines, timestamps: true })
      response.type('text/plain').send(logs)
    } catch (error) {
      next(error)
    }
  })

  app.use('/api', reader)
  // Admin routes first: the generic /:resource/:namespace/:name action routes would otherwise match /admin/users/<name>.
  app.use('/api/admin', createAdminRouter({ auth, store }))
  app.use('/api', createActionsRouter({
    kube,
    store,
    clusterWrites,
    debugImage: options.debugImage || 'busybox:1.36',
    protectedNamespaces: options.protectedNamespaces ?? ['default', 'kube-system', 'kube-public', 'kube-node-lease'],
  }))
  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'API route not found' })
  })

  if (options.frontendDirectory) {
    const frontendDirectory = options.frontendDirectory
    app.use(express.static(frontendDirectory, { index: false, maxAge: '1h' }))
    app.get('*path', (_request, response, next) => {
      response.set('Cache-Control', 'no-cache')
      response.sendFile(path.join(frontendDirectory, 'index.html'), (error) => {
        if (error) next(error)
      })
    })
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const httpStatus = (error as { status?: unknown; type?: unknown } | null)?.status
    if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
      response.status(httpStatus).json({ error: httpStatus === 413 ? 'Request body is too large' : 'Malformed request' })
      return
    }
    const status = kubernetesStatus(error)
    console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error')
    if (status === 404) {
      response.status(404).json({ error: 'The Kubernetes resource no longer exists.' })
    } else if (status === 403) {
      response.status(502).json({ error: 'The console service account is not allowed to read this resource.' })
    } else {
      response.status(502).json({ error: 'Kubernetes API request failed. Check cluster connectivity and read permissions.' })
    }
  })

  return app
}
