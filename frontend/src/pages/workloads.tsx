import { Pause, Play, PlayCircle } from 'lucide-react'
import { CreateButton, DataTable, PageHeader, StatusBadge, type Column } from '../components/ui'
import { useConsoleActions } from '../lib/actionsContext'
import { ageColumn, containersColumn, countLabel, deleteItem, emptyFor, imagesColumn, key, labelsColumn, menuColumn, nameColumn, namespaceColumn, rolloutItems, yamlItem, type ListProps } from '../lib/columns'
import { formatTime } from '../lib/format'
import { age, ageMs, humanDuration } from '../lib/kubectl'
import type { CronJobItem, DaemonSetItem, JobItem, StatefulSetItem } from '../types'

function readyBadge(ready: number, desired: number) {
  return <span className="ready-cell"><StatusBadge status={ready >= desired ? 'Ready' : 'Progressing'} /><span className="mono">{ready}/{desired}</span></span>
}

export function StatefulSetsPage({ rows, total, showNamespace }: ListProps<StatefulSetItem>) {
  const actions = useConsoleActions()
  const columns: Column<StatefulSetItem>[] = [
    ...(showNamespace ? [namespaceColumn<StatefulSetItem>()] : []),
    nameColumn<StatefulSetItem>(),
    { key: 'ready', header: 'Ready', value: (row) => row.ready / Math.max(row.desired, 1), render: (row) => readyBadge(row.ready, row.desired) },
    { key: 'upToDate', header: 'Up-to-date', kind: 'num', value: (row) => row.upToDate },
    ageColumn<StatefulSetItem>(),
    { key: 'service', header: 'Service', kind: 'mono', value: (row) => row.serviceName },
    containersColumn<StatefulSetItem>(),
    imagesColumn<StatefulSetItem>(),
    menuColumn<StatefulSetItem>('Actions for stateful set', (row) => [
      ...rolloutItems(actions, 'statefulsets', row, true),
      yamlItem(actions, () => actions.yaml('statefulsets', row.namespace, row.name)),
      deleteItem(actions, 'deleteResource', 'Delete stateful set', () => actions.remove('statefulsets', row.namespace, row.name)),
    ]),
  ]
  return <>
    <PageHeader title="StatefulSets" count={countLabel(rows.length, total)} description="Ordered workloads with stable names and storage, as in kubectl get statefulsets -o wide."><CreateButton template="statefulset" label="Create stateful set" /></PageHeader>
    <section className="panel"><DataTable label="StatefulSets" rows={rows} columns={columns} rowKey={key} initialSort={{ key: showNamespace ? 'namespace' : 'name', direction: 'asc' }} empty={emptyFor('stateful sets', total)} /></section>
  </>
}

export function DaemonSetsPage({ rows, total, showNamespace }: ListProps<DaemonSetItem>) {
  const actions = useConsoleActions()
  const columns: Column<DaemonSetItem>[] = [
    ...(showNamespace ? [namespaceColumn<DaemonSetItem>()] : []),
    nameColumn<DaemonSetItem>(),
    { key: 'desired', header: 'Desired', kind: 'num', value: (row) => row.desired },
    { key: 'current', header: 'Current', kind: 'num', value: (row) => row.current },
    { key: 'ready', header: 'Ready', value: (row) => row.ready / Math.max(row.desired, 1), render: (row) => readyBadge(row.ready, row.desired) },
    { key: 'upToDate', header: 'Up-to-date', kind: 'num', value: (row) => row.upToDate },
    { key: 'available', header: 'Available', kind: 'num', value: (row) => row.available },
    labelsColumn<DaemonSetItem>('Node selector', (row) => row.nodeSelector),
    ageColumn<DaemonSetItem>(),
    containersColumn<DaemonSetItem>(),
    imagesColumn<DaemonSetItem>(),
    menuColumn<DaemonSetItem>('Actions for daemon set', (row) => [
      ...rolloutItems(actions, 'daemonsets', row, false),
      yamlItem(actions, () => actions.yaml('daemonsets', row.namespace, row.name)),
      deleteItem(actions, 'deleteResource', 'Delete daemon set', () => actions.remove('daemonsets', row.namespace, row.name)),
    ]),
  ]
  return <>
    <PageHeader title="DaemonSets" count={countLabel(rows.length, total)} description="One pod per matching node, as in kubectl get daemonsets -o wide."><CreateButton template="daemonset" label="Create daemon set" /></PageHeader>
    <section className="panel"><DataTable label="DaemonSets" rows={rows} columns={columns} rowKey={key} initialSort={{ key: showNamespace ? 'namespace' : 'name', direction: 'asc' }} empty={emptyFor('daemon sets', total)} /></section>
  </>
}

