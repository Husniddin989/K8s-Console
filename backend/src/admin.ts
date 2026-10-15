import express, { type Request, type Response } from 'express'
import { requireRole } from './app.js'
import { AuthService, hashPassword, isRole, type AuthUser, type Role } from './auth.js'
import { recordAudit } from './audit.js'
import type { AuditResult, ConsoleStore } from './store.js'

const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,63}$/
const minPasswordLength = 10

interface UserView {
  username: string
  role: Role
  source: 'config' | 'console'
  disabled: boolean
  createdAt: string | null
  createdBy: string | null
  lastLoginAt: string | null
}

function fail(response: Response, status: number, error: string) {
  response.status(status).json({ error })
}

export function createAdminRouter(options: { auth: AuthService; store: ConsoleStore }) {
  const { auth, store } = options
  const router = express.Router()
  router.use(requireRole('admin'))

  const listUsers = (): UserView[] => [
    ...auth.configUserList().map((user) => ({ username: user.username, role: user.role, source: 'config' as const, disabled: false, createdAt: null, createdBy: null, lastLoginAt: null })),
    ...store.listUsers().filter((user) => !auth.isConfigUser(user.username)).map((user) => ({
      username: user.username,
      role: user.role,
      source: 'console' as const,
      disabled: user.disabled,
      createdAt: user.createdAt,
      createdBy: user.createdBy,
      lastLoginAt: user.lastLoginAt,
    })),
  ].sort((a, b) => a.username.localeCompare(b.username))

  /** Keeps at least one admin who can sign in, so the console never locks everyone out of user management. */
  const remainingAdmins = (excluding: string) => listUsers().filter((user) => user.role === 'admin' && !user.disabled && user.username.toLowerCase() !== excluding.toLowerCase()).length

  router.get('/users', (_request, response) => {
    response.json(listUsers())
  })

  router.post('/users', async (request, response) => {
    const { username, role, password } = (request.body ?? {}) as { username?: unknown; role?: unknown; password?: unknown }
    if (typeof username !== 'string' || !usernamePattern.test(username)) return fail(response, 400, 'Usernames use letters, digits, ".", "_", "@" or "-" (up to 64 characters)')
    if (!isRole(role)) return fail(response, 400, 'Choose a role: viewer, operator or admin')
    if (typeof password !== 'string' || password.length < minPasswordLength || password.length > 1024) return fail(response, 400, 'Passwords need at least ' + minPasswordLength + ' characters')
    if (auth.isConfigUser(username) || store.getUser(username)) return fail(response, 409, 'A user named ' + username + ' already exists')
    const created = store.createUser({ username, role, passwordHash: await hashPassword(password), createdBy: (response.locals.user as AuthUser).username })
    recordAudit(store, request, response, { action: 'user.create', kind: 'User', namespace: null, name: created.username, result: 'success', error: null, details: { after: { role } } })
    response.status(201).json(listUsers().find((user) => user.username === created.username))
  })

  router.patch('/users/:username', async (request: Request, response: Response) => {
    const username = String(request.params.username)
    const actor = response.locals.user as AuthUser
    if (auth.isConfigUser(username)) return fail(response, 409, username + ' is defined in the Helm values or users file; change it there')
    const current = store.getUser(username)
    if (!current) return fail(response, 404, 'User ' + username + ' does not exist')
    const { role, password, disabled } = (request.body ?? {}) as { role?: unknown; password?: unknown; disabled?: unknown }
    if (role !== undefined && !isRole(role)) return fail(response, 400, 'Choose a role: viewer, operator or admin')
    if (disabled !== undefined && typeof disabled !== 'boolean') return fail(response, 400, 'disabled must be true or false')
    if (password !== undefined && (typeof password !== 'string' || password.length < minPasswordLength || password.length > 1024)) return fail(response, 400, 'Passwords need at least ' + minPasswordLength + ' characters')
    const losesAdmin = current.role === 'admin' && ((role !== undefined && role !== 'admin') || disabled === true)
    if (losesAdmin && current.username.toLowerCase() === actor.username.toLowerCase()) return fail(response, 409, 'You cannot remove your own admin access')
    if (losesAdmin && remainingAdmins(current.username) === 0) return fail(response, 409, 'At least one active admin must remain')

    const updated = store.updateUser(current.username, {
      role: role as Role | undefined,
      disabled: disabled as boolean | undefined,
      passwordHash: typeof password === 'string' ? await hashPassword(password) : undefined,
    })!
    recordAudit(store, request, response, {
      action: 'user.update',
      kind: 'User',
      namespace: null,
      name: current.username,
      result: 'success',
      error: null,
      details: {
        before: { role: current.role, disabled: current.disabled },
        after: { role: updated.role, disabled: updated.disabled },
        passwordReset: typeof password === 'string',
      },
    })
    response.json(listUsers().find((user) => user.username === updated.username))
  })

  router.delete('/users/:username', (request, response) => {
    const username = String(request.params.username)
    const actor = response.locals.user as AuthUser
    if (auth.isConfigUser(username)) return fail(response, 409, username + ' is defined in the Helm values or users file; remove it there')
    const current = store.getUser(username)
    if (!current) return fail(response, 404, 'User ' + username + ' does not exist')
    if (current.username.toLowerCase() === actor.username.toLowerCase()) return fail(response, 409, 'You cannot delete your own account')
    if (current.role === 'admin' && !current.disabled && remainingAdmins(current.username) === 0) return fail(response, 409, 'At least one active admin must remain')
    store.deleteUser(current.username)
    recordAudit(store, request, response, { action: 'user.delete', kind: 'User', namespace: null, name: current.username, result: 'success', error: null, details: { before: { role: current.role } } })
    response.status(204).end()
  })

  router.get('/audit', (request, response) => {
    const query = request.query
    const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined
    const result = text(query.result)
    response.json({
      entries: store.queryAudit({
        search: text(query.search),
        action: text(query.action),
        result: result === 'success' || result === 'failure' ? result as AuditResult : undefined,
        username: text(query.user),
        namespace: text(query.namespace),
        limit: Number(query.limit) || 200,
        beforeId: Number(query.before) || undefined,
      }),
      actions: store.auditActions(),
    })
  })

  return router
}
