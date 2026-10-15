import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'

export interface MenuItem {
  label: string
  icon: ReactNode
  onSelect: () => void
  danger?: boolean
  /** When set, the item is shown disabled with this explanation. */
  blocked?: string
  separatorBefore?: boolean
}

/** A "⋯" button with a popup menu rendered in a portal, so table scrolling never clips it. */
export function RowMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !menuRef.current) return
    const button = buttonRef.current.getBoundingClientRect()
    const menu = menuRef.current.getBoundingClientRect()
    const below = button.bottom + 6 + menu.height <= window.innerHeight
    setPosition({
      top: below ? button.bottom + 6 : Math.max(8, button.top - 6 - menu.height),
      left: Math.max(8, Math.min(button.right - menu.width, window.innerWidth - menu.width - 8)),
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return
      if (event.type === 'mousedown' && (menuRef.current?.contains(event.target as Node) || buttonRef.current?.contains(event.target as Node))) return
      setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open, position])

  return <>
    <button ref={buttonRef} className={'icon-button row-menu-button' + (open ? ' is-open' : '')} onClick={() => setOpen((current) => !current)} aria-label={label} aria-haspopup="menu" aria-expanded={open}><MoreHorizontal size={18} /></button>
    {open && createPortal(<div ref={menuRef} className="row-menu" role="menu" style={{ top: position.top, left: position.left }}>
      {items.map((item) => <div key={item.label}>
        {item.separatorBefore && <hr />}
        <button role="menuitem" className={'row-menu-item' + (item.danger ? ' is-danger' : '')} disabled={Boolean(item.blocked)} title={item.blocked || undefined} onClick={() => { setOpen(false); item.onSelect() }}>
          {item.icon}<span>{item.label}</span>{item.blocked && <small>{item.blocked}</small>}
        </button>
      </div>)}
    </div>, document.body)}
  </>
}
