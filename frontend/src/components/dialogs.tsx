import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, Copy, LoaderCircle, Minus, Plus } from 'lucide-react'
import { templates } from '../lib/templates'
import type { ApplyResult, DeploymentItem, PodItem } from '../types'
import { Modal } from './Modal'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed'
}

/** Runs the dialog's submit, keeps it open with the error on failure. */
function useSubmit(onClose: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (operation: () => Promise<void | boolean>) => {
    setBusy(true)
    setError('')
    try {
      const keepOpen = await operation()
      if (keepOpen !== true) onClose()
    } catch (submitError) {
      setError(errorText(submitError))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function DialogError({ error }: { error: string }) {
  return error ? <div className="form-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div> : null
}

function Spinner({ busy, children }: { busy: boolean; children: ReactNode }) {
  return <>{busy && <LoaderCircle size={16} className="spin" />}{children}</>
}

export function ConfirmDialog({ title, message, confirmLabel, danger, typeToConfirm, onConfirm, onClose }: {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  /** The user must type this exact text first (used for deleting namespaces and deployments). */
  typeToConfirm?: string
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const { busy, error, run } = useSubmit(onClose)
  const [typed, setTyped] = useState('')
  const ready = !typeToConfirm || typed === typeToConfirm
  return <Modal title={title} onClose={onClose} size="small" footer={<>
    <button className="button" onClick={onClose}>Cancel</button>
    <button className={'button ' + (danger ? 'button-danger' : 'button-primary')} disabled={busy || !ready} onClick={() => void run(onConfirm)}><Spinner busy={busy}>{confirmLabel}</Spinner></button>
  </>}>
    <div className="dialog-text">{message}</div>
    {typeToConfirm && <label className="form-field"><span>Type <code>{typeToConfirm}</code> to confirm</span><input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} data-autofocus /></label>}
    <DialogError error={error} />
  </Modal>
}

export function ScaleDialog({ deployment, onSubmit, onClose }: { deployment: DeploymentItem; onSubmit: (replicas: number) => Promise<void>; onClose: () => void }) {
  const { busy, error, run } = useSubmit(onClose)
  const [replicas, setReplicas] = useState(deployment.desired)
  const valid = Number.isInteger(replicas) && replicas >= 0 && replicas <= 1000
  return <Modal title="Scale deployment" subtitle={deployment.namespace + ' / ' + deployment.name} onClose={onClose} size="small" footer={<>
    <button className="button" onClick={onClose}>Cancel</button>
    <button className="button button-primary" disabled={busy || !valid || replicas === deployment.desired} onClick={() => void run(() => onSubmit(replicas))}><Spinner busy={busy}>Scale to {valid ? replicas : '…'}</Spinner></button>
  </>}>
    <p className="dialog-text">Currently {deployment.ready} of {deployment.desired} replicas are ready.</p>
    <div className="stepper">
      <button className="button" onClick={() => setReplicas((current) => Math.max(0, current - 1))} aria-label="One fewer replica"><Minus size={16} /></button>
      <input type="number" min={0} max={1000} value={Number.isNaN(replicas) ? '' : replicas} onChange={(event) => setReplicas(event.target.valueAsNumber)} aria-label="Replicas" data-autofocus />
      <button className="button" onClick={() => setReplicas((current) => Math.min(1000, (Number.isNaN(current) ? 0 : current) + 1))} aria-label="One more replica"><Plus size={16} /></button>
    </div>
    {replicas === 0 && <p className="form-hint text-warning">Scaling to 0 stops every pod of this deployment.</p>}
    <DialogError error={error} />
  </Modal>
}

export function ImageDialog({ deployment, onSubmit, onClose }: { deployment: DeploymentItem; onSubmit: (container: string, image: string) => Promise<void>; onClose: () => void }) {
  const { busy, error, run } = useSubmit(onClose)
  const [container, setContainer] = useState(deployment.containers[0] || '')
  const currentImage = deployment.images[deployment.containers.indexOf(container)] || ''
  const [image, setImage] = useState(currentImage)
  const changed = image.trim() && image.trim() !== currentImage
  return <Modal title="Update image" subtitle={deployment.namespace + ' / ' + deployment.name} onClose={onClose} size="small" footer={<>
    <button className="button" onClick={onClose}>Cancel</button>
    <button className="button button-primary" disabled={busy || !changed} onClick={() => void run(() => onSubmit(container, image.trim()))}><Spinner busy={busy}>Update and roll out</Spinner></button>
  </>}>
    {deployment.containers.length > 1 && <label className="form-field"><span>Container</span><select value={container} onChange={(event) => { setContainer(event.target.value); setImage(deployment.images[deployment.containers.indexOf(event.target.value)] || '') }}>{deployment.containers.map((name) => <option key={name}>{name}</option>)}</select></label>}
    <label className="form-field"><span>Current image</span><input value={currentImage} readOnly className="mono" /></label>
    <label className="form-field"><span>New image</span><input value={image} onChange={(event) => setImage(event.target.value)} className="mono" spellCheck={false} placeholder="registry/name:tag" data-autofocus /></label>
    <p className="form-hint">The deployment rolls out new pods with this image, like kubectl set image.</p>
    <DialogError error={error} />
  </Modal>
}

export function DebugDialog({ pod, onSubmit, onClose }: { pod: PodItem; onSubmit: (target: string, image: string) => Promise<void>; onClose: () => void }) {
  const { busy, error, run } = useSubmit(onClose)
  const [target, setTarget] = useState(pod.containerNames[0] || '')
  const [image, setImage] = useState('')
  return <Modal title="Debug pod" subtitle={pod.namespace + ' / ' + pod.name} onClose={onClose} size="small" footer={<>
    <button className="button" onClick={onClose}>Cancel</button>
    <button className="button button-primary" disabled={busy} onClick={() => void run(() => onSubmit(target, image.trim()))}><Spinner busy={busy}>Start debug container</Spinner></button>
  </>}>
    <p className="dialog-text">Adds an ephemeral container to the running pod and opens a terminal in it, like <code>kubectl debug -it --target</code>. It shares the target container's processes, so tools like <code>ps</code> and <code>wget</code> work even when the app image has no shell.</p>
    <label className="form-field"><span>Target container</span><select value={target} onChange={(event) => setTarget(event.target.value)}>{pod.containerNames.map((name) => <option key={name}>{name}</option>)}</select></label>
    <label className="form-field"><span>Debug image</span><input value={image} onChange={(event) => setImage(event.target.value)} className="mono" placeholder="busybox:1.36 (console default)" spellCheck={false} /></label>
    <p className="form-hint">Ephemeral containers cannot be removed; they stay listed on the pod until it is replaced.</p>
    <DialogError error={error} />
  </Modal>
}

function insertTab(event: KeyboardEvent<HTMLTextAreaElement>, setText: (value: string) => void) {
  if (event.key !== 'Tab') return
  event.preventDefault()
  const area = event.currentTarget
  const { selectionStart, selectionEnd, value } = area
  setText(value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd))
  requestAnimationFrame(() => { area.selectionStart = area.selectionEnd = selectionStart + 2 })
}

export function YamlDialog({ title, subtitle, load, initialTemplate, namespace, editable, onApply, onClose }: {
  title: string
  subtitle?: string
  /** Loads the live object; omitted when creating from a template. */
  load?: () => Promise<string>
  initialTemplate?: string
  namespace: string
  editable: boolean
  onApply: (yaml: string, dryRun: boolean) => Promise<ApplyResult>
  onClose: () => void
}) {
  const [text, setText] = useState(load ? '' : templates.find((item) => item.id === initialTemplate)?.yaml(namespace) ?? templates[0].yaml(namespace))
  const [original, setOriginal] = useState(text)
  const [loading, setLoading] = useState(Boolean(load))
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [busy, setBusy] = useState<'dry' | 'apply' | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!load) return
    let cancelled = false
    load().then((yaml) => { if (!cancelled) { setText(yaml); setOriginal(yaml) } })
      .catch((loadError: unknown) => { if (!cancelled) setError(errorText(loadError)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [load])

  const submit = async (dryRun: boolean) => {
    setBusy(dryRun ? 'dry' : 'apply')
    setError('')
    setResult(null)
    try {
      const outcome = await onApply(text, dryRun)
      setResult(outcome)
      if (!dryRun && outcome.ok) setOriginal(text)
    } catch (applyError) {
      setError(errorText(applyError))
    } finally {
      setBusy(null)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Copying is blocked by the browser')
    }
  }

  return <Modal title={title} subtitle={subtitle} onClose={onClose} size="large" footer={<>
    {!load && <label className="template-select"><span>Template</span><select onChange={(event) => { const template = templates.find((item) => item.id === event.target.value); if (template) { setText(template.yaml(namespace)); setResult(null) } }} defaultValue={initialTemplate}>{templates.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
    <button className="button" onClick={() => void copy()} disabled={!text}><Copy size={15} />{copied ? 'Copied' : 'Copy'}</button>
    <span className="toolbar-spacer" />
    <button className="button" onClick={onClose}>Close</button>
    {editable && <>
      <button className="button" disabled={Boolean(busy) || loading || !text.trim()} onClick={() => void submit(true)}><Spinner busy={busy === 'dry'}>Validate (dry run)</Spinner></button>
      <button className="button button-primary" disabled={Boolean(busy) || loading || !text.trim() || (Boolean(load) && text === original)} onClick={() => void submit(false)}><Spinner busy={busy === 'apply'}>{load ? 'Apply changes' : 'Create'}</Spinner></button>
    </>}
  </>}>
    {loading ? <div className="loading-block"><LoaderCircle size={18} className="spin" /> Loading YAML</div>
      : <textarea className="yaml-editor" value={text} onChange={(event) => { setText(event.target.value); setResult(null) }} onKeyDown={(event) => insertTab(event, setText)} readOnly={!editable} spellCheck={false} aria-label="YAML" data-autofocus />}
    {editable && <p className="form-hint">Applied with server-side apply (field manager <code>k8s-ui</code>), like <code>kubectl apply --server-side</code>. Several objects can be separated with <code>---</code>.</p>}
    <DialogError error={error} />
    {result && <ul className="apply-results">{result.results.map((item) => <li key={item.kind + item.namespace + item.name} className={item.operation === 'failed' ? 'is-failed' : ''}>
      {item.operation === 'failed' ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
      <span className="mono">{item.kind.toLowerCase()}/{item.name}</span>{item.namespace && <span className="text-muted">in {item.namespace}</span>}
      <strong>{result.dryRun && item.operation !== 'failed' ? 'valid (' + item.operation + ')' : item.operation}</strong>
      {item.error && <span className="apply-error">{item.error}</span>}
    </li>)}</ul>}
  </Modal>
}
