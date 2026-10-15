import type * as k8s from '@kubernetes/client-node'

/** Converts Kubernetes objects to the rows the console shows, following `kubectl get` column rules. */

function timestamp(value: Date | string | undefined | null): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Same rules as kubectl's pod STATUS column (printPod in kubectl's printers). */
export function podStatus(pod: k8s.V1Pod): string {
  const status = pod.status
  let reason = status?.reason || status?.phase || 'Unknown'

  const initStatuses = status?.initContainerStatuses || []
  const initTotal = pod.spec?.initContainers?.length || initStatuses.length
  let initializing = false
  for (const [index, container] of initStatuses.entries()) {
    const terminated = container.state?.terminated
    const waiting = container.state?.waiting
    if (terminated && terminated.exitCode === 0) continue
    // Restartable (sidecar) init containers count as done once they are running.
    if (container.started && container.state?.running && pod.spec?.initContainers?.[index]?.restartPolicy === 'Always') continue
    if (terminated) {
      reason = terminated.reason ? 'Init:' + terminated.reason : terminated.signal ? 'Init:Signal:' + terminated.signal : 'Init:ExitCode:' + terminated.exitCode
    } else if (waiting?.reason && waiting.reason !== 'PodInitializing') {
      reason = 'Init:' + waiting.reason
    } else {
      reason = 'Init:' + index + '/' + initTotal
    }
    initializing = true
    break
  }

  if (!initializing) {
    let hasRunning = false
    const containerStatuses = status?.containerStatuses || []
    for (let index = containerStatuses.length - 1; index >= 0; index -= 1) {
      const container = containerStatuses[index]
      const waiting = container.state?.waiting
      const terminated = container.state?.terminated
      if (waiting?.reason) {
        reason = waiting.reason
      } else if (terminated?.reason) {
        reason = terminated.reason
      } else if (terminated) {
        reason = terminated.signal ? 'Signal:' + terminated.signal : 'ExitCode:' + terminated.exitCode
      } else if (container.ready && container.state?.running) {
        hasRunning = true
      }
    }
    if (reason === 'Completed' && hasRunning) {
      const ready = status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')
      reason = ready ? 'Running' : 'NotReady'
    }
  }

  if (pod.metadata?.deletionTimestamp) {
    reason = status?.reason === 'NodeLost' ? 'Unknown' : 'Terminating'
  }
  return reason
}

export function mapPod(pod: k8s.V1Pod) {
  const statuses = pod.status?.containerStatuses || []
  let lastRestartAt: string | null = null
  for (const container of statuses) {
    const finished = timestamp(container.lastState?.terminated?.finishedAt)
    if (finished && (!lastRestartAt || finished > lastRestartAt)) lastRestartAt = finished
  }
  return {
    name: pod.metadata?.name || 'unknown',
    namespace: pod.metadata?.namespace || 'default',
    phase: pod.status?.phase || 'Unknown',
    status: podStatus(pod),
    node: pod.spec?.nodeName || '<none>',
    restarts: statuses.reduce((sum, container) => sum + (container.restartCount || 0), 0),
    lastRestartAt,
    ready: statuses.filter((container) => container.ready).length,
    containers: pod.spec?.containers?.length || 0,
    containerNames: (pod.spec?.containers || []).map((container) => container.name),
    images: (pod.spec?.containers || []).map((container) => container.image || ''),
    createdAt: timestamp(pod.metadata?.creationTimestamp),
    ip: pod.status?.podIP || '<none>',
    labels: pod.metadata?.labels || {},
  }
}

export function mapDeployment(deployment: k8s.V1Deployment) {
  const containers = deployment.spec?.template.spec?.containers || []
  return {
    name: deployment.metadata?.name || 'unknown',
    namespace: deployment.metadata?.namespace || 'default',
    desired: deployment.spec?.replicas ?? 1,
    ready: deployment.status?.readyReplicas ?? 0,
    upToDate: deployment.status?.updatedReplicas ?? 0,
    available: deployment.status?.availableReplicas ?? 0,
    containers: containers.map((container) => container.name),
    images: containers.map((container) => container.image || ''),
    selector: Object.entries(deployment.spec?.selector?.matchLabels || {}).map(([key, value]) => key + '=' + value).join(',') || '<none>',
    createdAt: timestamp(deployment.metadata?.creationTimestamp),
  }
}

/** kubectl's PORT(S) column: `80/TCP`, `80:30080/TCP` for node ports. */
export function servicePorts(service: k8s.V1Service): string {
  const ports = service.spec?.ports || []
  if (!ports.length) return '<none>'
  return ports.map((port) => port.port + (port.nodePort ? ':' + port.nodePort : '') + '/' + (port.protocol || 'TCP')).join(',')
}

