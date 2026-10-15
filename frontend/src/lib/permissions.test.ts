import { describe, expect, it } from 'vitest'
import type { AuthSession, Role } from '../types'
import { blockedReason, can } from './permissions'

const session = (role: Role, clusterWrites = true): AuthSession => ({
  user: { username: role, role, permissions: { read: true, operate: role !== 'viewer', administer: role === 'admin' } },
  expiresAt: '',
  clusterWrites,
})

describe('can', () => {
  it('matches the backend role matrix', () => {
    expect(can(session('viewer'), 'scale')).toBe(false)
    expect(can(session('operator'), 'scale')).toBe(true)
    expect(can(session('operator'), 'deletePod')).toBe(true)
    expect(can(session('operator'), 'deleteResource')).toBe(false)
    expect(can(session('operator'), 'shell')).toBe(false)
    expect(can(session('admin'), 'shell')).toBe(true)
    expect(can(session('admin'), 'manageUsers')).toBe(true)
  })

  it('turns off cluster changes but keeps user management when writes are off', () => {
    expect(can(session('admin', false), 'restart')).toBe(false)
    expect(can(session('admin', false), 'manageUsers')).toBe(true)
    expect(blockedReason(session('admin', false), 'apply')).toBe('Cluster changes are turned off')
    expect(blockedReason(session('viewer'), 'restart')).toBe('Requires Operator')
    expect(blockedReason(session('admin'), 'restart')).toBe('')
  })
})
