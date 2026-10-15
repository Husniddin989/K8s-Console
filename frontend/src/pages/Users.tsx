import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { KeyRound, Lock, Plus, ShieldCheck, Trash2, UserCheck, UserX } from 'lucide-react'
import { api, AuthRequiredError } from '../api'
import { ConfirmDialog } from '../components/dialogs'
import { Modal } from '../components/Modal'
import { RowMenu } from '../components/RowMenu'
import { DataTable, EmptyState, ErrorState, LoadingBlock, PageHeader, type Column } from '../components/ui'
import { useConsoleActions } from '../lib/actionsContext'
import { age, ageMs } from '../lib/kubectl'
import { formatTime } from '../lib/format'
import type { AdminUser, Role } from '../types'

const roles: Array<{ id: Role; label: string; detail: string }> = [
  { id: 'viewer', label: 'Viewer', detail: 'Reads every page and pod logs' },
  { id: 'operator', label: 'Operator', detail: 'Viewer + restart, scale, update image, delete pods' },
  { id: 'admin', label: 'Admin', detail: 'Operator + shell, debug, create/edit YAML, delete resources, users, audit' },
]

function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

function PasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [visible, setVisible] = useState(false)
  return <label className="form-field"><span>Password <small className="text-muted">(at least 10 characters)</small></span>
    <span className="input-row">
      <input type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} autoComplete="new-password" className="mono" />
      <button type="button" className="button" onClick={() => setVisible((current) => !current)}>{visible ? 'Hide' : 'Show'}</button>
      <button type="button" className="button" onClick={() => { onChange(generatePassword()); setVisible(true) }}>Generate</button>
    </span>
  </label>
}

function UserDialog({ user, onSave, onClose }: { user?: AdminUser; onSave: (values: { username: string; role: Role; password: string }) => Promise<void>; onClose: () => void }) {
  const [username, setUsername] = useState(user?.username ?? '')
  const [role, setRole] = useState<Role>(user?.role ?? 'viewer')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const resetting = Boolean(user)
  const valid = (resetting || /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,63}$/.test(username)) && password.length >= 10

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await onSave({ username, role, password })
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Saving failed')
      setBusy(false)
    }
  }

  return <Modal title={resetting ? 'Reset password' : 'Add user'} subtitle={resetting ? user!.username + ' will be signed out everywhere' : 'The new user signs in with this username and password'} onClose={onClose} size="small" footer={<>
    <button className="button" onClick={onClose}>Cancel</button>
    <button className="button button-primary" disabled={busy || !valid} onClick={() => void save()}>{resetting ? 'Set new password' : 'Add user'}</button>
  </>}>
    {!resetting && <label className="form-field"><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" spellCheck={false} data-autofocus /></label>}
    {!resetting && <fieldset className="role-picker"><legend>Role</legend>{roles.map((item) => <label key={item.id} className={role === item.id ? 'is-selected' : ''}>
      <input type="radio" name="role" value={item.id} checked={role === item.id} onChange={() => setRole(item.id)} />
      <span><strong>{item.label}</strong><small>{item.detail}</small></span>
    </label>)}</fieldset>}
    <PasswordField value={password} onChange={setPassword} />
    <p className="form-hint">Share the password over a private channel. It is stored only as a scrypt hash.</p>
    {error && <div className="form-error" role="alert">{error}</div>}
  </Modal>
}