/** kubectl's EXTERNAL-IP column. */
export function serviceExternalIp(service: k8s.V1Service): string {
  const type = service.spec?.type || 'ClusterIP'
  const externalIps = service.spec?.externalIPs || []
  if (type === 'ExternalName') return service.spec?.externalName || '<none>'
  if (type === 'LoadBalancer') {
    const ingress = (service.status?.loadBalancer?.ingress || []).map((item) => item.ip || item.hostname || '').filter(Boolean)
    const all = ingress.concat(externalIps)
    return all.length ? all.join(',') : '<pending>'
  }
  return externalIps.length ? externalIps.join(',') : '<none>'
}

export function mapService(service: k8s.V1Service) {
  return {
    name: service.metadata?.name || 'unknown',
    namespace: service.metadata?.namespace || 'default',
    type: service.spec?.type || 'ClusterIP',
    clusterIp: service.spec?.clusterIP || '<none>',
    externalIp: serviceExternalIp(service),
    ports: servicePorts(service),
    selector: Object.entries(service.spec?.selector || {}).map(([key, value]) => key + '=' + value).join(',') || '<none>',
    createdAt: timestamp(service.metadata?.creationTimestamp),
  }
}

export function nodeIsReady(node: k8s.V1Node): boolean {
  return node.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True') ?? false
}

export function mapNode(node: k8s.V1Node) {
  const roles = Object.keys(node.metadata?.labels || {})
    .filter((label) => label.startsWith('node-role.kubernetes.io/'))
    .map((label) => label.split('/')[1])
    .filter(Boolean)
  const address = (type: string) => node.status?.addresses?.find((item) => item.type === type)?.address || '<none>'
  const ready = nodeIsReady(node)
  return {
    name: node.metadata?.name || 'unknown',
    ready,
    status: (ready ? 'Ready' : 'NotReady') + (node.spec?.unschedulable ? ',SchedulingDisabled' : ''),
    roles: roles.length ? roles : ['<none>'],
    kubeletVersion: node.status?.nodeInfo?.kubeletVersion || '—',
    internalIp: address('InternalIP'),
    externalIp: address('ExternalIP'),
    osImage: node.status?.nodeInfo?.osImage || '—',
    kernelVersion: node.status?.nodeInfo?.kernelVersion || '—',
    containerRuntime: node.status?.nodeInfo?.containerRuntimeVersion || '—',
    architecture: node.status?.nodeInfo?.architecture || '—',
    cpu: node.status?.capacity?.cpu || '—',
    memory: node.status?.capacity?.memory || '—',
    pods: node.status?.capacity?.pods || '—',
    createdAt: timestamp(node.metadata?.creationTimestamp),
  }
}

export function mapEvent(event: k8s.CoreV1Event) {
  return {
    name: event.metadata?.name || 'unknown',
    namespace: event.metadata?.namespace || 'default',
    type: event.type || 'Normal',
    reason: event.reason || 'Event',
    message: event.message || '',
    object: (event.involvedObject?.kind ? event.involvedObject.kind.toLowerCase() + '/' : '') + (event.involvedObject?.name || '—'),
    count: event.count || event.series?.count || 1,
    time: timestamp(event.lastTimestamp) || timestamp(event.eventTime) || timestamp(event.firstTimestamp) || timestamp(event.metadata?.creationTimestamp),
  }
}

export function byNamespaceAndName(a: { namespace: string; name: string }, b: { namespace: string; name: string }): number {
  return a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)
}

function containersOf(template: k8s.V1PodTemplateSpec | undefined) {
  const containers = template?.spec?.containers || []
  return { containers: containers.map((container) => container.name), images: containers.map((container) => container.image || '') }
}

function selectorText(labels: Record<string, string> | undefined): string {
  return Object.entries(labels || {}).map(([key, value]) => key + '=' + value).join(',') || '<none>'
}

/** kubectl get statefulsets: READY is ready/desired. */
export function mapStatefulSet(statefulSet: k8s.V1StatefulSet) {
  return {
    name: statefulSet.metadata?.name || 'unknown',
    namespace: statefulSet.metadata?.namespace || 'default',
    desired: statefulSet.spec?.replicas ?? 1,
    ready: statefulSet.status?.readyReplicas ?? 0,
    upToDate: statefulSet.status?.updatedReplicas ?? 0,
    serviceName: statefulSet.spec?.serviceName || '<none>',
    ...containersOf(statefulSet.spec?.template),
    createdAt: timestamp(statefulSet.metadata?.creationTimestamp),
  }
}

