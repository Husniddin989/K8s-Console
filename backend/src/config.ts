import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseUsers, type UserRecord } from './auth.js'

export type CookieSecurity = 'auto' | 'always' | 'never'

export interface AuthConfig {
  users: UserRecord[]
  sessionSecret: string
  sessionTtlMs: number
  cookieSecurity: CookieSecurity
  trustedOrigins: string[]
  /** Where the SQLite database with console users and audit records lives; empty keeps it in memory. */
  dataDirectory: string
  /** False turns off every cluster change (restart, scale, delete, apply, shell, debug). */
  clusterWrites: boolean
  debugImage: string
  warnings: string[]
}

type Environment = Record<string, string | undefined>

function readUsers(env: Environment): UserRecord[] {
  if (env.AUTH_USERS_FILE) {
    let text: string
    try {
      text = readFileSync(env.AUTH_USERS_FILE, 'utf8')
    } catch (error) {
      throw new Error('Cannot read AUTH_USERS_FILE (' + env.AUTH_USERS_FILE + '): ' + (error instanceof Error ? error.message : 'unknown error'))
    }
    return parseUsers(JSON.parse(text))
  }
  if (env.AUTH_USERS) return parseUsers(JSON.parse(env.AUTH_USERS))
  return []
}

/** Reads authentication settings and fails closed when no login is possible. */
export function loadAuthConfig(env: Environment = process.env): AuthConfig {
  const warnings: string[] = []
  const users = readUsers(env)

  let sessionSecret = env.SESSION_SECRET || ''
  if (!sessionSecret) {
    if (env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required in production')
    sessionSecret = randomBytes(32).toString('base64url')
    warnings.push('SESSION_SECRET is not set; using a temporary secret, so sessions end when the API restarts')
  } else if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters long')
  }

  const ttlHours = Number(env.SESSION_TTL_HOURS || 8)
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 7) {
    throw new Error('SESSION_TTL_HOURS must be a number between 0 and 168')
  }

  const cookieSecurity = (env.COOKIE_SECURE || 'auto') as CookieSecurity
  if (!['auto', 'always', 'never'].includes(cookieSecurity)) {
    throw new Error('COOKIE_SECURE must be auto, always, or never')
  }

  const trustedOrigins = (env.TRUSTED_ORIGINS || '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean)

  const dataDirectory = env.DATA_DIR || ''
  if (!dataDirectory) warnings.push('DATA_DIR is not set; users created in the UI and audit records are kept in memory and lost on restart')

  return {
    users,
    sessionSecret,
    sessionTtlMs: ttlHours * 60 * 60 * 1000,
    cookieSecurity,
    trustedOrigins,
    dataDirectory,
    clusterWrites: env.CLUSTER_WRITES !== 'false',
    debugImage: env.DEBUG_IMAGE || 'busybox:1.36',
    warnings,
  }
}

/** Fails closed: with no config users and no console users nobody could sign in. */
export function assertUsersExist(configUsers: number, consoleUsers: number): void {
  if (!configUsers && !consoleUsers) {
    throw new Error('No console users exist. Set AUTH_USERS_FILE (see README: "Create a local user").')
  }
}