export function UsersPage({ currentUser, onSessionExpired }: { currentUser: string; onSessionExpired: () => void }) {
  const actions = useConsoleActions()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<ReactNode>(null)

  const load = useCallback(async () => {
    try {
      setUsers(await api.users())
      setError('')
    } catch (loadError) {
      if (loadError instanceof AuthRequiredError) onSessionExpired()
      setError(loadError instanceof Error ? loadError.message : 'Could not load users')
    }
  }, [onSessionExpired])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const run = async (operation: () => Promise<unknown>, success: string) => {
    try {
      await operation()
    } catch (runError) {
      if (runError instanceof AuthRequiredError) onSessionExpired()
      throw runError
    }
    actions.notify('success', success)
    await load()
  }
  const close = () => setDialog(null)
  const isSelf = (user: AdminUser) => user.username.toLowerCase() === currentUser.toLowerCase()

  const columns: Column<AdminUser>[] = [
    { key: 'username', header: 'User', value: (user) => user.username, render: (user) => <span className="user-cell"><span className="avatar avatar-small">{user.username.slice(0, 1).toUpperCase()}</span><span className="resource-name">{user.username}</span>{isSelf(user) && <span className="chip">you</span>}</span> },
    { key: 'role', header: 'Role', value: (user) => user.role, render: (user) => user.source === 'console' && !isSelf(user)
      ? <select className="inline-select" value={user.role} aria-label={'Role for ' + user.username} onChange={(event) => {
        const role = event.target.value as Role
        run(() => api.updateUser(user.username, { role }), user.username + ' is now ' + role).catch((updateError: unknown) => actions.notify('error', updateError instanceof Error ? updateError.message : 'Update failed'))
      }}>{roles.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      : <span className={'role-pill role-' + user.role}>{roles.find((item) => item.id === user.role)?.label}</span> },
    { key: 'status', header: 'Status', value: (user) => user.disabled ? 1 : 0, render: (user) => user.disabled ? <span className="badge badge-neutral"><span className="badge-dot" />Disabled</span> : <span className="badge badge-good"><span className="badge-dot" />Active</span> },
    { key: 'source', header: 'Managed in', value: (user) => user.source, render: (user) => user.source === 'config' ? <span className="source-pill" title="Defined in auth.users (Helm) or AUTH_USERS_FILE; change it there"><Lock size={13} /> Helm / users file</span> : <span className="source-pill"><ShieldCheck size={13} /> Console</span> },
    { key: 'lastLogin', header: 'Last sign-in', kind: 'mono', value: (user) => ageMs(user.lastLoginAt), render: (user) => user.lastLoginAt ? <span title={formatTime(user.lastLoginAt)}>{age(user.lastLoginAt)} ago</span> : <span className="text-muted">{user.source === 'config' ? '—' : 'never'}</span> },
    { key: 'created', header: 'Created', value: (user) => ageMs(user.createdAt), render: (user) => user.createdAt ? <span title={formatTime(user.createdAt)}>{age(user.createdAt)} ago{user.createdBy ? ' by ' + user.createdBy : ''}</span> : <span className="text-muted">—</span> },
    { key: 'menu', header: 'Actions', kind: 'action', value: () => '', render: (user) => user.source === 'config' ? null : <RowMenu label={'Actions for ' + user.username} items={[
      { label: 'Reset password', icon: <KeyRound size={16} />, onSelect: () => setDialog(<UserDialog user={user} onClose={close} onSave={({ password }) => run(() => api.updateUser(user.username, { password }), 'New password set for ' + user.username)} />) },
      user.disabled
        ? { label: 'Enable', icon: <UserCheck size={16} />, onSelect: () => void run(() => api.updateUser(user.username, { disabled: false }), user.username + ' can sign in again').catch((enableError: unknown) => actions.notify('error', enableError instanceof Error ? enableError.message : 'Update failed')) }
        : { label: 'Disable', icon: <UserX size={16} />, blocked: isSelf(user) ? 'You cannot disable yourself' : undefined, onSelect: () => setDialog(<ConfirmDialog title="Disable user" message={<>Sign <strong>{user.username}</strong> out everywhere and block new sign-ins? You can enable the account again later.</>} confirmLabel="Disable" danger onClose={close} onConfirm={() => run(() => api.updateUser(user.username, { disabled: true }), user.username + ' is disabled')} />) },
      { label: 'Delete user', icon: <Trash2 size={16} />, danger: true, separatorBefore: true, blocked: isSelf(user) ? 'You cannot delete yourself' : undefined, onSelect: () => setDialog(<ConfirmDialog title="Delete user" message={<>Delete <strong>{user.username}</strong>? Their audit history is kept.</>} confirmLabel="Delete user" danger onClose={close} onConfirm={() => run(() => api.deleteUser(user.username), 'Deleted ' + user.username)} />) },
    ]} /> },
  ]

  return <>
    <PageHeader title="Users" count={users ? String(users.length) : undefined} description="Who can sign in and what their role allows. Roles apply immediately, even to open sessions.">
      <button className="button button-primary" onClick={() => setDialog(<UserDialog onClose={close} onSave={(values) => run(() => api.createUser(values), 'Added ' + values.username + ' as ' + values.role)} />)}><Plus size={16} />Add user</button>
    </PageHeader>
    <section className="panel role-summary">{roles.map((item) => <div key={item.id}><span className={'role-pill role-' + item.id}>{item.label}</span><span>{item.detail}</span></div>)}</section>
    {error && !users ? <ErrorState message={error} retrying={false} onRetry={() => void load()} />
      : !users ? <LoadingBlock label="Loading users" />
        : <section className="panel"><DataTable label="Users" rows={users} columns={columns} rowKey={(user) => user.username} empty={<EmptyState title="No users" detail="Add the first console user." />} /></section>}
    {dialog}
  </>
}