/** kubectl get daemonsets: DESIRED CURRENT READY UP-TO-DATE AVAILABLE NODE SELECTOR. */
export function mapDaemonSet(daemonSet: k8s.V1DaemonSet) {
  return {
    name: daemonSet.metadata?.name || 'unknown',
    namespace: daemonSet.metadata?.namespace || 'default',
    desired: daemonSet.status?.desiredNumberScheduled ?? 0,
    current: daemonSet.status?.currentNumberScheduled ?? 0,
    ready: daemonSet.status?.numberReady ?? 0,
    upToDate: daemonSet.status?.updatedNumberScheduled ?? 0,
    available: daemonSet.status?.numberAvailable ?? 0,
    nodeSelector: selectorText(daemonSet.spec?.template.spec?.nodeSelector),
    ...containersOf(daemonSet.spec?.template),
    createdAt: timestamp(daemonSet.metadata?.creationTimestamp),
  }
}

/** kubectl's job STATUS column. */
export function jobStatus(job: k8s.V1Job): string {
  const condition = (type: string) => job.status?.conditions?.some((item) => item.type === type && item.status === 'True')
  if (condition('Complete')) return 'Complete'
  if (condition('Failed')) return 'Failed'
  if (condition('FailureTarget')) return 'FailureTarget'
  if (condition('SuccessCriteriaMet')) return 'SuccessCriteriaMet'
  if (job.spec?.suspend) return 'Suspended'
  return 'Running'
}

export function mapJob(job: k8s.V1Job) {
  return {
    name: job.metadata?.name || 'unknown',
    namespace: job.metadata?.namespace || 'default',
    status: jobStatus(job),
    succeeded: job.status?.succeeded ?? 0,
    completions: job.spec?.completions ?? 1,
    active: job.status?.active ?? 0,
    failed: job.status?.failed ?? 0,
    startTime: timestamp(job.status?.startTime),
    completionTime: timestamp(job.status?.completionTime),
    owner: job.metadata?.ownerReferences?.[0] ? job.metadata.ownerReferences[0].kind.toLowerCase() + '/' + job.metadata.ownerReferences[0].name : null,
    ...containersOf(job.spec?.template),
    createdAt: timestamp(job.metadata?.creationTimestamp),
  }
}

export function mapCronJob(cronJob: k8s.V1CronJob) {
  return {
    name: cronJob.metadata?.name || 'unknown',
    namespace: cronJob.metadata?.namespace || 'default',
    schedule: cronJob.spec?.schedule || '',
    timeZone: cronJob.spec?.timeZone || '<none>',
    suspend: Boolean(cronJob.spec?.suspend),
    active: cronJob.status?.active?.length ?? 0,
    lastScheduleTime: timestamp(cronJob.status?.lastScheduleTime),
    lastSuccessfulTime: timestamp(cronJob.status?.lastSuccessfulTime),
    ...containersOf(cronJob.spec?.jobTemplate.spec?.template),
    createdAt: timestamp(cronJob.metadata?.creationTimestamp),
  }
}

export function mapConfigMap(configMap: k8s.V1ConfigMap) {
  const keys = [...Object.keys(configMap.data || {}), ...Object.keys(configMap.binaryData || {})].sort()
  return {
    name: configMap.metadata?.name || 'unknown',
    namespace: configMap.metadata?.namespace || 'default',
    keys,
    immutable: Boolean(configMap.immutable),
    createdAt: timestamp(configMap.metadata?.creationTimestamp),
  }
}

/** Secret rows carry key names only; values are never part of a list response. */
export function mapSecret(secret: k8s.V1Secret) {
  return {
    name: secret.metadata?.name || 'unknown',
    namespace: secret.metadata?.namespace || 'default',
    type: secret.type || 'Opaque',
    keys: Object.keys(secret.data || {}).sort(),
    immutable: Boolean(secret.immutable),
    createdAt: timestamp(secret.metadata?.creationTimestamp),
  }
}

/** Decodes secret values for display; non-UTF-8 values stay base64 and are flagged. */
export function decodeSecretData(data: Record<string, string> | undefined): Array<{ key: string; value: string; binary: boolean }> {
  return Object.entries(data || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, encoded]) => {
    const bytes = Buffer.from(encoded, 'base64')
    const text = bytes.toString('utf8')
    const binary = !Buffer.from(text, 'utf8').equals(bytes) || /[\u0000-\u0008\u000e-\u001f]/.test(text)
    return { key, value: binary ? encoded : text, binary }
  })
}
