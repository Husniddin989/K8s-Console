import { useState, type FormEvent } from 'react'
import { AlertCircle, Info, LoaderCircle, LockKeyhole } from 'lucide-react'
import { api } from './api'
import type { AuthSession } from './types'

export function Login({ notice, onSignedIn }: { notice?: string; onSignedIn: (session: AuthSession) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      onSignedIn(await api.login(username.trim(), password))
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Sign-in failed')
      setPassword('')
      setSubmitting(false)
    }
  }

  return <main className="login-page">
    <form className="login-card" onSubmit={(event) => void submit(event)} aria-labelledby="login-title">
      <div className="brand"><div className="brand-mark"><span /><span /><span /><span /></div><div className="brand-text"><strong>K8s Console</strong><span>Cluster management</span></div></div>
      <div className="login-heading"><h1 id="login-title">Sign in</h1><p>Use the console account your administrator gave you.</p></div>
      {notice && !error && <div className="login-notice" role="status"><Info size={15} /><span>{notice}</span></div>}
      {error && <div className="login-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
      <label className="login-field"><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required maxLength={64} /></label>
      <label className="login-field"><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required maxLength={1024} /></label>
      <button className="login-submit" type="submit" disabled={submitting || !username.trim() || !password}>{submitting ? <LoaderCircle size={15} className="spin" /> : <LockKeyhole size={15} />}{submitting ? 'Signing in…' : 'Sign in'}</button>
      <p className="login-footnote">Sessions end after a period set by your administrator. Access is limited by your role.</p>
    </form>
  </main>
}
