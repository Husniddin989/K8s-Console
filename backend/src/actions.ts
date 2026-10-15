import { randomBytes } from 'node:crypto'
import express, { type Request, type RequestHandler, type Response } from 'express'
import { dumpYaml, loadAllYaml, PatchStrategy, type KubernetesObject, type V1CronJob, type V1PodTemplateSpec, type V1Secret } from '@kubernetes/client-node'
import { ActionError, kubernetesCode, kubernetesMessage, performAction, recordAudit } from './audit.js'
import { namespacePattern, requireRole, resourceNamePattern } from './app.js'
import { hasRole, type AuthUser, type Role } from './auth.js'
import type { KubeClients } from './kube.js'
import { decodeSecretData } from './resources.js'
import type { ConsoleStore } from './store.js'

export interface ActionOptions {
  kube: KubeClients
  store: ConsoleStore
  clusterWrites: boolean
  debugImage: string
  /** Namespaces the console refuses to delete. */
  protectedNamespaces: string[]
}

interface ResourceKind {
  apiVersion: string
  kind: string
  namespaced: boolean
  /** Lowest role that may read the YAML. */
  viewRole: Role
  /** Lowest role that may delete; absent = cannot be deleted from the console. */
  deleteRole?: Role
  /** Supports rollout restart and image updates (has a pod template). */
  rollout?: boolean
  scale?: boolean
  propagationPolicy?: 'Foreground' | 'Background'
}

/** Every kind the console reads or changes, keyed by the plural used in URLs (like kubectl). */
export const resourceKinds: Record<string, ResourceKind> = {
  pods: { apiVersion: 'v1', kind: 'Pod', namespaced: true, viewRole: 'viewer', deleteRole: 'operator' },
  deployments: { apiVersion: 'apps/v1', kind: 'Deployment', namespaced: true, viewRole: 'viewer', deleteRole: 'admin', rollout: true, scale: true, propagationPolicy: 'Foreground' },
  statefulsets: { apiVersion: 'apps/v1', kind: 'StatefulSet', namespaced: true, viewRole: 'viewer', deleteRole: 'admin', rollout: true, scale: true, propagationPolicy: 'Foreground' },
  daemonsets: { apiVersion: 'apps/v1', kind: 'DaemonSet', namespaced: true, viewRole: 'viewer', deleteRole: 'admin', rollout: true, propagationPolicy: 'Foreground' },
  jobs: { apiVersion: 'batch/v1', kind: 'Job', namespaced: true, viewRole: 'viewer', deleteRole: 'admin', propagationPolicy: 'Background' },
  cronjobs: { apiVersion: 'batch/v1', kind: 'CronJob', namespaced: true, viewRole: 'viewer', deleteRole: 'admin', propagationPolicy: 'Background' },
  services: { apiVersion: 'v1', kind: 'Service', namespaced: true, viewRole: 'viewer', deleteRole: 'admin' },
  configmaps: { apiVersion: 'v1', kind: 'ConfigMap', namespaced: true, viewRole: 'viewer', deleteRole: 'admin' },
  secrets: { apiVersion: 'v1', kind: 'Secret', namespaced: true, viewRole: 'admin', deleteRole: 'admin' },
  namespaces: { apiVersion: 'v1', kind: 'Namespace', namespaced: false, viewRole: 'viewer', deleteRole: 'admin' },
  nodes: { apiVersion: 'v1', kind: 'Node', namespaced: false, viewRole: 'viewer' },
}

const containerNamePattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/
const imagePattern = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,511}$/
const maxApplyBytes = 256 * 1024
const maxApplyDocuments = 20
const fieldManager = 'k8s-ui'

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

