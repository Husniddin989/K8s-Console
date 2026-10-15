import { describe, expect, it } from 'vitest'
import { statusTone } from './format'
import { formatRoute, parseRoute } from './route'

describe('statusTone', () => {
  it('maps kubectl statuses to badge tones', () => {
    expect(statusTone('Running')).toBe('good')
    expect(statusTone('Ready,SchedulingDisabled')).toBe('good')
    expect(statusTone('ContainerCreating')).toBe('pending')
    expect(statusTone('Init:0/2')).toBe('pending')
    expect(statusTone('Terminating')).toBe('pending')
    expect(statusTone('Completed')).toBe('neutral')
    expect(statusTone('CrashLoopBackOff')).toBe('bad')
    expect(statusTone('Init:ImagePullBackOff')).toBe('bad')
    expect(statusTone('OOMKilled')).toBe('bad')
    expect(statusTone('Warning')).toBe('bad')
  })
})

describe('route', () => {
  it('round-trips page and namespace', () => {
    expect(parseRoute(formatRoute({ page: 'services', namespace: 'kube-system' }))).toEqual({ page: 'services', namespace: 'kube-system' })
    expect(formatRoute({ page: 'overview', namespace: 'all' })).toBe('#/overview')
  })

  it('keeps old links working and falls back safely', () => {
    expect(parseRoute('#/workloads?namespace=default')).toEqual({ page: 'pods', namespace: 'default' })
    expect(parseRoute('')).toEqual({ page: 'overview', namespace: 'all' })
    expect(parseRoute('#/secrets?namespace=Bad_Name')).toEqual({ page: 'overview', namespace: 'all' })
  })
})
