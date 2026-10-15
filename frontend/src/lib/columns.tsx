import { FileCode2, ImageUp, RotateCcw, Scaling, Trash2 } from 'lucide-react'
import { RowMenu, type MenuItem } from '../components/RowMenu'
import { EmptyState, type Column } from '../components/ui'
import type { ConsoleActions } from './actionsContext'
import { countLabel, formatTime } from './format'
import { age, ageMs } from './kubectl'
import type { ResourceKind, WorkloadRow } from '../types'

export { countLabel }

export const key = (row: { namespace: string; name: string }) => row.namespace + '/' + row.name

export function namespaceColumn<T extends { namespace: string }>(): Column<T> {
  return { key: 'namespace', header: 'Namespace', value: (row) => row.namespace, render: (row) => <span className="chip">{row.namespace}</span> }
}

export function nameColumn<T extends { name: string }>(): Column<T> {
  return { key: 'name', header: 'Name', value: (row) => row.name, render: (row) => <span className="resource-name">{row.name}</span> }
}

export function ageColumn<T extends { createdAt: string | null }>(): Column<T> {
  return { key: 'age', header: 'Age', kind: 'mono', value: (row) => ageMs(row.createdAt), render: (row) => <span title={row.createdAt ? formatTime(row.createdAt) : undefined}>{age(row.createdAt)}</span> }
}

export interface ListProps<T> {
  rows: T[]
  total: number
  showNamespace: boolean
}

/** Renders `a=b,c=d` selectors as wrapping chips so long label sets stay readable. */
export function labelsColumn<T>(header: string, value: (row: T) => string): Column<T> {
  return {
    key: header.toLowerCase(),
    header,
    kind: 'labels',
    value,
    render: (row) => value(row) === '<none>' ? <span className="text-muted">&lt;none&gt;</span> : <span className="label-list">{value(row).split(',').map((label) => <span className="label-chip" key={label}>{label}</span>)}</span>,
  }
}

export function menuColumn<T extends { name: string }>(label: string, items: (row: T) => MenuItem[]): Column<T> {
  return { key: 'menu', header: 'Actions', kind: 'action', value: () => '', render: (row) => <RowMenu label={label + ' ' + row.name} items={items(row)} /> }
}

export function yamlItem(actions: ConsoleActions, open: () => void): MenuItem {
  return { label: actions.can('apply') ? 'View / edit YAML' : 'View YAML', icon: <FileCode2 size={16} />, onSelect: open }
}

export function deleteItem(actions: ConsoleActions, capability: 'deletePod' | 'deleteResource', label: string, run: () => void): MenuItem {
  return { label, icon: <Trash2 size={16} />, onSelect: run, danger: true, blocked: actions.blocked(capability) || undefined, separatorBefore: true }
}

export function emptyFor(kind: string, total: number) {
  return total
    ? <EmptyState title={'No matching ' + kind} detail="Clear or change the search to see more." />
    : <EmptyState title={'No ' + kind + ' in this scope'} detail="Choose another namespace from the selector at the top." />
}

/** Restart, scale and image items shared by deployments, stateful sets and daemon sets. */
export function rolloutItems(actions: ConsoleActions, kind: ResourceKind, row: WorkloadRow, scalable: boolean): MenuItem[] {
  return [
    { label: 'Restart', icon: <RotateCcw size={16} />, onSelect: () => actions.restart(kind, row), blocked: actions.blocked('restart') || undefined },
    ...(scalable ? [{ label: 'Scale', icon: <Scaling size={16} />, onSelect: () => actions.scale(kind, row), blocked: actions.blocked('scale') || undefined }] : []),
    { label: 'Update image', icon: <ImageUp size={16} />, onSelect: () => actions.setImage(kind, row), blocked: actions.blocked('setImage') || undefined },
  ]
}

/** One image per line, matching the containers column. */
export function imagesColumn<T extends { images: string[] }>(): Column<T> {
  return { key: 'images', header: 'Images', kind: 'mono', value: (row) => row.images.join(','), render: (row) => <span className="stack">{row.images.map((image, index) => <span key={index}>{image}</span>)}</span> }
}

export function containersColumn<T extends { containers: string[] }>(): Column<T> {
  return { key: 'containers', header: 'Containers', value: (row) => row.containers.join(','), render: (row) => row.containers.join(', ') }
}
