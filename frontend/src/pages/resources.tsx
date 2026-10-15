import { Bug, FileCode2, ImageUp, Plus, RotateCcw, Scaling, SquareTerminal, TerminalSquare, Trash2 } from 'lucide-react'
import { RowMenu, type MenuItem } from '../components/RowMenu'
import { DataTable, EmptyState, PageHeader, StatusBadge, type Column } from '../components/ui'
import { useConsoleActions, type ConsoleActions } from '../lib/actionsContext'
import { age, ageMs, restartsText } from '../lib/kubectl'
import type { DeploymentItem, EventItem, NamespaceItem, NodeItem, PodItem, ServiceItem } from '../types'
import { countLabel, formatTime } from '../lib/format'

const key = (row: { namespace: string; name: string }) => row.namespace + '/' + row.name

function namespaceColumn<T extends { namespace: string }>(): Column<T> {
  return { key: 'namespace', header: 'Namespace', value: (row) => row.namespace, render: (row) => <span className="chip">{row.namespace}</span> }
}

function nameColumn<T extends { name: string }>(): Column<T> {
  return { key: 'name', header: 'Name', value: (row) => row.name, render: (row) => <span className="resource-name">{row.name}</span> }
}

function ageColumn<T extends { createdAt: string | null }>(): Column<T> {
  return { key: 'age', header: 'Age', kind: 'mono', value: (row) => ageMs(row.createdAt), render: (row) => <span title={row.createdAt ? formatTime(row.createdAt) : undefined}>{age(row.createdAt)}</span> }
}

/** Renders `a=b,c=d` selectors as wrapping chips so long label sets stay readable. */
function labelsColumn<T>(header: string, value: (row: T) => string): Column<T> {
  return {
    key: header.toLowerCase(),
    header,
    kind: 'labels',
    value,
    render: (row) => value(row) === '<none>' ? <span className="text-muted">&lt;none&gt;</span> : <span className="label-list">{value(row).split(',').map((label) => <span className="label-chip" key={label}>{label}</span>)}</span>,
  }
}

function menuColumn<T extends { name: string }>(label: string, items: (row: T) => MenuItem[]): Column<T> {
  return { key: 'menu', header: 'Actions', kind: 'action', value: () => '', render: (row) => <RowMenu label={label + ' ' + row.name} items={items(row)} /> }
}

function yamlItem(actions: ConsoleActions, open: () => void): MenuItem {
  return { label: actions.can('apply') ? 'View / edit YAML' : 'View YAML', icon: <FileCode2 size={16} />, onSelect: open }
}

function deleteItem(actions: ConsoleActions, capability: 'deletePod' | 'deleteResource', label: string, run: () => void): MenuItem {
  return { label, icon: <Trash2 size={16} />, onSelect: run, danger: true, blocked: actions.blocked(capability) || undefined, separatorBefore: true }
}

function CreateButton({ template, label }: { template: string; label: string }) {
  const actions = useConsoleActions()
  if (!actions.can('apply')) return null
  return <button className="button button-primary" onClick={() => actions.create(template)}><Plus size={16} />{label}</button>
}

function emptyFor(kind: string, total: number) {
  return total
    ? <EmptyState title={'No matching ' + kind} detail="Clear or change the search to see more." />
    : <EmptyState title={'No ' + kind + ' in this scope'} detail="Choose another namespace from the selector at the top." />
}

interface ListProps<T> {
  rows: T[]
  total: number
  showNamespace: boolean
}

