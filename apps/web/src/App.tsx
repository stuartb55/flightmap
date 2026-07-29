import {
  Component,
  lazy,
  Suspense,
  useEffect,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { RadioTower, RotateCcw } from 'lucide-react'
import { AppShell } from './components/AppShell'
import { Router, useLocation } from './lib/router'
import { LiveProvider } from './state/LiveContext'

const LivePage = lazy(() => import('./pages/LivePage').then((module) => ({ default: module.LivePage })))
const HistoryPage = lazy(() =>
  import('./pages/HistoryPage').then((module) => ({ default: module.HistoryPage })),
)
const AlertsPage = lazy(() =>
  import('./pages/AlertsPage').then((module) => ({ default: module.AlertsPage })),
)
const SystemPage = lazy(() =>
  import('./pages/SystemPage').then((module) => ({ default: module.SystemPage })),
)
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
)

function PageLoading() {
  return (
    <div className="page-loading" role="status">
      <span><RadioTower size={21} /></span>
      <strong>Loading flightmap</strong>
    </div>
  )
}

function AppRoutes() {
  const { pathname, navigate } = useLocation()
  const knownPath = ['/', '/history', '/alerts', '/system', '/settings'].includes(pathname)

  useEffect(() => {
    if (!knownPath) navigate('/', true)
  }, [knownPath, navigate])

  const Page =
    pathname === '/history'
      ? HistoryPage
      : pathname === '/alerts'
        ? AlertsPage
        : pathname === '/system'
          ? SystemPage
          : pathname === '/settings'
            ? SettingsPage
          : LivePage

  return (
    <AppShell>
      <Suspense fallback={<PageLoading />}>
        <Page />
      </Suspense>
    </AppShell>
  )
}

interface ErrorBoundaryState {
  error: Error | null
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, details: ErrorInfo) {
    console.error('Flightmap UI failed', error, details.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="fatal-error" role="alert">
        <RadioTower size={30} aria-hidden="true" />
        <h1>Flightmap could not continue</h1>
        <p>The interface hit an unexpected problem. Live data collection is not affected.</p>
        <button type="button" className="primary-button" onClick={() => window.location.reload()}>
          <RotateCcw size={16} aria-hidden="true" />
          Reload application
        </button>
      </main>
    )
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <Router>
        <LiveProvider>
          <AppRoutes />
        </LiveProvider>
      </Router>
    </ErrorBoundary>
  )
}
