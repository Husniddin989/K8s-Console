import type * as k8s from '@kubernetes/client-node'
import { describe, expect, it } from 'vitest'
import { decodeSecretData, jobStatus, mapConfigMap, mapCronJob, mapDaemonSet, mapEvent, mapJob, mapNode, mapPod, mapSecret, mapService, mapStatefulSet, podStatus, serviceExternalIp, servicePorts } from '../src/resources.js'

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

describe('workloads', () => {
  const template = { spec: { containers: [{ name: 'app', image: 'app:1' }, { name: 'sidecar', image: 'proxy:2' }] } }

  it('maps statefulsets and daemonsets like kubectl', () => {
    expect(mapStatefulSet({ metadata: { name: 'db', namespace: 'data' }, spec: { replicas: 3, serviceName: 'db', selector: {}, template }, status: { replicas: 3, readyReplicas: 2, updatedReplicas: 3 } }))
      .toMatchObject({ desired: 3, ready: 2, upToDate: 3, serviceName: 'db', containers: ['app', 'sidecar'], images: ['app:1', 'proxy:2'] })
    expect(mapDaemonSet({ metadata: { name: 'agent', namespace: 'kube-system' }, spec: { selector: {}, template: { spec: { ...template.spec, nodeSelector: { 'kubernetes.io/os': 'linux' } } } }, status: { desiredNumberScheduled: 2, currentNumberScheduled: 2, numberReady: 1, numberMisscheduled: 0, updatedNumberScheduled: 2, numberAvailable: 1 } }))
      .toMatchObject({ desired: 2, current: 2, ready: 1, upToDate: 2, available: 1, nodeSelector: 'kubernetes.io/os=linux' })
  })

  it('derives job status and completions', () => {
    const job = (status: k8s.V1JobStatus, spec: Partial<k8s.V1JobSpec> = {}): k8s.V1Job => ({ metadata: { name: 'j', namespace: 'default', ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name: 'nightly', uid: 'u' }] }, spec: { template, completions: 2, ...spec }, status })
    expect(jobStatus(job({ conditions: [{ type: 'Complete', status: 'True' }] }))).toBe('Complete')
    expect(jobStatus(job({ conditions: [{ type: 'Failed', status: 'True' }] }))).toBe('Failed')
    expect(jobStatus(job({}, { suspend: true }))).toBe('Suspended')
    expect(jobStatus(job({ active: 1 }))).toBe('Running')
    expect(mapJob(job({ succeeded: 1, startTime: new Date('2026-01-01T00:00:00Z') }))).toMatchObject({ succeeded: 1, completions: 2, owner: 'cronjob/nightly', startTime: '2026-01-01T00:00:00.000Z', completionTime: null })
  })

  it('maps cronjobs', () => {
    expect(mapCronJob({ metadata: { name: 'nightly', namespace: 'default' }, spec: { schedule: '0 1 * * *', suspend: true, jobTemplate: { spec: { template } } }, status: { active: [{ name: 'x' }], lastScheduleTime: new Date('2026-01-01T01:00:00Z') } }))
      .toMatchObject({ schedule: '0 1 * * *', timeZone: '<none>', suspend: true, active: 1, lastScheduleTime: '2026-01-01T01:00:00.000Z', images: ['app:1', 'proxy:2'] })
  })
})

describe('config and secrets', () => {
  it('lists configmap keys including binary data', () => {
    expect(mapConfigMap({ metadata: { name: 'c', namespace: 'default' }, data: { b: '1', a: '2' }, binaryData: { logo: 'AA==' } }).keys).toEqual(['a', 'b', 'logo'])
  })

  it('never includes secret values in list rows', () => {
    const row = mapSecret({ metadata: { name: 's', namespace: 'default' }, type: 'kubernetes.io/tls', data: { 'tls.key': 'c2VjcmV0', 'tls.crt': 'Y2VydA==' } })
    expect(row).toEqual({ name: 's', namespace: 'default', type: 'kubernetes.io/tls', keys: ['tls.crt', 'tls.key'], immutable: false, createdAt: null })
    expect(JSON.stringify(row)).not.toContain('c2VjcmV0')
  })

  it('decodes text values and keeps binary ones as base64', () => {
    expect(decodeSecretData({ password: Buffer.from('pä55\nword').toString('base64'), raw: Buffer.from([255, 0, 1]).toString('base64') })).toEqual([
      { key: 'password', value: 'pä55\nword', binary: false },
      { key: 'raw', value: Buffer.from([255, 0, 1]).toString('base64'), binary: true },
    ])
  })
})
