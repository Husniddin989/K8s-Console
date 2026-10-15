import { createContext, useContext } from 'react'
import type { Capability } from './permissions'
import type { CronJobItem, PodItem, ResourceKind, SecretItem, WorkloadRow } from '../types'

export interface ConsoleActions {
  can: (capability: Capability) => boolean
  /** Empty when allowed, otherwise why not (shown on disabled menu items). */
  blocked: (capability: Capability) => string
  restart: (kind: ResourceKind, row: { namespace: string; name: string }) => void
  scale: (kind: ResourceKind, row: WorkloadRow) => void
  setImage: (kind: ResourceKind, row: WorkloadRow) => void
  remove: (kind: ResourceKind, namespace: string, name: string) => void
  yaml: (kind: ResourceKind, namespace: string, name: string) => void
  triggerCronJob: (row: CronJobItem) => void
  suspendCronJob: (row: CronJobItem) => void
  revealSecret: (row: SecretItem) => void
  create: (templateId: string) => void
  shell: (pod: PodItem) => void
  debug: (pod: PodItem) => void
  notify: (tone: 'success' | 'error', text: string) => void
}

export const ActionsContext = createContext<ConsoleActions | null>(null)

export function useConsoleActions(): ConsoleActions {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error('useConsoleActions needs an ActionsProvider')
  return actions
}
