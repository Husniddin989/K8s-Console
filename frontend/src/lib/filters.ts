import type { DeploymentItem, EventItem, NodeItem, PodItem, ServiceItem } from '../types'

export function searchTerm(search: string): string {
  return search.toLowerCase().trim()
}

function matches(values: string[], term: string): boolean {
  return !term || values.some((value) => value.toLowerCase().includes(term))
}

export const podMatches = (pod: PodItem, term: string) => matches([pod.name, pod.namespace, pod.node, pod.status, pod.ip, ...pod.images], term)
export const deploymentMatches = (deployment: DeploymentItem, term: string) => matches([deployment.name, deployment.namespace, deployment.selector, ...deployment.images], term)
export const serviceMatches = (service: ServiceItem, term: string) => matches([service.name, service.namespace, service.type, service.clusterIp, service.externalIp, service.ports, service.selector], term)
export const nodeMatches = (node: NodeItem, term: string) => matches([node.name, node.status, node.kubeletVersion, node.internalIp, node.architecture, node.osImage, ...node.roles], term)
export const eventMatches = (event: EventItem, term: string) => matches([event.type, event.reason, event.message, event.object, event.namespace], term)

export function filterItems<T>(items: T[], search: string, matcher: (item: T, term: string) => boolean): T[] {
  const term = searchTerm(search)
  return term ? items.filter((item) => matcher(item, term)) : items
}

/** Matches any string (or list of strings) on the row; used for the simpler list pages. */
export function anyFieldMatches(row: object, term: string): boolean {
  if (!term) return true
  return Object.values(row).some((value) => typeof value === 'string'
    ? value.toLowerCase().includes(term)
    : Array.isArray(value) && value.some((item) => typeof item === 'string' && item.toLowerCase().includes(term)))
}
