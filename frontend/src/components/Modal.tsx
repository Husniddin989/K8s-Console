import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({ title, subtitle, onClose, children, footer, size = 'medium', dark = false, closeOnEscape = true }: {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'small' | 'medium' | 'large' | 'full'
  dark?: boolean
  /** Terminals need Escape for the shell (vim, less), so they close with the button only. */
  closeOnEscape?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const escapeRef = useRef(closeOnEscape)
  useEffect(() => {
    closeRef.current = onClose
    escapeRef.current = closeOnEscape
  }, [onClose, closeOnEscape])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select, button:not(.modal-close)')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && escapeRef.current) {
        event.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus?.()
    }
  }, [])

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && closeOnEscape) onClose() }}>
    <div className={'modal modal-' + size + (dark ? ' modal-dark' : '')} role="dialog" aria-modal="true" ref={dialogRef}>
      <header className="modal-header">
        <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </div>
  </div>
}