export function PodsPage({ rows, total, showNamespace, onOpenLogs }: ListProps<PodItem> & { onOpenLogs: (pod: PodItem) => void }) {
  const actions = useConsoleActions()
  const columns: Column<PodItem>[] = [
    ...(showNamespace ? [namespaceColumn<PodItem>()] : []),
    nameColumn<PodItem>(),
    { key: 'ready', header: 'Ready', kind: 'mono', value: (pod) => pod.ready / Math.max(pod.containers, 1), render: (pod) => <span className={pod.ready < pod.containers ? 'text-warning' : undefined}>{pod.ready}/{pod.containers}</span> },
    { key: 'status', header: 'Status', value: (pod) => pod.status, render: (pod) => <StatusBadge status={pod.status} /> },
    { key: 'restarts', header: 'Restarts', kind: 'mono', value: (pod) => pod.restarts, render: (pod) => <span className={pod.restarts ? 'text-warning' : undefined}>{restartsText(pod.restarts, pod.lastRestartAt)}</span> },
    ageColumn<PodItem>(),
    { key: 'ip', header: 'IP', kind: 'mono', value: (pod) => pod.ip },
    { key: 'node', header: 'Node', value: (pod) => pod.node },
    { key: 'logs', header: 'Logs', kind: 'action', value: () => '', render: (pod) => <button className="row-action" onClick={() => onOpenLogs(pod)} aria-label={'Open logs for ' + pod.name}><TerminalSquare size={15} /> Logs</button> },
    menuColumn<PodItem>('Actions for pod', (pod) => [
      { label: 'Logs', icon: <TerminalSquare size={16} />, onSelect: () => onOpenLogs(pod) },
      { label: 'Shell', icon: <SquareTerminal size={16} />, onSelect: () => actions.shell(pod), blocked: actions.blocked('shell') || (pod.status !== 'Running' ? 'Pod is not running' : undefined) },
      { label: 'Debug', icon: <Bug size={16} />, onSelect: () => actions.debug(pod), blocked: actions.blocked('debug') || (pod.status !== 'Running' ? 'Pod is not running' : undefined) },
      yamlItem(actions, () => actions.yaml('pod', pod.namespace, pod.name)),
      deleteItem(actions, 'deletePod', 'Delete pod', () => actions.remove('pod', pod.namespace, pod.name)),
    ]),
  ]
  return <>
    <PageHeader title="Pods" count={countLabel(rows.length, total)} description="Every pod with the same columns as kubectl get pods -o wide."><CreateButton template="deployment" label="Create" /></PageHeader>
    <section className="panel"><DataTable label="Pods" rows={rows} columns={columns} rowKey={key} initialSort={{ key: showNamespace ? 'namespace' : 'name', direction: 'asc' }} empty={emptyFor('pods', total)} /></section>
  </>
}

export function DeploymentsPage({ rows, total, showNamespace }: ListProps<DeploymentItem>) {
  const actions = useConsoleActions()
  const columns: Column<DeploymentItem>[] = [
    ...(showNamespace ? [namespaceColumn<DeploymentItem>()] : []),
    nameColumn<DeploymentItem>(),
    { key: 'ready', header: 'Ready', value: (row) => row.ready / Math.max(row.desired, 1), render: (row) => <span className="ready-cell"><StatusBadge status={row.ready >= row.desired ? 'Ready' : 'Progressing'} /><span className="mono">{row.ready}/{row.desired}</span></span> },
    { key: 'upToDate', header: 'Up-to-date', kind: 'num', value: (row) => row.upToDate },
    { key: 'available', header: 'Available', kind: 'num', value: (row) => row.available },
    ageColumn<DeploymentItem>(),
    { key: 'containers', header: 'Containers', value: (row) => row.containers.join(','), render: (row) => row.containers.join(', ') },
    { key: 'images', header: 'Images', kind: 'mono', value: (row) => row.images.join(','), render: (row) => <span className="stack">{row.images.map((image) => <span key={image}>{image}</span>)}</span> },
    labelsColumn<DeploymentItem>('Selector', (row) => row.selector),
    menuColumn<DeploymentItem>('Actions for deployment', (row) => [
      { label: 'Restart', icon: <RotateCcw size={16} />, onSelect: () => actions.restart(row), blocked: actions.blocked('restart') || undefined },
      { label: 'Scale', icon: <Scaling size={16} />, onSelect: () => actions.scale(row), blocked: actions.blocked('scale') || undefined },
      { label: 'Update image', icon: <ImageUp size={16} />, onSelect: () => actions.setImage(row), blocked: actions.blocked('setImage') || undefined },
      yamlItem(actions, () => actions.yaml('deployment', row.namespace, row.name)),
      deleteItem(actions, 'deleteResource', 'Delete deployment', () => actions.remove('deployment', row.namespace, row.name)),
    ]),
  ]
  return <>
    <PageHeader title="Deployments" count={countLabel(rows.length, total)} description="Rollout state for every deployment, as in kubectl get deployments -o wide."><CreateButton template="deployment" label="Create deployment" /></PageHeader>
    <section className="panel"><DataTable label="Deployments" rows={rows} columns={columns} rowKey={key} initialSort={{ key: showNamespace ? 'namespace' : 'name', direction: 'asc' }} empty={emptyFor('deployments', total)} /></section>
  </>
}

