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
