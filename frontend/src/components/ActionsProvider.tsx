import { lazy, Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { AuthRequiredError, api } from '../api'
import { ActionsContext, type ConsoleActions, type DeletableKind } from '../lib/actionsContext'
import { blockedReason, can } from '../lib/permissions'
import type { AuthSession, DeploymentItem, PodItem, YamlKind } from '../types'
import { ConfirmDialog, DebugDialog, ImageDialog, ScaleDialog, YamlDialog } from './dialogs'
import type { TerminalTarget } from './Terminal'
import { Toasts, type Toast } from './Toasts'

// xterm is large; load it only when someone opens a shell or debug session.
const TerminalDialog = lazy(() => import('./Terminal').then((module) => ({ default: module.TerminalDialog })))

const kindLabels: Record<DeletableKind, string> = { pod: 'pod', deployment: 'deployment', service: 'service', namespace: 'namespace' }

/** Owns every action dialog, runs the API call, reports the outcome and refreshes the data. */
export function ActionsProvider({ session, namespace, onChanged, onSessionExpired, children }: {
  session: AuthSession
  namespace: string
  onChanged: () => void
  onSessionExpired: () => void
  children: ReactNode
}) {
  const [dialog, setDialog] = useState<ReactNode>(null)
  const [terminal, setTerminal] = useState<TerminalTarget | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const close = useCallback(() => setDialog(null), [])

  const notify = useCallback((tone: Toast['tone'], text: string) => {
    const id = nextId.current++
    setToasts((current) => current.concat({ id, tone, text }).slice(-4))
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === 'error' ? 9000 : 5000)
  }, [])

  /** Wraps an API call: session expiry signs out, success shows a toast and refreshes. */
  const perform = useCallback(async (operation: () => Promise<unknown>, success: string) => {
    try {
      await operation()
    } catch (error) {
      if (error instanceof AuthRequiredError) onSessionExpired()
      throw error
    }
    notify('success', success)
    onChanged()
  }, [notify, onChanged, onSessionExpired])

  const actions = useMemo<ConsoleActions>(() => ({
    can: (capability) => can(session, capability),
    blocked: (capability) => blockedReason(session, capability),
    notify,
    restart: (deployment: DeploymentItem) => setDialog(<ConfirmDialog
      title="Restart deployment"
      message={<>Roll out fresh pods for <strong>{deployment.namespace}/{deployment.name}</strong>, one batch at a time, like <code>kubectl rollout restart</code>.</>}
      confirmLabel="Restart"
      onConfirm={() => perform(() => api.restartDeployment(deployment.namespace, deployment.name), 'Restarting ' + deployment.namespace + '/' + deployment.name)}
      onClose={close} />),
    scale: (deployment) => setDialog(<ScaleDialog deployment={deployment} onClose={close}
      onSubmit={(replicas) => perform(() => api.scaleDeployment(deployment.namespace, deployment.name, replicas), 'Scaled ' + deployment.namespace + '/' + deployment.name + ' to ' + replicas + ' replica' + (replicas === 1 ? '' : 's'))} />),
    setImage: (deployment) => setDialog(<ImageDialog deployment={deployment} onClose={close}
      onSubmit={(container, image) => perform(() => api.setImage(deployment.namespace, deployment.name, container, image), 'Rolling out ' + image + ' to ' + deployment.namespace + '/' + deployment.name)} />),
    remove: (kind, resourceNamespace, name) => {
      const label = kindLabels[kind]
      const target = kind === 'namespace' ? name : resourceNamespace + '/' + name
      const run = kind === 'pod' ? () => api.deletePod(resourceNamespace, name)
        : kind === 'deployment' ? () => api.deleteDeployment(resourceNamespace, name)
          : kind === 'service' ? () => api.deleteService(resourceNamespace, name)
            : () => api.deleteNamespace(name)
      const message = kind === 'pod'
        ? <>Delete pod <strong>{target}</strong>? If a controller owns it, a replacement pod starts automatically.</>
        : kind === 'namespace'
          ? <>Delete namespace <strong>{name}</strong> and <strong>everything inside it</strong>? This cannot be undone.</>
          : <>Delete {label} <strong>{target}</strong>? This cannot be undone.</>
      setDialog(<ConfirmDialog title={'Delete ' + label} message={message} confirmLabel={'Delete ' + label} danger
        typeToConfirm={kind === 'namespace' || kind === 'deployment' ? name : undefined}
        onConfirm={() => perform(run, 'Deleted ' + label + ' ' + target)} onClose={close} />)
    },
    yaml: (kind: YamlKind, resourceNamespace, name) => {
      const editable = kind !== 'node' && can(session, 'apply')
      setDialog(<YamlDialog title={(editable ? 'Edit ' : 'View ') + kind + ' YAML'} subtitle={kind === 'namespace' || kind === 'node' ? name : resourceNamespace + '/' + name}
        load={() => api.yaml(kind, resourceNamespace, name)} namespace={resourceNamespace} editable={editable}
        onApply={async (yaml, dryRun) => {
          const result = await api.apply(yaml, dryRun)
          if (!dryRun && result.ok) { notify('success', 'Applied changes to ' + kind + ' ' + name); onChanged() }
          return result
        }} onClose={close} />)
    },
    create: (templateId) => setDialog(<YamlDialog title="Create resources" subtitle="Paste or edit YAML, validate it, then create" initialTemplate={templateId}
      namespace={namespace === 'all' ? 'default' : namespace} editable
      onApply={async (yaml, dryRun) => {
        const result = await api.apply(yaml, dryRun)
        if (!dryRun && result.ok) { notify('success', 'Applied ' + result.results.length + ' object' + (result.results.length === 1 ? '' : 's')); onChanged() }
        return result
      }} onClose={close} />),
    shell: (pod: PodItem) => setTerminal({ mode: 'exec', namespace: pod.namespace, pod: pod.name, container: pod.containerNames[0], containers: pod.containerNames }),
    debug: (pod: PodItem) => setDialog(<DebugDialog pod={pod} onClose={close} onSubmit={async (target, image) => {
      const { container } = await api.debugPod(pod.namespace, pod.name, target, image).catch((error: unknown) => {
        if (error instanceof AuthRequiredError) onSessionExpired()
        throw error
      })
      setTerminal({ mode: 'attach', namespace: pod.namespace, pod: pod.name, container })
    }} />),
  }), [session, namespace, notify, perform, close, onChanged, onSessionExpired])

  return <ActionsContext.Provider value={actions}>
    {children}
    {dialog}
    {terminal && <Suspense fallback={null}><TerminalDialog target={terminal} onClose={() => { setTerminal(null); onChanged() }} onSessionExpired={onSessionExpired} /></Suspense>}
    <Toasts toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
  </ActionsContext.Provider>
}
