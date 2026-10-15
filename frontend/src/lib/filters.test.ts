import { describe, expect, it } from 'vitest'
import type { EventItem, NodeItem, PodItem, ServiceItem } from '../types'
import { anyFieldMatches, eventMatches, filterItems, nodeMatches, podMatches, serviceMatches } from './filters'

const pod = (name: string, namespace = 'default', status = 'Running'): PodItem => ({ name, namespace, phase: 'Running', status, node: 'kind-control-plane', restarts: 0, lastRestartAt: null, ready: 1, containers: 1, containerNames: ['app'], images: ['nginx:1.27'], createdAt: null, ip: '10.244.0.5', labels: {} })

describe('filterItems', () => {
  const pods = [pod('web-1'), pod('api-1', 'payments'), pod('job-1', 'default', 'CrashLoopBackOff')]

  it('returns the same list for an empty or blank search', () => {
    expect(filterItems(pods, '', podMatches)).toBe(pods)
    expect(filterItems(pods, '   ', podMatches)).toBe(pods)
  })

  it('matches pods by name, namespace, status, IP and image', () => {
    expect(filterItems(pods, 'WEB', podMatches).map((item) => item.name)).toEqual(['web-1'])
    expect(filterItems(pods, 'payments', podMatches).map((item) => item.name)).toEqual(['api-1'])
    expect(filterItems(pods, ' crashloop ', podMatches).map((item) => item.name)).toEqual(['job-1'])
    expect(filterItems(pods, '10.244.0.5', podMatches)).toHaveLength(3)
    expect(filterItems(pods, 'nginx', podMatches)).toHaveLength(3)
  })

  it('matches services by type, IP and port', () => {
    const service: ServiceItem = { name: 'kube-dns', namespace: 'kube-system', type: 'ClusterIP', clusterIp: '10.96.0.10', externalIp: '<none>', ports: '53/UDP,53/TCP,9153/TCP', selector: 'k8s-app=kube-dns', createdAt: null }
    expect(serviceMatches(service, '9153')).toBe(true)
    expect(serviceMatches(service, '10.96.0.10')).toBe(true)
    expect(serviceMatches(service, 'loadbalancer')).toBe(false)
  })

  it('matches node roles and event types', () => {
    const node: NodeItem = { name: 'n1', ready: true, status: 'Ready', roles: ['control-plane'], kubeletVersion: 'v1.37.0', internalIp: '172.18.0.2', externalIp: '<none>', osImage: 'Debian', kernelVersion: '6.10', containerRuntime: 'containerd://2.1', architecture: 'arm64', cpu: '8', memory: '8Gi', pods: '110', createdAt: null }
    expect(nodeMatches(node, 'control')).toBe(true)
    expect(nodeMatches(node, '172.18')).toBe(true)
    const event: EventItem = { name: 'e', namespace: 'default', type: 'Warning', reason: 'BackOff', message: 'Back-off restarting', object: 'pod/web-1', count: 1, time: null }
    expect(eventMatches(event, 'warning')).toBe(true)
    expect(eventMatches(event, 'oomkilled')).toBe(false)
  })
})

describe('anyFieldMatches', () => {
  it('searches strings and string lists on any row', () => {
    const cronJob = { name: 'nightly', namespace: 'ops', schedule: '0 1 * * *', images: ['busybox:1.36'], suspend: false, active: 0 }
    expect(anyFieldMatches(cronJob, 'busybox')).toBe(true)
    expect(anyFieldMatches(cronJob, '0 1 *')).toBe(true)
    expect(anyFieldMatches(cronJob, 'ops')).toBe(true)
    expect(anyFieldMatches(cronJob, 'false')).toBe(false)
    expect(anyFieldMatches(cronJob, '')).toBe(true)
  })
})