/** kubectl's DURATION: run time so far, or start to completion. */
function jobDuration(job: JobItem, now = Date.now()): number | null {
  if (!job.startTime) return null
  const end = job.completionTime ? Date.parse(job.completionTime) : now
  return end - Date.parse(job.startTime)
}

export function JobsPage({ rows, total, showNamespace }: ListProps<JobItem>) {
  const actions = useConsoleActions()
  const columns: Column<JobItem>[] = [
    ...(showNamespace ? [namespaceColumn<JobItem>()] : []),
    nameColumn<JobItem>(),
    { key: 'status', header: 'Status', value: (row) => row.status, render: (row) => <StatusBadge status={row.status} /> },
    { key: 'completions', header: 'Completions', kind: 'mono', value: (row) => row.succeeded / Math.max(row.completions, 1), render: (row) => row.succeeded + '/' + row.completions },
    { key: 'duration', header: 'Duration', kind: 'mono', value: (row) => jobDuration(row) ?? -1, render: (row) => { const duration = jobDuration(row); return duration === null ? <span className="text-muted">—</span> : humanDuration(duration) } },
    ageColumn<JobItem>(),
    { key: 'failed', header: 'Failed pods', kind: 'num', value: (row) => row.failed, render: (row) => <span className={row.failed ? 'text-warning' : undefined}>{row.failed}</span> },
    { key: 'owner', header: 'Created by', kind: 'mono', value: (row) => row.owner || '', render: (row) => row.owner || <span className="text-muted">&lt;none&gt;</span> },
    containersColumn<JobItem>(),
    imagesColumn<JobItem>(),
    menuColumn<JobItem>('Actions for job', (row) => [
      yamlItem(actions, () => actions.yaml('jobs', row.namespace, row.name)),
      deleteItem(actions, 'deleteResource', 'Delete job', () => actions.remove('jobs', row.namespace, row.name)),
    ]),
  ]
  return <>
    <PageHeader title="Jobs" count={countLabel(rows.length, total)} description="Run-to-completion work, as in kubectl get jobs -o wide."><CreateButton template="job" label="Create job" /></PageHeader>
    <section className="panel"><DataTable label="Jobs" rows={rows} columns={columns} rowKey={key} initialSort={{ key: 'age', direction: 'asc' }} empty={emptyFor('jobs', total)} /></section>
  </>
}

export function CronJobsPage({ rows, total, showNamespace }: ListProps<CronJobItem>) {
  const actions = useConsoleActions()
  const columns: Column<CronJobItem>[] = [
    ...(showNamespace ? [namespaceColumn<CronJobItem>()] : []),
    nameColumn<CronJobItem>(),
    { key: 'schedule', header: 'Schedule', kind: 'mono', value: (row) => row.schedule },
    { key: 'timeZone', header: 'Time zone', kind: 'mono', value: (row) => row.timeZone },
    { key: 'suspend', header: 'Suspend', value: (row) => (row.suspend ? 1 : 0), render: (row) => row.suspend ? <span className="badge badge-pending"><span className="badge-dot" />True</span> : <span className="text-muted">False</span> },
    { key: 'active', header: 'Active', kind: 'num', value: (row) => row.active },
    { key: 'lastSchedule', header: 'Last schedule', kind: 'mono', value: (row) => ageMs(row.lastScheduleTime), render: (row) => row.lastScheduleTime ? <span title={formatTime(row.lastScheduleTime)}>{age(row.lastScheduleTime)} ago</span> : <span className="text-muted">&lt;none&gt;</span> },
    ageColumn<CronJobItem>(),
    containersColumn<CronJobItem>(),
    imagesColumn<CronJobItem>(),
    menuColumn<CronJobItem>('Actions for cron job', (row) => [
      { label: 'Run now', icon: <PlayCircle size={16} />, onSelect: () => actions.triggerCronJob(row), blocked: actions.blocked('cronJobs') || undefined },
      { label: row.suspend ? 'Resume schedule' : 'Suspend schedule', icon: row.suspend ? <Play size={16} /> : <Pause size={16} />, onSelect: () => actions.suspendCronJob(row), blocked: actions.blocked('cronJobs') || undefined },
      yamlItem(actions, () => actions.yaml('cronjobs', row.namespace, row.name)),
      deleteItem(actions, 'deleteResource', 'Delete cron job', () => actions.remove('cronjobs', row.namespace, row.name)),
    ]),
  ]
  return <>
    <PageHeader title="CronJobs" count={countLabel(rows.length, total)} description="Scheduled jobs, as in kubectl get cronjobs -o wide."><CreateButton template="cronjob" label="Create cron job" /></PageHeader>
    <section className="panel"><DataTable label="CronJobs" rows={rows} columns={columns} rowKey={key} initialSort={{ key: showNamespace ? 'namespace' : 'name', direction: 'asc' }} empty={emptyFor('cron jobs', total)} /></section>
  </>
}
