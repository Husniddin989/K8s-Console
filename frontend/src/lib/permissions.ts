import type { AuthSession, Role } from '../types'

/** What each console action needs. Mirrors the backend's requireRole checks. */
export const capabilities = {
  restart: { role: 'operator', clusterWrite: true },
  scale: { role: 'operator', clusterWrite: true },
  setImage: { role: 'operator', clusterWrite: true },
  deletePod: { role: 'operator', clusterWrite: true },
  deleteResource: { role: 'admin', clusterWrite: true },
  apply: { role: 'admin', clusterWrite: true },
  shell: { role: 'admin', clusterWrite: true },
  debug: { role: 'admin', clusterWrite: true },
  manageUsers: { role: 'admin', clusterWrite: false },
  viewAudit: { role: 'admin', clusterWrite: false },
} as const satisfies Record<string, { role: Role; clusterWrite: boolean }>

export type Capability = keyof typeof capabilities

const rank: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }
const roleNames: Record<Role, string> = { viewer: 'Viewer', operator: 'Operator', admin: 'Admin' }

export function can(session: AuthSession, capability: Capability): boolean {
  const rule = capabilities[capability]
  return rank[session.user.role] >= rank[rule.role] && (!rule.clusterWrite || session.clusterWrites)
}

/** Why an action is unavailable, for the disabled menu item's hint; empty when allowed. */
export function blockedReason(session: AuthSession, capability: Capability): string {
  const rule = capabilities[capability]
  if (rule.clusterWrite && !session.clusterWrites) return 'Cluster changes are turned off'
  if (rank[session.user.role] < rank[rule.role]) return 'Requires ' + roleNames[rule.role]
  return ''
}
