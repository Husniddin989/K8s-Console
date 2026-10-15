import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { LoadingBlock } from './components/ui'
import { Console } from './Console'
import { initialTheme, applyTheme } from './lib/theme'
import { Login } from './Login'
import type { AuthSession } from './types'
import './App.css'

type AuthState =
  | { status: 'checking' }
  | { status: 'anonymous'; notice?: string }
  | { status: 'signed-in'; session: AuthSession }

applyTheme(initialTheme())

function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' })

  useEffect(() => {
    let cancelled = false
    api.me()
      .then((session) => { if (!cancelled) setAuth(session ? { status: 'signed-in', session } : { status: 'anonymous' }) })
      .catch((error: unknown) => { if (!cancelled) setAuth({ status: 'anonymous', notice: error instanceof Error ? error.message : 'Cannot reach the console API.' }) })
    return () => { cancelled = true }
  }, [])

  const signOut = useCallback(() => {
    void api.logout().catch(() => undefined)
    setAuth({ status: 'anonymous', notice: 'You signed out.' })
  }, [])
  const sessionExpired = useCallback(() => {
    setAuth((current) => current.status === 'signed-in' ? { status: 'anonymous', notice: 'Your session expired. Sign in again to continue.' } : current)
  }, [])

  if (auth.status === 'checking') return <div className="login-page"><LoadingBlock label="Checking your session" /></div>
  if (auth.status === 'anonymous') return <Login notice={auth.notice} onSignedIn={(session) => setAuth({ status: 'signed-in', session })} />
  return <Console key={auth.session.user.username} session={auth.session} onSignOut={signOut} onSessionExpired={sessionExpired} />
}

export default App
