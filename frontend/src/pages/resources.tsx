import { Bug, FileCode2, SquareTerminal, TerminalSquare } from 'lucide-react'
import { CreateButton, DataTable, EmptyState, PageHeader, StatusBadge, type Column } from '../components/ui'
import { useConsoleActions } from '../lib/actionsContext'
import { ageColumn, containersColumn, countLabel, deleteItem, emptyFor, imagesColumn, key, labelsColumn, menuColumn, nameColumn, namespaceColumn, rolloutItems, yamlItem, type ListProps } from '../lib/columns'
import { age, ageMs, restartsText } from '../lib/kubectl'
import { formatTime } from '../lib/format'
import type { DeploymentItem, EventItem, NamespaceItem, NodeItem, PodItem, ServiceItem } from '../types'

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
      yamlItem(actions, () => actions.yaml('pods', pod.namespace, pod.name)),
      deleteItem(actions, 'deletePod', 'Delete pod', () => actions.remove('pods', pod.namespace, pod.name)),
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
    containersColumn<DeploymentItem>(),
    imagesColumn<DeploymentItem>(),
    labelsColumn<DeploymentItem>('Selector', (row) => row.selector),
    menuColumn<DeploymentItem>('Actions for deployment', (row) => [
      ...rolloutItems(actions, 'deployments', row, true),
      yamlItem(actions, () => actions.yaml('deployments', row.namespace, row.name)),
      deleteItem(actions, 'deleteResource', 'Delete deployment', () => actions.remove('deployments', row.namespace, row.name)),
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
      yamlItem(actions, () => actions.yaml('services', row.namespace, row.name)),
      deleteItem(actions, 'deleteResource', 'Delete service', () => actions.remove('services', row.namespace, row.name)),
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
    menuColumn<NodeItem>('Actions for node', (row) => [{ label: 'View YAML', icon: <FileCode2 size={16} />, onSelect: () => actions.yaml('nodes', '', row.name) }]),
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
      yamlItem(actions, () => actions.yaml('namespaces', '', row.name)),
      deleteItem(actions, 'deleteResource', 'Delete namespace', () => actions.remove('namespaces', '', row.name)),
    ]),
  ]
  return <>
    <PageHeader title="Namespaces" count={countLabel(rows.length, total)} description="Every namespace in the cluster, as in kubectl get namespaces. Click a name to open its pods."><CreateButton template="namespace" label="Create namespace" /></PageHeader>
    <section className="panel"><DataTable label="Namespaces" rows={rows} columns={columns} rowKey={(row) => row.name} empty={total ? emptyFor('namespaces', total) : <EmptyState title="No namespaces" detail="Check the cluster connection." />} /></section>
  </>
}