export function ServicesPage({ rows, total, showNamespace }: ListProps<ServiceItem>) {
  const actions = useConsoleActions()
  const columns: Column<ServiceItem>[] = [
    ...(showNamespace ? [namespaceColumn<ServiceItem>()] : []),
    nameColumn<ServiceItem>(),
    { key: 'type', header: 'Type', value: (row) => row.type, render: (row) => <span className={'type-pill type-' + row.type.toLowerCase()}>{row.type}</span> },
    { key: 'clusterIp', header: 'Cluster-IP', kind: 'mono', value: (row) => row.clusterIp },
    { key: 'externalIp', header: 'External-IP', kind: 'mono', value: (row) => row.externalIp, render: (row) => <span className={row.externalIp.startsWith('<') ? 'text-muted' : undefined}>{row.externalIp}</span> },
    { key: 'ports', header: 'Port(s)', kind: 'mono', value: (row) => row.ports },
    ageColumn<ServiceItem>(),
    labelsColumn<ServiceItem>('Selector', (row) => row.selector),
    menuColumn<ServiceItem>('Actions for service', (row) => [
      yamlItem(actions, () => actions.yaml('service', row.namespace, row.name)),
      deleteItem(actions, 'deleteResource', 'Delete service', () => actions.remove('service', row.namespace, row.name)),
    ]),
  ]
  return <>
    <PageHeader title="Services" count={countLabel(rows.length, total)} description="Service addresses and ports, as in kubectl get services -o wide."><CreateButton template="service" label="Create service" /></PageHeader>
    <section className="panel"><DataTable label="Services" rows={rows} columns={columns} rowKey={key} initialSort={{ key: showNamespace ? 'namespace' : 'name', direction: 'asc' }} empty={emptyFor('services', total)} /></section>
  </>
}

export function NodesPage({ rows, total }: Omit<ListProps<NodeItem>, 'showNamespace'>) {
  const actions = useConsoleActions()
  const columns: Column<NodeItem>[] = [
    nameColumn<NodeItem>(),
    { key: 'status', header: 'Status', value: (row) => row.status, render: (row) => <StatusBadge status={row.status} /> },
    { key: 'roles', header: 'Roles', value: (row) => row.roles.join(','), render: (row) => row.roles.join(', ') },
    ageColumn<NodeItem>(),
    { key: 'version', header: 'Version', kind: 'mono', value: (row) => row.kubeletVersion },
    { key: 'internalIp', header: 'Internal-IP', kind: 'mono', value: (row) => row.internalIp },
    { key: 'externalIp', header: 'External-IP', kind: 'mono', value: (row) => row.externalIp },
    { key: 'osImage', header: 'OS image', value: (row) => row.osImage },
    { key: 'kernel', header: 'Kernel', kind: 'mono', value: (row) => row.kernelVersion },
    { key: 'runtime', header: 'Container runtime', kind: 'mono', value: (row) => row.containerRuntime },
    { key: 'capacity', header: 'CPU / Memory / Pods', kind: 'mono', sortable: false, value: (row) => row.cpu, render: (row) => row.cpu + ' / ' + row.memory + ' / ' + row.pods },
    menuColumn<NodeItem>('Actions for node', (row) => [{ label: 'View YAML', icon: <FileCode2 size={16} />, onSelect: () => actions.yaml('node', '', row.name) }]),
  ]
  return <>
    <PageHeader title="Nodes" count={countLabel(rows.length, total)} description="Readiness, versions and capacity, as in kubectl get nodes -o wide." />
    <section className="panel"><DataTable label="Nodes" rows={rows} columns={columns} rowKey={(row) => row.name} empty={total ? emptyFor('nodes', total) : <EmptyState title="No nodes found" detail="Check the cluster connection and read permissions." />} /></section>
  </>
}

