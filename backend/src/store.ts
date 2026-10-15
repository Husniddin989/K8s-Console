import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Role } from './auth.js'

/** Users created in the admin UI. Users from AUTH_USERS_FILE live in config and are never stored here. */
export interface StoredUser {
  username: string
  passwordHash: string
  role: Role
  disabled: boolean
  sessionVersion: number
  createdAt: string
  createdBy: string | null
  updatedAt: string
  lastLoginAt: string | null
}

export type AuditResult = 'success' | 'failure'

export interface AuditEntry {
  id: number
  time: string
  username: string
  role: string
  action: string
  kind: string | null
  namespace: string | null
  name: string | null
  result: AuditResult
  error: string | null
  /** Before/after values or request parameters, as JSON. */
  details: Record<string, unknown> | null
  ip: string | null
}

export type NewAuditEntry = Omit<AuditEntry, 'id' | 'time'> & { time?: string }

export interface AuditQuery {
  search?: string
  action?: string
  result?: AuditResult
  username?: string
  namespace?: string
  limit?: number
  beforeId?: number
}

interface UserRow {
  username: string
  password_hash: string
  role: Role
  disabled: number
  session_version: number
  created_at: string
  created_by: string | null
  updated_at: string
  last_login_at: string | null
}

interface AuditRow {
  id: number
  time: string
  username: string
  role: string
  action: string
  kind: string | null
  namespace: string | null
  name: string | null
  result: AuditResult
  error: string | null
  details: string | null
  ip: string | null
}

const maxDetailsLength = 64 * 1024

function toUser(row: UserRow): StoredUser {
  return {
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    disabled: Boolean(row.disabled),
    sessionVersion: row.session_version,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  }
}

function toAudit(row: AuditRow): AuditEntry {
  let details: Record<string, unknown> | null = null
  if (row.details) {
    try {
      details = JSON.parse(row.details) as Record<string, unknown>
    } catch {
      details = { raw: row.details }
    }
  }
  return { ...row, details }
}

export class ConsoleStore {
  readonly location: string
  private readonly db: DatabaseSync

  constructor(location: string) {
    this.location = location
    if (location !== ':memory:') mkdirSync(path.dirname(location), { recursive: true })
    this.db = new DatabaseSync(location)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        session_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        kind TEXT,
        namespace TEXT,
        name TEXT,
        result TEXT NOT NULL,
        error TEXT,
        details TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_time ON audit (time);
      CREATE INDEX IF NOT EXISTS audit_action ON audit (action);
    `)
  }

  close(): void {
    this.db.close()
  }

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count
  }

  listUsers(): StoredUser[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all() as unknown as UserRow[]).map(toUser)
  }

  getUser(username: string): StoredUser | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
    return row ? toUser(row) : undefined
  }

  createUser(user: { username: string; passwordHash: string; role: Role; createdBy: string | null }): StoredUser {
    const now = new Date().toISOString()
    this.db.prepare('INSERT INTO users (username, password_hash, role, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.username, user.passwordHash, user.role, now, user.createdBy, now)
    return this.getUser(user.username)!
  }

  /** A password change or disabling bumps the session version, which signs the user out everywhere. */
  updateUser(username: string, changes: { role?: Role; passwordHash?: string; disabled?: boolean }): StoredUser | undefined {
    const current = this.getUser(username)
    if (!current) return undefined
    const endSessions = changes.passwordHash !== undefined || changes.disabled === true
    this.db.prepare('UPDATE users SET role = ?, password_hash = ?, disabled = ?, session_version = ?, updated_at = ? WHERE username = ?').run(
      changes.role ?? current.role,
      changes.passwordHash ?? current.passwordHash,
      (changes.disabled ?? current.disabled) ? 1 : 0,
      current.sessionVersion + (endSessions ? 1 : 0),
      new Date().toISOString(),
      username,
    )
    return this.getUser(username)
  }

  deleteUser(username: string): boolean {
    return Number(this.db.prepare('DELETE FROM users WHERE username = ?').run(username).changes) > 0
  }

  recordLogin(username: string): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE username = ?').run(new Date().toISOString(), username)
  }

  addAudit(entry: NewAuditEntry): AuditEntry {
    let details = entry.details ? JSON.stringify(entry.details) : null
    if (details && details.length > maxDetailsLength) details = JSON.stringify({ truncated: true, preview: details.slice(0, maxDetailsLength) })
    const result = this.db.prepare(`INSERT INTO audit (time, username, role, action, kind, namespace, name, result, error, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.time ?? new Date().toISOString(),
      entry.username,
      entry.role,
      entry.action,
      entry.kind,
      entry.namespace,
      entry.name,
      entry.result,
      entry.error ? entry.error.slice(0, 2000) : null,
      details,
      entry.ip,
    )
    return toAudit(this.db.prepare('SELECT * FROM audit WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as AuditRow)
  }

  queryAudit(query: AuditQuery = {}): AuditEntry[] {
    const where: string[] = []
    const values: Array<string | number> = []
    if (query.action) { where.push('action = ?'); values.push(query.action) }
    if (query.result) { where.push('result = ?'); values.push(query.result) }
    if (query.username) { where.push('username = ? COLLATE NOCASE'); values.push(query.username) }
    if (query.namespace) { where.push('namespace = ?'); values.push(query.namespace) }
    if (query.beforeId) { where.push('id < ?'); values.push(query.beforeId) }
    if (query.search) {
      const like = '%' + query.search.replace(/[\\%_]/g, (match) => '\\' + match) + '%'
      where.push("(username LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR namespace LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\')")
      values.push(like, like, like, like, like, like, like)
    }
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000)
    const sql = 'SELECT * FROM audit' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ' + limit
    return (this.db.prepare(sql).all(...values) as unknown as AuditRow[]).map(toAudit)
  }

  auditActions(): string[] {
    return (this.db.prepare('SELECT DISTINCT action FROM audit ORDER BY action').all() as Array<{ action: string }>).map((row) => row.action)
  }
}
