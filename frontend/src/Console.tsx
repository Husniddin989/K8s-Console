import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Boxes,
  Container,
  FileClock,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Network,
  RefreshCw,
  Search,
  Server,
  Sun,
  TerminalSquare,
  Users,
  Waypoints,
  X,
} from 'lucide-react'
import { api, AuthRequiredError } from './api'
import { ActionsProvider } from './components/ActionsProvider'
import { EmptyState, ErrorState, LoadingBlock } from './components/ui'
import { deploymentMatches, eventMatches, filterItems, nodeMatches, podMatches, serviceMatches } from './lib/filters'
import { humanDuration } from './lib/kubectl'
import { can } from './lib/permissions'
import { formatRoute, parseRoute } from './lib/route'
import { applyTheme, initialTheme, type Theme } from './lib/theme'
import { Logs } from './pages/Logs'
import { Overview } from './pages/Overview'
import { AuditPage } from './pages/Audit'
import { DeploymentsPage, EventsPage, NamespacesPage, NodesPage, PodsPage, ServicesPage } from './pages/resources'
import { UsersPage } from './pages/Users'
import type { AuthSession, ClusterSummary, DeploymentItem, EventItem, NamespaceItem, NodeItem, PageId, PodItem, Role, ServiceItem } from './types'

type DataState = 'loading' | 'ready' | 'error'

interface ClusterData {
  summary: ClusterSummary
  pods: PodItem[]
  deployments: DeploymentItem[]
  services: ServiceItem[]
  nodes: NodeItem[]
  events: EventItem[]
  loadedAt: number
}

type NavGroup = 'Cluster' | 'Workloads' | 'Observe' | 'Admin'

const navigation: Array<{ id: PageId; label: string; icon: typeof LayoutDashboard; group: NavGroup }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'Cluster' },
  { id: 'namespaces', label: 'Namespaces', icon: Network, group: 'Cluster' },
  { id: 'nodes', label: 'Nodes', icon: Server, group: 'Cluster' },
  { id: 'pods', label: 'Pods', icon: Container, group: 'Workloads' },
  { id: 'deployments', label: 'Deployments', icon: Boxes, group: 'Workloads' },
  { id: 'services', label: 'Services', icon: Waypoints, group: 'Workloads' },
  { id: 'events', label: 'Events', icon: FileClock, group: 'Observe' },
  { id: 'logs', label: 'Pod logs', icon: TerminalSquare, group: 'Observe' },
  { id: 'users', label: 'Users', icon: Users, group: 'Admin' },
  { id: 'audit', label: 'Audit log', icon: ListChecks, group: 'Admin' },
]
const adminPages: PageId[] = ['users', 'audit']

const roleLabels: Record<Role, string> = { viewer: 'Viewer', operator: 'Operator', admin: 'Admin' }