export function EventsPage({ rows, total, showNamespace }: ListProps<EventItem>) {
  const columns: Column<EventItem>[] = [
    ...(showNamespace ? [namespaceColumn<EventItem>()] : []),
    { key: 'time', header: 'Last seen', kind: 'mono', value: (row) => ageMs(row.time), render: (row) => <span title={formatTime(row.time)}>{age(row.time)}</span> },
    { key: 'type', header: 'Type', value: (row) => row.type, render: (row) => <StatusBadge status={row.type} /> },
    { key: 'reason', header: 'Reason', value: (row) => row.reason, render: (row) => <strong>{row.reason}</strong> },
    { key: 'object', header: 'Object', kind: 'mono', value: (row) => row.object },
    { key: 'count', header: 'Count', kind: 'num', value: (row) => row.count },
    { key: 'message', header: 'Message', kind: 'wrap', value: (row) => row.message, render: (row) => row.message || '—' },
  ]
  return <>
    <PageHeader title="Events" count={countLabel(rows.length, total)} description="The latest 100 events, newest first, as in kubectl get events." />
    <section className="panel"><DataTable label="Events" rows={rows} columns={columns} rowKey={(row) => row.namespace + '/' + row.name} initialSort={{ key: 'time', direction: 'asc' }} empty={total ? emptyFor('events', total) : <EmptyState title="No recent events" detail="New cluster events will appear here." />} /></section>
  </>
}

export function NamespacesPage({ rows, total, pods, onOpen }: { rows: NamespaceItem[]; total: number; pods: PodItem[] | null; onOpen: (namespace: string) => void }) {
  const actions = useConsoleActions()
  const podCount = (name: string) => pods?.filter((pod) => pod.namespace === name).length
  const columns: Column<NamespaceItem>[] = [
    { key: 'name', header: 'Name', value: (row) => row.name, render: (row) => <button className="link-button resource-link" onClick={() => onOpen(row.name)} title={'Show pods in ' + row.name}>{row.name}</button> },
    { key: 'status', header: 'Status', value: (row) => row.phase, render: (row) => <StatusBadge status={row.phase} /> },
    ...(pods ? [{ key: 'pods', header: 'Pods', kind: 'num' as const, value: (row: NamespaceItem) => podCount(row.name) ?? 0 }] : []),
    ageColumn<NamespaceItem>(),
    labelsColumn<NamespaceItem>('Labels', (row) => Object.entries(row.labels).map(([key, value]) => key + '=' + value).join(',') || '<none>'),
    menuColumn<NamespaceItem>('Actions for namespace', (row) => [
      { label: 'Show pods', icon: <TerminalSquare size={16} />, onSelect: () => onOpen(row.name) },
      yamlItem(actions, () => actions.yaml('namespace', '', row.name)),
      deleteItem(actions, 'deleteResource', 'Delete namespace', () => actions.remove('namespace', '', row.name)),
    ]),
  ]
  return <>
    <PageHeader title="Namespaces" count={countLabel(rows.length, total)} description="Every namespace in the cluster, as in kubectl get namespaces. Click a name to open its pods."><CreateButton template="namespace" label="Create namespace" /></PageHeader>
    <section className="panel"><DataTable label="Namespaces" rows={rows} columns={columns} rowKey={(row) => row.name} empty={total ? emptyFor('namespaces', total) : <EmptyState title="No namespaces" detail="Check the cluster connection." />} /></section>
  </>
}
