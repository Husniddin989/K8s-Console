import type { Request, Response } from 'express'
import type { AuthUser } from './auth.js'
import type { ConsoleStore, NewAuditEntry } from './store.js'

export interface ActionTarget {
  action: string
  kind?: string | null
  namespace?: string | null
  name?: string | null
  details?: Record<string, unknown>
}

/** The message Kubernetes put in its Status body, e.g. `deployments.apps "web" not found`. */
export function kubernetesMessage(error: unknown): string {
  const body = (error as { body?: unknown } | null)?.body
  let parsed: unknown = body
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
      if (body.trim()) return body.trim().slice(0, 500)
    }
  }
  const message = (parsed as { message?: unknown } | undefined)?.message
  if (typeof message === 'string' && message) return message
  return error instanceof Error ? error.message : 'Unknown error'
}

export function kubernetesCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown; statusCode?: unknown } | null)?.code ?? (error as { statusCode?: unknown } | null)?.statusCode
  return typeof code === 'number' && code >= 400 && code < 600 ? code : undefined
}

/** Maps a Kubernetes failure to the status the console answers with. */
export function actionStatus(error: unknown): number {
  const code = kubernetesCode(error)
  if (code === 404 || code === 409 || code === 422) return code
  if (code === 400) return 422
  if (code === 403) return 403
  return 502
}

export function recordAudit(store: ConsoleStore, request: Request, response: Response, entry: Omit<NewAuditEntry, 'username' | 'role' | 'ip'>) {
  const user = response.locals.user as AuthUser | undefined
  return store.addAudit({ ...entry, username: user?.username || 'anonymous', role: user?.role || 'none', ip: request.ip || null })
}

/**
 * Runs one cluster change, writes the audit record either way, and answers the request.
 * The operation returns extra audit details (such as before/after values) and the response body.
 */
export async function performAction(
  store: ConsoleStore,
  request: Request,
  response: Response,
  target: ActionTarget,
  operation: () => Promise<{ details?: Record<string, unknown>; body?: Record<string, unknown> } | void>,
): Promise<void> {
  const base = { action: target.action, kind: target.kind ?? null, namespace: target.namespace ?? null, name: target.name ?? null }
  try {
    const outcome = await operation() || {}
    const entry = recordAudit(store, request, response, { ...base, result: 'success', error: null, details: { ...target.details, ...outcome.details } })
    response.json({ ok: true, auditId: entry.id, ...outcome.body })
  } catch (error) {
    const message = error instanceof ActionError ? error.message : kubernetesMessage(error)
    const status = error instanceof ActionError ? error.status : actionStatus(error)
    recordAudit(store, request, response, { ...base, result: 'failure', error: message, details: target.details ?? null })
    console.warn('Action ' + target.action + ' on ' + [target.namespace, target.name].filter(Boolean).join('/') + ' failed: ' + message)
    response.status(status).json({ error: message })
  }
}

/** A failure the console detected itself (not from the Kubernetes API). */
export class ActionError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}
