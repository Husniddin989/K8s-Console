import { describe, expect, it } from 'vitest'
import {
  AuthService,
  hasRole,
  hashPassword,
  isAllowedOrigin,
  LoginThrottle,
  parseCookies,
  parseUsers,
  signSession,
  verifyPassword,
  verifySession,
} from '../src/auth.js'
import { assertUsersExist, loadAuthConfig } from '../src/config.js'

const secret = 'x'.repeat(40)

describe('password hashing', () => {
  it('verifies the original password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false)
  })

  it('uses a fresh salt each time', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'))
  })

  it('rejects malformed hashes without throwing', async () => {
    expect(await verifyPassword('anything', 'plain-text')).toBe(false)
  })
})

describe('roles', () => {
  it('orders viewer < operator < admin', () => {
    expect(hasRole('admin', 'operator')).toBe(true)
    expect(hasRole('operator', 'operator')).toBe(true)
    expect(hasRole('viewer', 'operator')).toBe(false)
    expect(hasRole('operator', 'admin')).toBe(false)
  })
})

describe('user list parsing', () => {
  it('rejects unknown roles, plain passwords and duplicates', async () => {
    const passwordHash = await hashPassword('long enough password')
    expect(() => parseUsers([{ username: 'a', passwordHash, role: 'root' }])).toThrow(/role/)
    expect(() => parseUsers([{ username: 'a', passwordHash: 'secret', role: 'viewer' }])).toThrow(/passwordHash/)
    expect(() => parseUsers([{ username: 'a', passwordHash, role: 'viewer' }, { username: 'A', passwordHash, role: 'admin' }])).toThrow(/more than once/)
    expect(() => parseUsers({})).toThrow(/array/)
  })
})

describe('session tokens', () => {
  it('round-trips a valid token', () => {
    const token = signSession({ sub: 'ana', iat: 1, exp: 2000 }, secret)
    expect(verifySession(token, secret, 1000)).toEqual({ sub: 'ana', iat: 1, exp: 2000 })
  })

  it('rejects expired, tampered and foreign tokens', () => {
    const token = signSession({ sub: 'ana', iat: 1, exp: 2000 }, secret)
    expect(verifySession(token, secret, 2000)).toBeNull()
    const [body, signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', iat: 1, exp: 2000 })).toString('base64url')
    expect(verifySession(forged + '.' + signature, secret, 1000)).toBeNull()
    expect(verifySession(body + '.' + signature + 'x', secret, 1000)).toBeNull()
    expect(verifySession(token, 'y'.repeat(40), 1000)).toBeNull()
    expect(verifySession('garbage', secret, 1000)).toBeNull()
  })
})

describe('AuthService', () => {
  it('authenticates case-insensitively and resolves the current role', async () => {
    const users = [{ username: 'Ana', passwordHash: await hashPassword('ana password 1'), role: 'operator' as const }]
    const auth = new AuthService({ users, sessionSecret: secret, sessionTtlMs: 60_000 })
    expect(await auth.authenticate('ana', 'wrong password')).toBeNull()
    expect(await auth.authenticate('nobody', 'ana password 1')).toBeNull()
    const user = await auth.authenticate('ana', 'ana password 1')
    expect(user).toEqual({ username: 'Ana', role: 'operator' })

    const { token } = auth.issueSession(user!)
    expect(auth.resolveSession(token)).toMatchObject({ username: 'Ana', role: 'operator' })

    // A session for a user that was removed from the list is no longer valid.
    const withoutAna = new AuthService({ users: [], sessionSecret: secret, sessionTtlMs: 60_000 })
    expect(withoutAna.resolveSession(token)).toBeNull()

    // A role change applies to an existing session.
    const demoted = new AuthService({ users: [{ ...users[0], role: 'viewer' }], sessionSecret: secret, sessionTtlMs: 60_000 })
    expect(demoted.resolveSession(token)?.role).toBe('viewer')
  })
})

describe('helpers', () => {
  it('parses cookies', () => {
    expect(parseCookies('a=1; k8s_ui_session=abc.def; broken; b=%20x')).toEqual({ a: '1', k8s_ui_session: 'abc.def', b: ' x' })
    expect(parseCookies(undefined)).toEqual({})
  })

  it('accepts same-origin and missing origins only', () => {
    expect(isAllowedOrigin(undefined, '127.0.0.1:8080')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:8080', '127.0.0.1:8080')).toBe(true)
    expect(isAllowedOrigin('http://evil.test', '127.0.0.1:8080')).toBe(false)
    expect(isAllowedOrigin('http://console.test', '127.0.0.1:8080', ['http://console.test'])).toBe(true)
    expect(isAllowedOrigin('not a url', '127.0.0.1:8080')).toBe(false)
  })

  it('throttles repeated failures inside the window', () => {
    const throttle = new LoginThrottle(3, 1000)
    for (let attempt = 0; attempt < 3; attempt += 1) throttle.recordFailure('ip|ana', 100)
    expect(throttle.retryAfterMs('ip|ana', 200)).toBe(900)
    expect(throttle.retryAfterMs('ip|bob', 200)).toBe(0)
    expect(throttle.retryAfterMs('ip|ana', 1100)).toBe(0)
    throttle.recordFailure('ip|bob', 100)
    throttle.reset('ip|bob')
    expect(throttle.retryAfterMs('ip|bob', 100)).toBe(0)
  })
})

describe('loadAuthConfig', () => {
  it('fails closed only when neither config nor console users exist', () => {
    expect(() => assertUsersExist(0, 0)).toThrow(/No console users/)
    expect(() => assertUsersExist(1, 0)).not.toThrow()
    expect(() => assertUsersExist(0, 2)).not.toThrow()
  })

  it('reads data, write and debug settings', () => {
    const config = loadAuthConfig({ DATA_DIR: '/data', CLUSTER_WRITES: 'false', DEBUG_IMAGE: 'nicolaka/netshoot:v0.13' })
    expect(config).toMatchObject({ dataDirectory: '/data', clusterWrites: false, debugImage: 'nicolaka/netshoot:v0.13' })
    expect(loadAuthConfig({}).clusterWrites).toBe(true)
    expect(loadAuthConfig({}).warnings.join(' ')).toMatch(/DATA_DIR is not set/)
  })

  it('requires a strong session secret in production', async () => {
    const AUTH_USERS = JSON.stringify([{ username: 'ana', passwordHash: await hashPassword('ana password 1'), role: 'admin' }])
    expect(() => loadAuthConfig({ AUTH_USERS, NODE_ENV: 'production' })).toThrow(/SESSION_SECRET is required/)
    expect(() => loadAuthConfig({ AUTH_USERS, SESSION_SECRET: 'short' })).toThrow(/at least 32/)
    const config = loadAuthConfig({ AUTH_USERS })
    expect(config.warnings[0]).toMatch(/temporary secret/)
    expect(config.sessionTtlMs).toBe(8 * 60 * 60 * 1000)
  })
})
