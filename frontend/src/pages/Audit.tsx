import { Fragment, useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { api, AuthRequiredError } from '../api'
import { EmptyState, ErrorState, LoadingBlock, PageHeader, StatusBadge } from '../components/ui'
import { formatTime } from '../lib/format'
import { age } from '../lib/kubectl'
import { actionLabel } from '../lib/auditLabels'
import type { AuditEntry } from '../types'

const pageSize = 100

function summary(entry: AuditEntry): string {
  const details = entry.details as { before?: Record<string, unknown>; after?: Record<string, unknown>; operation?: string; passwordReset?: boolean } | null
  if (!details) return ''
  if (entry.action === 'deployment.scale') return details.before?.replicas + ' → ' + details.after?.replicas + ' replicas'
  if (entry.action === 'deployment.image') return String(details.before?.image) + ' → ' + String(details.after?.image)
  if (entry.action === 'resource.apply') return details.operation || ''
  if (entry.action === 'user.update') {
    const parts = []
    if (details.before?.role !== details.after?.role) parts.push(details.before?.role + ' → ' + details.after?.role)
    if (details.before?.disabled !== details.after?.disabled) parts.push(details.after?.disabled ? 'disabled' : 'enabled')
    if (details.passwordReset) parts.push('password reset')
    return parts.join(', ')
  }
  if (entry.action === 'user.create') return 'role ' + String(details.after?.role)
  if (entry.action === 'pod.shell' || entry.action === 'pod.attach' || entry.action === 'pod.debug') return 'container ' + String((details as { container?: string }).container ?? '')
  return ''
}

export function AuditPage({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [actions, setActions] = useState<string[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [action, setAction] = useState('')
  const [result, setResult] = useState('')
  const [user, setUser] = useState('')

  const load = useCallback(async (before?: number) => {
    setLoading(true)
    try {
      const page = await api.audit({ search, action, result, user, limit: pageSize, before })
      setEntries((current) => before && current ? current.concat(page.entries) : page.entries)
      setActions(page.actions)
      setHasMore(page.entries.length === pageSize)
      setError('')
    } catch (loadError) {
      if (loadError instanceof AuthRequiredError) onSessionExpired()
      setError(loadError instanceof Error ? loadError.message : 'Could not load the audit log')
    } finally {
      setLoading(false)
    }
  }, [search, action, result, user, onSessionExpired])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), search || user ? 300 : 0)
    return () => window.clearTimeout(timer)
  }, [load, search, user])

  return <>
    <PageHeader title="Audit log" count={entries ? String(entries.length) + (hasMore ? '+' : '') : undefined} description="Who did what, when, to which resource, and whether it worked. Newest first.">
      <button className="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />Refresh</button>
    </PageHeader>
    <section className="panel filter-bar">
      <label className="input-with-icon filter-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search user, resource, error, details…" aria-label="Search the audit log" /></label>
      <label className="field-inline"><span>Action</span><select value={action} onChange={(event) => setAction(event.target.value)}><option value="">All actions</option>{actions.map((item) => <option key={item} value={item}>{actionLabel(item)}</option>)}</select></label>
      <label className="field-inline"><span>Result</span><select value={result} onChange={(event) => setResult(event.target.value)}><option value="">Any</option><option value="success">Success</option><option value="failure">Failure</option></select></label>
      <label className="field-inline"><span>User</span><input value={user} onChange={(event) => setUser(event.target.value)} placeholder="any" /></label>
    </section>
    {error && !entries ? <ErrorState message={error} retrying={loading} onRetry={() => void load()} />
      : !entries ? <LoadingBlock label="Loading audit log" />
        : <section className="panel"><div className="table-scroll"><table className="data-table" aria-label="Audit log">
          <thead><tr><th /><th>Time</th><th>User</th><th>Action</th><th>Resource</th><th>Result</th><th>Details</th></tr></thead>
          <tbody>{entries.map((entry) => <Fragment key={entry.id}>
            <tr className={expanded === entry.id ? 'is-expanded' : undefined}>
              <td className="cell-action"><button className="icon-button icon-button-small" onClick={() => setExpanded((current) => current === entry.id ? null : entry.id)} aria-label={(expanded === entry.id ? 'Hide' : 'Show') + ' details'} aria-expanded={expanded === entry.id}>{expanded === entry.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></td>
              <td className="cell-mono" title={formatTime(entry.time)}>{age(entry.time)} ago</td>
              <td><span className="resource-name">{entry.username}</span><span className="sub-text">{entry.role}</span></td>
              <td>{actionLabel(entry.action)}</td>
              <td className="cell-mono">{entry.kind ? entry.kind.toLowerCase() + '/' : ''}{entry.name || '—'}{entry.namespace && <span className="sub-text">{entry.namespace}</span>}</td>
              <td><StatusBadge status={entry.result === 'success' ? 'Succeeded' : 'Failed'} /></td>
              <td className="cell-wrap">{entry.error ? <span className="text-danger">{entry.error}</span> : summary(entry) || <span className="text-muted">—</span>}</td>
            </tr>
            {expanded === entry.id && <tr className="audit-details"><td /><td colSpan={6}>
              <dl>
                <div><dt>Time</dt><dd>{formatTime(entry.time)} <span className="text-muted mono">({entry.time})</span></dd></div>
                <div><dt>Client IP</dt><dd className="mono">{entry.ip || '—'}</dd></div>
                <div><dt>Action</dt><dd className="mono">{entry.action}</dd></div>
              </dl>
              {entry.details && <pre className="json-view">{JSON.stringify(entry.details, null, 2)}</pre>}
            </td></tr>}
          </Fragment>)}</tbody>
        </table>{!entries.length && <EmptyState title="No matching audit records" detail="Actions, sign-ins and user changes appear here." />}</div>
          {hasMore && <div className="load-more"><button className="button" disabled={loading} onClick={() => void load(entries[entries.length - 1]?.id)}>Load older records</button></div>}
        </section>}
  </>
}
