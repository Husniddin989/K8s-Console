import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Inbox, LoaderCircle, Plus, RefreshCw, ServerCrash } from 'lucide-react'
import { useConsoleActions } from '../lib/actionsContext'
import { statusTone } from '../lib/format'
import { sortRows, type SortDirection, type SortValue } from '../lib/sort'

export function StatusBadge({ status }: { status: string }) {
  return <span className={'badge badge-' + statusTone(status)}><span className="badge-dot" />{status}</span>
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><Inbox size={22} /><strong>{title}</strong><span>{detail}</span></div>
}

export function LoadingBlock({ label = 'Loading cluster data' }: { label?: string }) {
  return <div className="loading-block" role="status"><LoaderCircle size={18} className="spin" /> {label}</div>
}

export function ErrorState({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return <section className="panel error-state" role="alert">
    <span className="error-state-icon"><ServerCrash size={22} /></span>
    <strong>Cluster data is unavailable</strong>
    <span>{message}</span>
    <button className="button" onClick={onRetry} disabled={retrying}><RefreshCw size={16} className={retrying ? 'spin' : ''} />{retrying ? 'Retrying…' : 'Try again'}</button>
  </section>
}

export interface Column<T> {
  key: string
  header: string
  /** Value used for sorting; also rendered when `render` is not given. */
  value: (row: T) => SortValue
  render?: (row: T) => ReactNode
  /** `mono` for IPs, ports and ages; `wrap` for long free text; `num` for right-aligned counts. */
  kind?: 'mono' | 'wrap' | 'num' | 'action' | 'labels'
  sortable?: boolean
}

export function DataTable<T>({ rows, columns, rowKey, initialSort, empty, label }: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  initialSort?: { key: string; direction: SortDirection }
  empty: ReactNode
  label: string
}) {
  const [sort, setSort] = useState(initialSort ?? { key: columns[0].key, direction: 'asc' as SortDirection })
  const sorted = useMemo(() => {
    const column = columns.find((item) => item.key === sort.key)
    return column ? sortRows(rows, column.value, sort.direction) : rows
  }, [rows, columns, sort])

  const toggle = (key: string) => setSort((current) => current.key === key
    ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: 'asc' })

  return <div className="table-scroll">
    <table className="data-table" aria-label={label}>
      <thead><tr>{columns.map((column) => {
        const active = sort.key === column.key
        const sortable = column.sortable !== false && column.kind !== 'action'
        return <th key={column.key} className={column.kind ? 'cell-' + column.kind : undefined} aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
          {sortable
            ? <button className={'sort-button' + (active ? ' is-active' : '')} onClick={() => toggle(column.key)}>{column.header}{active ? (sort.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />) : <ArrowUpDown size={13} className="sort-idle" />}</button>
            : <span className="sr-only-label">{column.header}</span>}
        </th>
      })}</tr></thead>
      <tbody>{sorted.map((row) => <tr key={rowKey(row)}>{columns.map((column) => <td key={column.key} className={column.kind ? 'cell-' + column.kind : undefined}>{column.render ? column.render(row) : column.value(row)}</td>)}</tr>)}</tbody>
    </table>
    {!rows.length && empty}
  </div>
}

export function PageHeader({ title, description, count, children }: { title: string; description: string; count?: string; children?: ReactNode }) {
  return <div className="page-header">
    <div><h1>{title}{count !== undefined && <span className="page-count">{count}</span>}</h1><p>{description}</p></div>
    {children && <div className="page-header-actions">{children}</div>}
  </div>
}

/** "Create …" opens the YAML editor with a template; admins only. */
export function CreateButton({ template, label }: { template: string; label: string }) {
  const actions = useConsoleActions()
  if (!actions.can('apply')) return null
  return <button className="button button-primary" onClick={() => actions.create(template)}><Plus size={16} />{label}</button>
}
