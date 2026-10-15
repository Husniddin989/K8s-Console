import { CheckCircle2, CircleAlert, X } from 'lucide-react'

export interface Toast {
  id: number
  tone: 'success' | 'error'
  text: string
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return <div className="toasts" aria-live="polite">
    {toasts.map((toast) => <div key={toast.id} className={'toast toast-' + toast.tone} role={toast.tone === 'error' ? 'alert' : 'status'}>
      {toast.tone === 'success' ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
      <span>{toast.text}</span>
      <button className="icon-button icon-button-small" onClick={() => onDismiss(toast.id)} aria-label="Dismiss"><X size={15} /></button>
    </div>)}
  </div>
}
