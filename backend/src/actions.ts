import { randomBytes } from 'node:crypto'
import express, { type Request, type RequestHandler, type Response } from 'express'
import { dumpYaml, loadAllYaml, PatchStrategy, setHeaderOptions, type KubernetesObject } from '@kubernetes/client-node'
import { ActionError, kubernetesCode, kubernetesMessage, performAction, recordAudit } from './audit.js'
import { namespacePattern, requireRole, resourceNamePattern } from './app.js'
import type { KubeClients } from './kube.js'
import type { ConsoleStore } from './store.js'

export interface ActionOptions {
  kube: KubeClients
  store: ConsoleStore
  clusterWrites: boolean
  debugImage: string
  /** Namespaces the console refuses to delete. */
  protectedNamespaces: string[]
}

/** Kinds whose YAML the console shows; apply accepts any kind the service account may change. */
const viewableKinds: Record<string, { apiVersion: string; kind: string; namespaced: boolean }> = {
  pod: { apiVersion: 'v1', kind: 'Pod', namespaced: true },
  deployment: { apiVersion: 'apps/v1', kind: 'Deployment', namespaced: true },
  service: { apiVersion: 'v1', kind: 'Service', namespaced: true },
  namespace: { apiVersion: 'v1', kind: 'Namespace', namespaced: false },
  node: { apiVersion: 'v1', kind: 'Node', namespaced: false },
}

const containerNamePattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/
const imagePattern = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,511}$/
const maxApplyBytes = 256 * 1024
const maxApplyDocuments = 20
const fieldManager = 'k8s-ui'

const mergePatch = () => setHeaderOptions('Content-Type', PatchStrategy.MergePatch)
const strategicPatch = () => setHeaderOptions('Content-Type', PatchStrategy.StrategicMergePatch)

/** Removes server-owned fields so YAML is readable and can be applied back. */
export function cleanObject<T extends KubernetesObject>(object: T): T {
  const copy = structuredClone(object) as T & { status?: unknown }
  if (copy.metadata) {
    const metadata = copy.metadata as Record<string, unknown>
    for (const field of ['managedFields', 'resourceVersion', 'uid', 'generation', 'creationTimestamp', 'selfLink']) delete metadata[field]
    const annotations = metadata.annotations as Record<string, string> | undefined
    if (annotations) {
      delete annotations['kubectl.kubernetes.io/last-applied-configuration']
      if (!Object.keys(annotations).length) delete metadata.annotations
    }
  }
  delete copy.status
  return copy
}

function params(request: Request): { namespace: string; name: string } {
  const namespace = String(request.params.namespace || '')
  const name = String(request.params.name || '')
  if (!namespacePattern.test(namespace) || !resourceNamePattern.test(name)) throw new ActionError('Invalid namespace or resource name')
  return { namespace, name }
}

/** Wraps a handler so validation errors answer 400 instead of reaching the generic error handler. */
function handle(run: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return async (request, response, next) => {
    try {
      await run(request, response)
    } catch (error) {
      if (error instanceof ActionError) {
        response.status(error.status).json({ error: error.message })
        return
      }
      next(error)
    }
  }
}

