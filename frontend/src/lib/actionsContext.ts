import { createContext, useContext } from 'react'
import type { Capability } from './permissions'
import type { DeploymentItem, PodItem, YamlKind } from '../types'

export type DeletableKind = 'pod' | 'deployment' | 'service' | 'namespace'

export interface ConsoleActions {
  can: (capability: Capability) => boolean
  /** Empty when allowed, otherwise why not (shown on disabled menu items). */
  blocked: (capability: Capability) => string
  restart: (deployment: DeploymentItem) => void
  scale: (deployment: DeploymentItem) => void
  setImage: (deployment: DeploymentItem) => void
  remove: (kind: DeletableKind, namespace: string, name: string) => void
  yaml: (kind: YamlKind, namespace: string, name: string) => void
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