export function Console({ session, onSignOut, onSessionExpired }: { session: AuthSession; onSignOut: () => void; onSessionExpired: () => void }) {
  const initialRoute = useMemo(() => parseRoute(window.location.hash), [])
  const [page, setPage] = useState<PageId>(initialRoute.page)
  const [namespace, setNamespace] = useState(initialRoute.namespace)
  const [namespaces, setNamespaces] = useState<NamespaceItem[]>([])
  const [data, setData] = useState<(ClusterData & { namespace: string }) | null>(null)
  const [state, setState] = useState<DataState>('loading')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [selectedPod, setSelectedPod] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [now, setNow] = useState(() => Date.now())
  const searchInputRef = useRef<HTMLInputElement>(null)
  const requestControllerRef = useRef<AbortController | null>(null)

  useEffect(() => { applyTheme(theme) }, [theme])

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(tick)
  }, [])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchInputRef.current?.focus()
      }
      if (event.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setSearch('')
        searchInputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  useEffect(() => {
    const next = formatRoute({ page, namespace })
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  }, [page, namespace])

  useEffect(() => {
    const followHash = () => {
      const route = parseRoute(window.location.hash)
      setPage(route.page)
      setNamespace(route.namespace)
    }
    window.addEventListener('hashchange', followHash)
    return () => window.removeEventListener('hashchange', followHash)
  }, [])

  const refresh = useCallback(async (quiet = false) => {
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller
    if (!quiet) setRefreshing(true)
    try {
      const [namespaceData, summary, pods, deployments, services, nodes, events] = await Promise.all([
        api.namespaces(controller.signal),
        api.summary(namespace, controller.signal),
        api.pods(namespace, controller.signal),
        api.deployments(namespace, controller.signal),
        api.services(namespace, controller.signal),
        api.nodes(controller.signal),
        api.events(namespace, controller.signal),
      ])
      if (controller.signal.aborted) return
      setNamespaces(namespaceData)
      if (namespace !== 'all' && !namespaceData.some((item) => item.name === namespace)) {
        // The selected namespace was deleted (or came from an old link); fall back to every namespace.
        setNamespace('all')
        return
      }
      setData({ namespace, summary, pods, deployments, services, nodes, events, loadedAt: Date.now() })
      setNow(Date.now())
      setState('ready')
      setError('')
    } catch (requestError) {
      if (controller.signal.aborted) return
      if (requestError instanceof AuthRequiredError) {
        onSessionExpired()
        return
      }
      setState('error')
      setError(requestError instanceof Error ? requestError.message : 'Unable to load cluster data')
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null
        setRefreshing(false)
      }
    }
  }, [namespace, onSessionExpired])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void refresh() }, 0)
    const interval = window.setInterval(() => void refresh(true), 15000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(interval)
      requestControllerRef.current?.abort()
    }
  }, [refresh])

  const current = data && data.namespace === namespace ? data : null
  const filtered = useMemo(() => current && {
    pods: filterItems(current.pods, search, podMatches),
    deployments: filterItems(current.deployments, search, deploymentMatches),
    services: filterItems(current.services, search, serviceMatches),
    nodes: filterItems(current.nodes, search, nodeMatches),
    events: filterItems(current.events, search, eventMatches),
  }, [current, search])
  // `now` re-renders relative ages between refreshes.
  const updatedAgo = current ? humanDuration(Math.max(0, now - current.loadedAt)) : ''

  const isAdmin = can(session, 'manageUsers')
  const groups: NavGroup[] = isAdmin ? ['Cluster', 'Workloads', 'Observe', 'Admin'] : ['Cluster', 'Workloads', 'Observe']
  const counts: Partial<Record<PageId, number>> = current ? {
    namespaces: namespaces.length,
    pods: current.pods.length,
    deployments: current.deployments.length,
    services: current.services.length,
    nodes: current.nodes.length,
  } : {}
  const warningCount = current?.events.filter((event) => event.type === 'Warning').length || 0
  const showNamespace = namespace === 'all'
  const goTo = (nextPage: PageId) => {
    setPage(nextPage)
    setSidebarOpen(false)
  }
  const { user } = session

  const refreshQuietly = () => void refresh(true)
  const openNamespace = (name: string) => {
    setNamespace(name)
    goTo('pods')
  }
  const adminOnly = adminPages.includes(page) && !isAdmin

  return <ActionsProvider session={session} namespace={namespace} onChanged={refreshQuietly} onSessionExpired={onSessionExpired}><div className="shell">
    {sidebarOpen && <button className="backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}
    <aside className={'sidebar' + (sidebarOpen ? ' is-open' : '')}>
      <div className="brand"><div className="brand-mark"><span /><span /><span /><span /></div><div className="brand-text"><strong>K8s Console</strong><span>Cluster management</span></div><button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="cluster-card"><span className="cluster-label">Cluster</span><strong>{current?.summary.cluster || data?.summary.cluster || 'Connecting…'}</strong><span className="mono text-muted">{current?.summary.kubernetesVersion || data?.summary.kubernetesVersion || ''}</span></div>
      <nav className="nav" aria-label="Main navigation">
        {groups.map((group) => <div className="nav-group" key={group}>
          <span className="nav-group-label">{group}</span>
          {navigation.filter((item) => item.group === group).map((item) => {
            const Icon = item.icon
            const count = item.id === 'events' ? warningCount : counts[item.id]
            return <button className={'nav-item' + (page === item.id ? ' is-active' : '')} key={item.id} onClick={() => goTo(item.id)} aria-current={page === item.id ? 'page' : undefined}>
              <Icon size={18} strokeWidth={1.9} /><span>{item.label}</span>
              {count !== undefined && count > 0 && <span className={'nav-count' + (item.id === 'events' ? ' nav-count-warn' : '')} title={item.id === 'events' ? count + ' warnings' : undefined}>{count}</span>}
            </button>
          })}
        </div>)}
      </nav>
      <div className="sidebar-footer">
        <div className="user-card"><div className="avatar">{user.username.slice(0, 1).toUpperCase()}</div><div className="user-text"><strong title={user.username}>{user.username}</strong><span>{roleLabels[user.role]}{session.clusterWrites ? '' : ' · read-only console'}</span></div><button className="icon-button" onClick={onSignOut} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button></div>
      </div>
    </aside>

    <div className="main">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu size={20} /></button>
        <label className="search"><Search size={17} /><input ref={searchInputRef} aria-label="Search resources" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, status, IP, image…" />{search ? <button className="icon-button icon-button-small" onClick={() => setSearch('')} aria-label="Clear search"><X size={15} /></button> : <kbd>⌘K</kbd>}</label>
        <label className="namespace-select"><span>Namespace</span><select value={namespace} onChange={(event) => setNamespace(event.target.value)} aria-label="Select namespace"><option value="all">All namespaces</option>{namespace !== 'all' && !namespaces.some((item) => item.name === namespace) && <option value={namespace}>{namespace}</option>}{namespaces.map((item) => <option value={item.name} key={item.name}>{item.name}</option>)}</select></label>
        <span className="topbar-spacer" />
        <span className={'connection connection-' + state} role="status" title={current ? 'Updated ' + updatedAgo + ' ago' : undefined}><i />{state === 'ready' ? 'Live · ' + updatedAgo + ' ago' : state === 'error' ? 'Connection issue' : 'Connecting'}</span>
        <button className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
        <button className="button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''} /><span className="hide-small">Refresh</span></button>
      </header>

      <main className="content">
        {error && current && <div className="banner banner-error" role="alert"><AlertCircle size={18} /><div><strong>Cluster data could not be refreshed.</strong> {error} Showing data from {updatedAgo} ago.</div><button className="button button-small" onClick={() => void refresh()} disabled={refreshing}>Retry</button></div>}
        {adminOnly ? <section className="panel"><EmptyState title="Admins only" detail="Ask an admin if you need access to this page." /></section>
          : page === 'users' ? <UsersPage currentUser={user.username} onSessionExpired={onSessionExpired} />
          : page === 'audit' ? <AuditPage onSessionExpired={onSessionExpired} />
          : page === 'namespaces' && namespaces.length ? <NamespacesPage rows={filterItems(namespaces, search, (item, term) => item.name.includes(term) || item.phase.toLowerCase().includes(term))} total={namespaces.length} pods={current && namespace === 'all' ? current.pods : null} onOpen={openNamespace} />
          : !current || !filtered ? (state === 'error' ? <ErrorState message={error} retrying={refreshing} onRetry={() => void refresh()} /> : <LoadingBlock />) : <>
          {page === 'overview' && <Overview summary={current.summary} pods={current.pods} events={current.events} goTo={goTo} />}
          {page === 'pods' && <PodsPage rows={filtered.pods} total={current.pods.length} showNamespace={showNamespace} onOpenLogs={(pod) => { setSelectedPod(pod.namespace + '/' + pod.name); goTo('logs') }} />}
          {page === 'deployments' && <DeploymentsPage rows={filtered.deployments} total={current.deployments.length} showNamespace={showNamespace} />}
          {page === 'services' && <ServicesPage rows={filtered.services} total={current.services.length} showNamespace={showNamespace} />}
          {page === 'nodes' && <NodesPage rows={filtered.nodes} total={current.nodes.length} />}
          {page === 'events' && <EventsPage rows={filtered.events} total={current.events.length} showNamespace={showNamespace} />}
          {page === 'logs' && <Logs key={selectedPod} pods={current.pods} initialPod={selectedPod} onSessionExpired={onSessionExpired} />}
        </>}
      </main>
    </div>
  </div></ActionsProvider>
}
