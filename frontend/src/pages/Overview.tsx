import { AlertTriangle, ArrowRight, Boxes, CheckCircle2, Container, Network, Server, Waypoints } from 'lucide-react'
import type { ReactNode } from 'react'
import { PageHeader, StatusBadge } from '../components/ui'
import { age, needsAttention, restartsText } from '../lib/kubectl'
import type { ClusterSummary, EventItem, PageId, PodItem } from '../types'

function StatCard({ icon, label, value, total, detail, tone, onClick }: { icon: ReactNode; label: string; value: number | string; total?: number; detail: string; tone?: 'good' | 'warn'; onClick: () => void }) {
  return <button className="stat-card" onClick={onClick}>
    <span className="stat-top"><span className="stat-icon">{icon}</span><span className="stat-label">{label}</span><ArrowRight size={16} className="stat-arrow" /></span>
    <span className="stat-value">{value}{total !== undefined && <span className="stat-total"> / {total}</span>}</span>
    <span className={'stat-detail' + (tone ? ' stat-' + tone : '')}>{detail}</span>
  </button>
}

export function Overview({ summary, pods, events, goTo }: { summary: ClusterSummary; pods: PodItem[]; events: EventItem[]; goTo: (page: PageId) => void }) {
  const running = summary.podCounts.Running || 0
  const pending = summary.podCounts.Pending || 0
  const succeeded = summary.podCounts.Succeeded || 0
  const failed = (summary.podCounts.Failed || 0) + (summary.podCounts.Unknown || 0)
  const attention = pods.filter(needsAttention)
  const warnings = events.filter((event) => event.type === 'Warning')
  const segments = [
    { label: 'Running', value: running, className: 'seg-good' },
    { label: 'Pending', value: pending, className: 'seg-pending' },
    { label: 'Succeeded', value: succeeded, className: 'seg-neutral' },
    { label: 'Failed / Unknown', value: failed, className: 'seg-bad' },
  ]

  return <>
    <PageHeader title="Cluster overview" description={summary.cluster + ' · Kubernetes ' + summary.kubernetesVersion + ' · health of the selected namespace scope'} />
    <section className="stat-grid" aria-label="Cluster summary">
      <StatCard icon={<Server size={18} />} label="Nodes" value={summary.readyNodeCount} total={summary.nodeCount} detail={summary.readyNodeCount === summary.nodeCount ? 'All ready' : summary.nodeCount - summary.readyNodeCount + ' not ready'} tone={summary.readyNodeCount === summary.nodeCount ? 'good' : 'warn'} onClick={() => goTo('nodes')} />
      <StatCard icon={<Container size={18} />} label="Pods" value={running} total={summary.podCount} detail={attention.length ? attention.length + ' need attention' : 'All healthy'} tone={attention.length ? 'warn' : 'good'} onClick={() => goTo('pods')} />
      <StatCard icon={<Boxes size={18} />} label="Deployments" value={summary.readyDeploymentCount} total={summary.deploymentCount} detail={summary.readyDeploymentCount === summary.deploymentCount ? 'All rolled out' : summary.deploymentCount - summary.readyDeploymentCount + ' progressing'} tone={summary.readyDeploymentCount === summary.deploymentCount ? 'good' : 'warn'} onClick={() => goTo('deployments')} />
      <StatCard icon={<Waypoints size={18} />} label="Services" value={summary.serviceCount} detail="In the selected scope" onClick={() => goTo('services')} />
      <StatCard icon={<Network size={18} />} label="Namespaces" value={summary.namespaceCount} detail="In the cluster" onClick={() => goTo('namespaces')} />
      <StatCard icon={<AlertTriangle size={18} />} label="Warnings" value={warnings.length} detail={warnings.length ? 'In recent events' : 'No recent warnings'} tone={warnings.length ? 'warn' : 'good'} onClick={() => goTo('events')} />
    </section>

    <section className="panel pod-mix">
      <div className="panel-header"><h2>Pod phases</h2><span className="text-muted">{summary.podCount} pods</span></div>
      <div className="phase-bar" role="img" aria-label={segments.map((segment) => segment.label + ' ' + segment.value).join(', ')}>
        {summary.podCount ? segments.filter((segment) => segment.value > 0).map((segment) => <span key={segment.label} className={segment.className} style={{ flexGrow: segment.value }} />) : <span className="seg-empty" />}
      </div>
      <div className="phase-legend">{segments.map((segment) => <span key={segment.label}><i className={segment.className} />{segment.label} <b>{segment.value}</b></span>)}</div>
    </section>

    <div className="overview-columns">
      <section className="panel">
        <div className="panel-header"><h2>Pods needing attention</h2><button className="link-button" onClick={() => goTo('pods')}>All pods <ArrowRight size={15} /></button></div>
        {attention.length ? <div className="table-scroll"><table className="data-table attention-table" aria-label="Pods needing attention">
          <thead><tr><th>Name</th><th>Status</th><th className="cell-mono">Ready</th><th className="cell-mono">Restarts</th></tr></thead>
          <tbody>{attention.slice(0, 8).map((pod) => <tr key={pod.namespace + '/' + pod.name}>
            <td><span className="resource-name">{pod.name}</span><span className="sub-text">{pod.namespace}</span></td>
            <td><StatusBadge status={pod.status} /></td>
            <td className="cell-mono">{pod.ready}/{pod.containers}</td>
            <td className="cell-mono">{restartsText(pod.restarts, pod.lastRestartAt)}</td>
          </tr>)}</tbody>
        </table></div> : <div className="calm-state"><CheckCircle2 size={20} /><div><strong>Every pod is running and ready</strong><span>No restarts or failing containers in this scope.</span></div></div>}
      </section>

      <section className="panel">
        <div className="panel-header"><h2>Recent warnings</h2><button className="link-button" onClick={() => goTo('events')}>All events <ArrowRight size={15} /></button></div>
        {warnings.length ? <ul className="event-list">{warnings.slice(0, 6).map((event) => <li key={event.namespace + '/' + event.name}>
          <div className="event-row"><strong>{event.reason}</strong><span className="mono text-muted">{age(event.time)} ago{event.count > 1 ? ' · ×' + event.count : ''}</span></div>
          <p>{event.message || '—'}</p>
          <span className="sub-text mono">{event.namespace} · {event.object}</span>
        </li>)}</ul> : <div className="calm-state"><CheckCircle2 size={20} /><div><strong>No warnings right now</strong><span>Cluster events look normal.</span></div></div>}
      </section>
    </div>
  </>
}