export function createActionsRouter(options: ActionOptions) {
  const { kube, store } = options
  const { coreApi, appsApi, objectApi } = kube
  const router = express.Router()

  const writesEnabled: RequestHandler = (_request, response, next) => {
    if (!options.clusterWrites) {
      response.status(403).json({ error: 'Cluster changes are turned off for this console (CLUSTER_WRITES=false).' })
      return
    }
    next()
  }

  router.get('/yaml/:kind/:namespace/:name', requireRole('viewer'), handle(async (request, response) => {
    const type = viewableKinds[String(request.params.kind)]
    if (!type) throw new ActionError('YAML is not available for this kind', 404)
    const namespace = String(request.params.namespace)
    const name = String(request.params.name)
    if ((type.namespaced && !namespacePattern.test(namespace)) || !resourceNamePattern.test(name)) throw new ActionError('Invalid namespace or resource name')
    try {
      const object = await objectApi.read({ apiVersion: type.apiVersion, kind: type.kind, metadata: { name, namespace: type.namespaced ? namespace : undefined } })
      const copy = structuredClone(object) as KubernetesObject
      if (copy.metadata) delete (copy.metadata as Record<string, unknown>).managedFields
      response.type('application/yaml').send(dumpYaml(copy))
    } catch (error) {
      const code = kubernetesCode(error)
      if (code === 404) throw new ActionError(type.kind + ' ' + name + ' no longer exists', 404)
      throw error
    }
  }))

  router.post('/deployments/:namespace/:name/restart', requireRole('operator'), writesEnabled, handle(async (request, response) => {
    const { namespace, name } = params(request)
    const restartedAt = new Date().toISOString()
    await performAction(store, request, response, { action: 'deployment.restart', kind: 'Deployment', namespace, name }, async () => {
      await appsApi.patchNamespacedDeployment({ name, namespace, body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': restartedAt } } } } } }, mergePatch())
      return { details: { restartedAt } }
    })
  }))

  router.post('/deployments/:namespace/:name/scale', requireRole('operator'), writesEnabled, handle(async (request, response) => {
    const { namespace, name } = params(request)
    const replicas = (request.body as { replicas?: unknown } | undefined)?.replicas
    if (typeof replicas !== 'number' || !Number.isInteger(replicas) || replicas < 0 || replicas > 1000) throw new ActionError('Replicas must be a whole number from 0 to 1000')
    await performAction(store, request, response, { action: 'deployment.scale', kind: 'Deployment', namespace, name }, async () => {
      const current = await appsApi.readNamespacedDeployment({ name, namespace })
      const before = current.spec?.replicas ?? 1
      await appsApi.patchNamespacedDeployment({ name, namespace, body: { spec: { replicas } } }, mergePatch())
      return { details: { before: { replicas: before }, after: { replicas } } }
    })
  }))

  router.post('/deployments/:namespace/:name/image', requireRole('operator'), writesEnabled, handle(async (request, response) => {
    const { namespace, name } = params(request)
    const { container, image } = (request.body ?? {}) as { container?: unknown; image?: unknown }
    if (typeof container !== 'string' || !containerNamePattern.test(container)) throw new ActionError('Choose a container')
    if (typeof image !== 'string' || !imagePattern.test(image.trim())) throw new ActionError('Enter a valid image reference, e.g. nginx:1.27')
    const nextImage = image.trim()
    await performAction(store, request, response, { action: 'deployment.image', kind: 'Deployment', namespace, name, details: { container } }, async () => {
      const current = await appsApi.readNamespacedDeployment({ name, namespace })
      const existing = current.spec?.template.spec?.containers?.find((item) => item.name === container)
      if (!existing) throw new ActionError('Container ' + container + ' is not part of this deployment', 404)
      await appsApi.patchNamespacedDeployment({ name, namespace, body: { spec: { template: { spec: { containers: [{ name: container, image: nextImage }] } } } } }, strategicPatch())
      return { details: { before: { image: existing.image }, after: { image: nextImage } } }
    })
  }))

  router.delete('/pods/:namespace/:name', requireRole('operator'), writesEnabled, handle(async (request, response) => {
    const { namespace, name } = params(request)
    await performAction(store, request, response, { action: 'pod.delete', kind: 'Pod', namespace, name }, async () => {
      const pod = await coreApi.readNamespacedPod({ name, namespace })
      await coreApi.deleteNamespacedPod({ name, namespace })
      return { details: { before: { phase: pod.status?.phase, node: pod.spec?.nodeName, owner: pod.metadata?.ownerReferences?.[0]?.kind } } }
    })
  }))

  router.delete('/deployments/:namespace/:name', requireRole('admin'), writesEnabled, handle(async (request, response) => {
    const { namespace, name } = params(request)
    await performAction(store, request, response, { action: 'deployment.delete', kind: 'Deployment', namespace, name }, async () => {
      const deployment = await appsApi.readNamespacedDeployment({ name, namespace })
      await appsApi.deleteNamespacedDeployment({ name, namespace, propagationPolicy: 'Foreground' })
      return { details: { before: { replicas: deployment.spec?.replicas, images: deployment.spec?.template.spec?.containers?.map((item) => item.image) } } }
    })
  }))

  router.delete('/services/:namespace/:name', requireRole('admin'), writesEnabled, handle(async (request, response) => {
    const { namespace, name } = params(request)
    await performAction(store, request, response, { action: 'service.delete', kind: 'Service', namespace, name }, async () => {
      const service = await coreApi.readNamespacedService({ name, namespace })
      await coreApi.deleteNamespacedService({ name, namespace })
      return { details: { before: { type: service.spec?.type, clusterIP: service.spec?.clusterIP, ports: service.spec?.ports?.map((port) => port.port + '/' + (port.protocol || 'TCP')) } } }
    })
  }))

  router.delete('/namespaces/:name', requireRole('admin'), writesEnabled, handle(async (request, response) => {
    const name = String(request.params.name)
    if (!namespacePattern.test(name)) throw new ActionError('Invalid namespace name')
    if (options.protectedNamespaces.includes(name)) throw new ActionError('Namespace ' + name + ' is protected and cannot be deleted from the console', 403)
    await performAction(store, request, response, { action: 'namespace.delete', kind: 'Namespace', name }, async () => {
      await coreApi.deleteNamespace({ name })
    })
  }))

  router.post('/pods/:namespace/:name/debug', requireRole('admin'), writesEnabled, handle(async (request, response) => {
    const { namespace, name } = params(request)
    const { target, image } = (request.body ?? {}) as { target?: unknown; image?: unknown }
    if (target !== undefined && target !== '' && (typeof target !== 'string' || !containerNamePattern.test(target))) throw new ActionError('Invalid target container')
    const debugImage = typeof image === 'string' && image.trim() ? image.trim() : options.debugImage
    if (!imagePattern.test(debugImage)) throw new ActionError('Enter a valid debug image reference')
    const container = 'debugger-' + randomBytes(3).toString('hex')
    await performAction(store, request, response, { action: 'pod.debug', kind: 'Pod', namespace, name, details: { container, image: debugImage, target: target || null } }, async () => {
      const pod = await coreApi.readNamespacedPod({ name, namespace })
      if (target && !pod.spec?.containers?.some((item) => item.name === target)) throw new ActionError('Container ' + target + ' is not part of this pod', 404)
      pod.spec = pod.spec || { containers: [] }
      pod.spec.ephemeralContainers = [...(pod.spec.ephemeralContainers || []), {
        name: container,
        image: debugImage,
        targetContainerName: typeof target === 'string' && target ? target : undefined,
        stdin: true,
        tty: true,
        terminationMessagePolicy: 'File',
      }]
      await coreApi.replaceNamespacedPodEphemeralcontainers({ name, namespace, body: pod })
      return { body: { container } }
    })
  }))

  router.post('/apply', requireRole('admin'), writesEnabled, handle(async (request, response) => {
    const { yaml, dryRun } = (request.body ?? {}) as { yaml?: unknown; dryRun?: unknown }
    if (typeof yaml !== 'string' || !yaml.trim()) throw new ActionError('Paste at least one Kubernetes object as YAML')
    if (Buffer.byteLength(yaml) > maxApplyBytes) throw new ActionError('YAML is larger than 256 KB')
    let documents: KubernetesObject[]
    try {
      documents = (loadAllYaml(yaml) as Array<KubernetesObject | null>).filter((item): item is KubernetesObject => Boolean(item))
    } catch (error) {
      throw new ActionError('YAML could not be parsed: ' + (error instanceof Error ? error.message.split('\n')[0] : 'unknown error'))
    }
    if (!documents.length) throw new ActionError('The YAML contains no objects')
    if (documents.length > maxApplyDocuments) throw new ActionError('Apply at most ' + maxApplyDocuments + ' objects at once')
    for (const [index, item] of documents.entries()) {
      if (!item || typeof item !== 'object' || !item.apiVersion || !item.kind || !item.metadata?.name) {
        throw new ActionError('Object #' + (index + 1) + ' needs apiVersion, kind and metadata.name')
      }
    }

    const isDryRun = dryRun === true
    const results: Array<{ kind: string; namespace: string | null; name: string; operation: string; error?: string }> = []
    for (const item of documents) {
      const body = cleanObject(item)
      const target = { kind: body.kind!, namespace: body.metadata?.namespace ?? null, name: body.metadata!.name! }
      let before: KubernetesObject | null = null
      try {
        before = await objectApi.read({ apiVersion: body.apiVersion!, kind: body.kind!, metadata: { name: target.name, namespace: target.namespace ?? undefined } })
      } catch (error) {
        if (kubernetesCode(error) !== 404) {
          results.push({ ...target, operation: 'failed', error: kubernetesMessage(error) })
          continue
        }
      }
      try {
        const after = await objectApi.patch(body, undefined, isDryRun ? 'All' : undefined, fieldManager, true, PatchStrategy.ServerSideApply)
        const namespace = after.metadata?.namespace ?? target.namespace
        const operation = !before ? 'created' : before.metadata?.resourceVersion === after.metadata?.resourceVersion ? 'unchanged' : 'configured'
        results.push({ ...target, namespace, operation })
        if (!isDryRun) recordAudit(store, request, response, { action: 'resource.apply', kind: target.kind, namespace, name: target.name, result: 'success', error: null, details: { operation, before: before ? cleanObject(before) : null, after: body } })
      } catch (error) {
        const message = kubernetesMessage(error)
        results.push({ ...target, operation: 'failed', error: message })
        if (!isDryRun) recordAudit(store, request, response, { action: 'resource.apply', kind: target.kind, namespace: target.namespace, name: target.name, result: 'failure', error: message, details: { after: body } })
      }
    }
    const failed = results.filter((item) => item.operation === 'failed').length
    response.status(failed === results.length ? 422 : 200).json({ ok: failed === 0, dryRun: isDryRun, results })
  }))

  return router
}
