import { KeyRound } from 'lucide-react'
import { CreateButton, DataTable, PageHeader, type Column } from '../components/ui'
import { useConsoleActions } from '../lib/actionsContext'
import { ageColumn, countLabel, deleteItem, emptyFor, key, menuColumn, nameColumn, namespaceColumn, yamlItem, type ListProps } from '../lib/columns'
import type { ConfigMapItem, SecretItem } from '../types'

function keysColumn<T extends { keys: string[] }>(): Column<T> {
  return {
    key: 'keys',
    header: 'Keys',
    kind: 'labels',
    value: (row) => row.keys.join(','),
    render: (row) => row.keys.length ? <span className="label-list">{row.keys.slice(0, 8).map((item) => <span className="label-chip" key={item}>{item}</span>)}{row.keys.length > 8 && <span className="text-muted">+{row.keys.length - 8} more</span>}</span> : <span className="text-muted">&lt;none&gt;</span>,
  }
}

export function ConfigMapsPage({ rows, total, showNamespace }: ListProps<ConfigMapItem>) {
  const actions = useConsoleActions()
  const columns: Column<ConfigMapItem>[] = [
    ...(showNamespace ? [namespaceColumn<ConfigMapItem>()] : []),
    nameColumn<ConfigMapItem>(),
    { key: 'data', header: 'Data', kind: 'num', value: (row) => row.keys.length },
    keysColumn<ConfigMapItem>(),
    ageColumn<ConfigMapItem>(),
    menuColumn<ConfigMapItem>('Actions for config map', (row) => [
      yamlItem(actions, () => actions.yaml('configmaps', row.namespace, row.name)),
      deleteItem(actions, 'deleteResource', 'Delete config map', () => actions.remove('configmaps', row.namespace, row.name)),
    ]),
  ]
  return <>
    <PageHeader title="ConfigMaps" count={countLabel(rows.length, total)} description="Non-secret configuration, as in kubectl get configmaps. Open the YAML to read the values."><CreateButton template="configmap" label="Create config map" /></PageHeader>
    <section className="panel"><DataTable label="ConfigMaps" rows={rows} columns={columns} rowKey={key} initialSort={{ key: showNamespace ? 'namespace' : 'name', direction: 'asc' }} empty={emptyFor('config maps', total)} /></section>
  </>
}

export function SecretsPage({ rows, total, showNamespace }: ListProps<SecretItem>) {
  const actions = useConsoleActions()
  const columns: Column<SecretItem>[] = [
    ...(showNamespace ? [namespaceColumn<SecretItem>()] : []),
    nameColumn<SecretItem>(),
    { key: 'type', header: 'Type', kind: 'mono', value: (row) => row.type },
    { key: 'data', header: 'Data', kind: 'num', value: (row) => row.keys.length },
    keysColumn<SecretItem>(),
    ageColumn<SecretItem>(),
    { key: 'reveal', header: 'Values', kind: 'action', value: () => '', render: (row) => <button className="row-action" onClick={() => actions.revealSecret(row)} aria-label={'Show values of ' + row.name}><KeyRound size={15} /> Values</button> },
    menuColumn<SecretItem>('Actions for secret', (row) => [
      { label: 'Show values', icon: <KeyRound size={16} />, onSelect: () => actions.revealSecret(row) },
      yamlItem(actions, () => actions.yaml('secrets', row.namespace, row.name)),
      deleteItem(actions, 'deleteResource', 'Delete secret', () => actions.remove('secrets', row.namespace, row.name)),
    ]),
  ]
  return <>
    <PageHeader title="Secrets" count={countLabel(rows.length, total)} description="Admins only. The list shows key names; opening values or YAML is written to the audit log."><CreateButton template="secret" label="Create secret" /></PageHeader>
    <section className="panel"><DataTable label="Secrets" rows={rows} columns={columns} rowKey={key} initialSort={{ key: showNamespace ? 'namespace' : 'name', direction: 'asc' }} empty={emptyFor('secrets', total)} /></section>
  </>
}