/** A short, value-free description of an object for audit records. */
function summarize(object: KubernetesObject, kind = object.kind): Record<string, unknown> {
  const item = object as KubernetesObject & {
    spec?: { replicas?: number; type?: string; template?: V1PodTemplateSpec; schedule?: string; ports?: Array<{ port: number; protocol?: string }> }
    status?: { phase?: string }
    type?: string
    data?: Record<string, string>
  }
  const summary: Record<string, unknown> = {}
  if (item.spec?.replicas !== undefined) summary.replicas = item.spec.replicas
  if (item.spec?.template?.spec?.containers) summary.images = item.spec.template.spec.containers.map((container) => container.image)
  if (item.spec?.schedule) summary.schedule = item.spec.schedule
  if (item.spec?.ports) summary.ports = item.spec.ports.map((port) => port.port + '/' + (port.protocol || 'TCP'))
  if (kind === 'Service' && item.spec?.type) summary.type = item.spec.type
  if (kind === 'Secret') summary.type = item.type
  if (kind === 'Secret' || kind === 'ConfigMap') summary.keys = Object.keys(item.data || {})
  if (item.status?.phase) summary.phase = item.status.phase
  return summary
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
  const { coreApi, objectApi } = kube
  const router = express.Router()

  const writesEnabled: RequestHandler = (_request, response, next) => {
    if (!options.clusterWrites) {
      response.status(403).json({ error: 'Cluster changes are turned off for this console (CLUSTER_WRITES=false).' })
      return
    }
    next()
  }

  /** Resolves `/:resource/:namespace/:name` to a kind and checks the caller's role for `need`. */
  function target(request: Request, response: Response, need: (kind: ResourceKind) => Role | undefined, capability?: keyof ResourceKind) {
    const type = resourceKinds[String(request.params.resource)]
    if (!type || (capability && !type[capability])) throw new ActionError('This action is not available for ' + String(request.params.resource), 404)
    const role = need(type)
    if (!role) throw new ActionError('This action is not available for ' + String(request.params.resource), 404)
    const user = response.locals.user as AuthUser
    if (!hasRole(user.role, role)) throw new ActionError('Your role (' + user.role + ') does not allow this action', 403)
    const name = String(request.params.name)
    const namespace = type.namespaced ? String(request.params.namespace) : undefined
    if ((type.namespaced && !namespacePattern.test(namespace!)) || !resourceNamePattern.test(name)) throw new ActionError('Invalid namespace or resource name')
    return { type, name, namespace, header: { apiVersion: type.apiVersion, kind: type.kind, metadata: { name, namespace } } }
  }

  const singular = (type: ResourceKind) => type.kind.toLowerCase()

  router.get('/yaml/:resource/:namespace/:name', handle(async (request, response) => {
    const { type, name, namespace, header } = target(request, response, (kind) => kind.viewRole)
    try {
      const object = await objectApi.read(header)
      const copy = structuredClone(object) as KubernetesObject
      if (copy.metadata) delete (copy.metadata as Record<string, unknown>).managedFields
      if (type.kind === 'Secret') {
        recordAudit(store, request, response, { action: 'secret.reveal', kind: 'Secret', namespace: namespace ?? null, name, result: 'success', error: null, details: { via: 'yaml', keys: Object.keys((object as V1Secret).data || {}) } })
      }
      response.type('application/yaml').send(dumpYaml(copy))
    } catch (error) {
      if (kubernetesCode(error) === 404) throw new ActionError(type.kind + ' ' + name + ' no longer exists', 404)
      throw error
    }
  }))

  router.get('/secrets/:namespace/:name/data', requireRole('admin'), handle(async (request, response) => {
    const namespace = String(request.params.namespace)
    const name = String(request.params.name)
    if (!namespacePattern.test(namespace) || !resourceNamePattern.test(name)) throw new ActionError('Invalid namespace or secret name')
    let secret: V1Secret
    try {
      secret = await coreApi.readNamespacedSecret({ name, namespace })
    } catch (error) {
      if (kubernetesCode(error) === 404) throw new ActionError('Secret ' + name + ' no longer exists', 404)
      throw error
    }
    const entries = decodeSecretData(secret.data)
    recordAudit(store, request, response, { action: 'secret.reveal', kind: 'Secret', namespace, name, result: 'success', error: null, details: { via: 'values', keys: entries.map((entry) => entry.key) } })
    response.json({ name, namespace, type: secret.type || 'Opaque', entries })
  }))

  router.post('/:resource/:namespace/:name/restart', writesEnabled, handle(async (request, response) => {
    const { type, name, namespace, header } = target(request, response, () => 'operator', 'rollout')
    const restartedAt = new Date().toISOString()
    await performAction(store, request, response, { action: singular(type) + '.restart', kind: type.kind, namespace, name }, async () => {
      await objectApi.patch({ ...header, spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': restartedAt } } } } }, undefined, undefined, fieldManager, undefined, PatchStrategy.MergePatch)
      return { details: { restartedAt } }
    })
  }))

  router.post('/:resource/:namespace/:name/scale', writesEnabled, handle(async (request, response) => {
    const { type, name, namespace, header } = target(request, response, () => 'operator', 'scale')
    const replicas = (request.body as { replicas?: unknown } | undefined)?.replicas
    if (typeof replicas !== 'number' || !Number.isInteger(replicas) || replicas < 0 || replicas > 1000) throw new ActionError('Replicas must be a whole number from 0 to 1000')
    await performAction(store, request, response, { action: singular(type) + '.scale', kind: type.kind, namespace, name }, async () => {
      const current = await objectApi.read(header) as KubernetesObject & { spec?: { replicas?: number } }
      await objectApi.patch({ ...header, spec: { replicas } }, undefined, undefined, fieldManager, undefined, PatchStrategy.MergePatch)
      return { details: { before: { replicas: current.spec?.replicas ?? 1 }, after: { replicas } } }
    })
  }))

  router.post('/:resource/:namespace/:name/image', writesEnabled, handle(async (request, response) => {
    const { type, name, namespace, header } = target(request, response, () => 'operator', 'rollout')
    const { container, image } = (request.body ?? {}) as { container?: unknown; image?: unknown }
    if (typeof container !== 'string' || !containerNamePattern.test(container)) throw new ActionError('Choose a container')
    if (typeof image !== 'string' || !imagePattern.test(image.trim())) throw new ActionError('Enter a valid image reference, e.g. nginx:1.27')
    const nextImage = image.trim()
    await performAction(store, request, response, { action: singular(type) + '.image', kind: type.kind, namespace, name, details: { container } }, async () => {
      const current = await objectApi.read(header) as KubernetesObject & { spec?: { template?: V1PodTemplateSpec } }
      const existing = current.spec?.template?.spec?.containers?.find((item) => item.name === container)
      if (!existing) throw new ActionError('Container ' + container + ' is not part of this ' + singular(type), 404)
      await objectApi.patch({ ...header, spec: { template: { spec: { containers: [{ name: container, image: nextImage }] } } } }, undefined, undefined, fieldManager, undefined, PatchStrategy.StrategicMergePatch)
      return { details: { before: { image: existing.image }, after: { image: nextImage } } }
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

  router.delete('/:resource/:namespace/:name', writesEnabled, handle(async (request, response) => {
    const { type, name, namespace, header } = target(request, response, (kind) => kind.namespaced ? kind.deleteRole : undefined)
    await performAction(store, request, response, { action: singular(type) + '.delete', kind: type.kind, namespace, name }, async () => {
      const current = await objectApi.read(header)
      await objectApi.delete(header, undefined, undefined, undefined, undefined, type.propagationPolicy)
      return { details: { before: summarize(current, type.kind) } }
    })
  }))

  router.post('/cronjobs/:namespace/:name/trigger', requireRole('operator'), writesEnabled, handle(async (request, response) => {
    const namespace = String(request.params.namespace)
    const name = String(request.params.name)
    if (!namespacePattern.test(namespace) || !resourceNamePattern.test(name)) throw new ActionError('Invalid namespace or name')
    // Same as `kubectl create job --from=cronjob/<name>`.
    const jobName = (name.slice(0, 52) + '-manual-' + randomBytes(2).toString('hex')).replace(/-+/g, '-')
    await performAction(store, request, response, { action: 'cronjob.trigger', kind: 'CronJob', namespace, name, details: { job: jobName } }, async () => {
      const cronJob = await kube.batchApi.readNamespacedCronJob({ name, namespace }) as V1CronJob
      await objectApi.create({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: jobName,
          namespace,
          labels: cronJob.spec?.jobTemplate.metadata?.labels,
          annotations: { ...cronJob.spec?.jobTemplate.metadata?.annotations, 'cronjob.kubernetes.io/instantiate': 'manual' },
          ownerReferences: cronJob.metadata?.uid ? [{ apiVersion: 'batch/v1', kind: 'CronJob', name, uid: cronJob.metadata.uid, controller: true, blockOwnerDeletion: true }] : undefined,
        },
        spec: cronJob.spec?.jobTemplate.spec,
      } as KubernetesObject, undefined, undefined, fieldManager)
      return { body: { job: jobName } }
    })
  }))

  router.post('/cronjobs/:namespace/:name/suspend', requireRole('operator'), writesEnabled, handle(async (request, response) => {
    const namespace = String(request.params.namespace)
    const name = String(request.params.name)
    if (!namespacePattern.test(namespace) || !resourceNamePattern.test(name)) throw new ActionError('Invalid namespace or name')
    const suspend = (request.body as { suspend?: unknown } | undefined)?.suspend
    if (typeof suspend !== 'boolean') throw new ActionError('suspend must be true or false')
    await performAction(store, request, response, { action: suspend ? 'cronjob.suspend' : 'cronjob.resume', kind: 'CronJob', namespace, name }, async () => {
      await objectApi.patch({ apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name, namespace }, spec: { suspend } }, undefined, undefined, fieldManager, undefined, PatchStrategy.MergePatch)
      return { details: { after: { suspend } } }
    })
  }))

  router.post('/pods/:namespace/:name/debug', requireRole('operator'), writesEnabled, handle(async (request, response) => {
    const namespace = String(request.params.namespace)
    const name = String(request.params.name)
    if (!namespacePattern.test(namespace) || !resourceNamePattern.test(name)) throw new ActionError('Invalid namespace or pod name')
    const { target: targetContainer, image } = (request.body ?? {}) as { target?: unknown; image?: unknown }
    if (targetContainer !== undefined && targetContainer !== '' && (typeof targetContainer !== 'string' || !containerNamePattern.test(targetContainer))) throw new ActionError('Invalid target container')
    const debugImage = typeof image === 'string' && image.trim() ? image.trim() : options.debugImage
    if (!imagePattern.test(debugImage)) throw new ActionError('Enter a valid debug image reference')
    const container = 'debugger-' + randomBytes(3).toString('hex')
    await performAction(store, request, response, { action: 'pod.debug', kind: 'Pod', namespace, name, details: { container, image: debugImage, target: targetContainer || null } }, async () => {
      const pod = await coreApi.readNamespacedPod({ name, namespace })
      if (targetContainer && !pod.spec?.containers?.some((item) => item.name === targetContainer)) throw new ActionError('Container ' + targetContainer + ' is not part of this pod', 404)
      pod.spec = pod.spec || { containers: [] }
      pod.spec.ephemeralContainers = [...(pod.spec.ephemeralContainers || []), {
        name: container,
        image: debugImage,
        targetContainerName: typeof targetContainer === 'string' && targetContainer ? targetContainer : undefined,
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
      // Secret values must never reach the audit log; record key names instead.
      const auditable = (object: KubernetesObject | null) => !object ? null : object.kind === 'Secret' ? { ...summarize(object), keys: Object.keys({ ...(object as V1Secret).data, ...(object as V1Secret).stringData }) } : cleanObject(object)
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
        if (!isDryRun) recordAudit(store, request, response, { action: 'resource.apply', kind: target.kind, namespace, name: target.name, result: 'success', error: null, details: { operation, before: auditable(before), after: auditable(body) } })
      } catch (error) {
        const message = kubernetesMessage(error)
        results.push({ ...target, operation: 'failed', error: message })
        if (!isDryRun) recordAudit(store, request, response, { action: 'resource.apply', kind: target.kind, namespace: target.namespace, name: target.name, result: 'failure', error: message, details: { after: auditable(body) } })
      }
    }
    const failed = results.filter((item) => item.operation === 'failed').length
    response.status(failed === results.length ? 422 : 200).json({ ok: failed === 0, dryRun: isDryRun, results })
  }))

  return router
}
