import type * as k8s from '@kubernetes/client-node'
import { describe, expect, it } from 'vitest'
import { mapEvent, mapNode, mapPod, mapService, podStatus, serviceExternalIp, servicePorts } from '../src/resources.js'

const pod = (status: k8s.V1PodStatus, extra: Partial<k8s.V1Pod> = {}): k8s.V1Pod => ({
  metadata: { name: 'p', namespace: 'default' },
  spec: { containers: [{ name: 'app' }] },
  status,
  ...extra,
})

describe('podStatus (kubectl STATUS column)', () => {
  it('shows Running for a healthy pod', () => {
    expect(podStatus(pod({ phase: 'Running', containerStatuses: [{ name: 'app', image: 'x', imageID: '', ready: true, restartCount: 0, state: { running: {} } }] }))).toBe('Running')
  })

  it('shows the waiting reason such as CrashLoopBackOff', () => {
    expect(podStatus(pod({ phase: 'Running', containerStatuses: [{ name: 'app', image: 'x', imageID: '', ready: false, restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } }] }))).toBe('CrashLoopBackOff')
  })

  it('shows Init progress and init failures', () => {
    const spec = { containers: [{ name: 'app' }], initContainers: [{ name: 'a' }, { name: 'b' }] }
    expect(podStatus(pod({ phase: 'Pending', initContainerStatuses: [
      { name: 'a', image: 'x', imageID: '', ready: true, restartCount: 0, state: { terminated: { exitCode: 0 } } },
      { name: 'b', image: 'x', imageID: '', ready: false, restartCount: 0, state: { running: {} } },
    ] }, { spec }))).toBe('Init:1/2')
    expect(podStatus(pod({ phase: 'Pending', initContainerStatuses: [
      { name: 'a', image: 'x', imageID: '', ready: false, restartCount: 1, state: { terminated: { exitCode: 1, reason: 'Error' } } },
    ] }, { spec }))).toBe('Init:Error')
  })

  it('shows Completed and Terminating', () => {
    expect(podStatus(pod({ phase: 'Succeeded', containerStatuses: [{ name: 'app', image: 'x', imageID: '', ready: false, restartCount: 0, state: { terminated: { exitCode: 0, reason: 'Completed' } } }] }))).toBe('Completed')
    expect(podStatus(pod({ phase: 'Running' }, { metadata: { name: 'p', deletionTimestamp: new Date() } }))).toBe('Terminating')
  })
})

describe('mapPod', () => {
  it('reports restarts with the most recent restart time', () => {
    const mapped = mapPod(pod({ phase: 'Running', containerStatuses: [
      { name: 'a', image: 'x', imageID: '', ready: true, restartCount: 1, state: { running: {} }, lastState: { terminated: { exitCode: 1, finishedAt: new Date('2026-01-01T00:00:00Z') } } },
      { name: 'b', image: 'x', imageID: '', ready: true, restartCount: 2, state: { running: {} }, lastState: { terminated: { exitCode: 1, finishedAt: new Date('2026-01-02T00:00:00Z') } } },
    ] }))
    expect(mapped.restarts).toBe(3)
    expect(mapped.lastRestartAt).toBe('2026-01-02T00:00:00.000Z')
    expect(mapped.ip).toBe('<none>')
  })
})

describe('services (kubectl get svc columns)', () => {
  const service = (spec: k8s.V1ServiceSpec, status?: k8s.V1ServiceStatus): k8s.V1Service => ({ metadata: { name: 's', namespace: 'default' }, spec, status })

  it('formats ports like kubectl', () => {
    expect(servicePorts(service({ ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }, { port: 9153 }] }))).toBe('53/UDP,53/TCP,9153/TCP')
    expect(servicePorts(service({ type: 'NodePort', ports: [{ port: 80, nodePort: 30080, protocol: 'TCP' }] }))).toBe('80:30080/TCP')
    expect(servicePorts(service({}))).toBe('<none>')
  })

  it('formats EXTERNAL-IP like kubectl', () => {
    expect(serviceExternalIp(service({ type: 'ClusterIP' }))).toBe('<none>')
    expect(serviceExternalIp(service({ type: 'LoadBalancer' }))).toBe('<pending>')
    expect(serviceExternalIp(service({ type: 'LoadBalancer' }, { loadBalancer: { ingress: [{ ip: '1.2.3.4' }] } }))).toBe('1.2.3.4')
    expect(serviceExternalIp(service({ type: 'ExternalName', externalName: 'db.example.com' }))).toBe('db.example.com')
  })

  it('maps a headless service', () => {
    expect(mapService(service({ clusterIP: 'None', selector: { app: 'db' } }))).toMatchObject({ type: 'ClusterIP', clusterIp: 'None', selector: 'app=db' })
  })
})

describe('nodes and events', () => {
  it('maps node wide columns', () => {
    const node = mapNode({
      metadata: { name: 'n', labels: { 'node-role.kubernetes.io/control-plane': '' } },
      spec: { unschedulable: true },
      status: { conditions: [{ type: 'Ready', status: 'True' }], addresses: [{ type: 'InternalIP', address: '172.18.0.2' }], nodeInfo: { kubeletVersion: 'v1.37.0', containerRuntimeVersion: 'containerd://2.1', kernelVersion: '6.10', osImage: 'Debian', architecture: 'arm64', bootID: '', kubeProxyVersion: '', machineID: '', operatingSystem: 'linux', systemUUID: '' } },
    })
    expect(node).toMatchObject({ status: 'Ready,SchedulingDisabled', roles: ['control-plane'], internalIp: '172.18.0.2', externalIp: '<none>', containerRuntime: 'containerd://2.1' })
  })

  it('prefixes the involved object kind', () => {
    expect(mapEvent({ metadata: {}, involvedObject: { kind: 'Pod', name: 'web-1' } }).object).toBe('pod/web-1')
  })
})
