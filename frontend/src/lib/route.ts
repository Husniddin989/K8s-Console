import type { PageId } from '../types'

const pages: PageId[] = ['overview', 'namespaces', 'nodes', 'pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'services', 'configmaps', 'secrets', 'events', 'logs', 'users', 'audit']
const aliases: Record<string, PageId> = { workloads: 'pods' }
const namespacePattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/

export interface Route {
  page: PageId
  namespace: string
}

/** Reads `#/<page>?namespace=<name>` so a browser refresh keeps the current view. */
export function parseRoute(hash: string): Route {
  const [pathPart, queryPart = ''] = hash.replace(/^#\/?/, '').split('?')
  const page = pages.includes(pathPart as PageId) ? pathPart as PageId : aliases[pathPart] || 'overview'
  const namespace = new URLSearchParams(queryPart).get('namespace') || 'all'
  return { page, namespace: namespace === 'all' || namespacePattern.test(namespace) ? namespace : 'all' }
}

export function formatRoute(route: Route): string {
  return '#/' + route.page + (route.namespace === 'all' ? '' : '?namespace=' + encodeURIComponent(route.namespace))
}
