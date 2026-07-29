import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ErrorInfo,
  type FormEvent,
  type ReactNode,
} from 'react'
import { KeyRound, RadioTower, RotateCcw } from 'lucide-react'
import { AppShell } from './components/AppShell'
import { AUTH_REQUIRED } from './config'
import { AUTHENTICATION_REQUIRED_EVENT, ApiError, api } from './lib/api'
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

function AuthenticationGate({ children }: { children: ReactNode }) {
  const [required, setRequired] = useState(AUTH_REQUIRED)
  const [authenticated, setAuthenticated] = useState(false)
  const [checking, setChecking] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void api
      .authSession(controller.signal)
      .then((session) => {
        setRequired(session.required)
        setAuthenticated(session.authenticated)
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setRequired(true)
          setError(reason instanceof Error ? reason.message : 'Unable to check this session')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const requireAuthentication = () => {
      setRequired(true)
      setAuthenticated(false)
      setError('Your session expired. Enter the access token again.')
    }
    window.addEventListener(AUTHENTICATION_REQUIRED_EVENT, requireAuthentication)
    return () => window.removeEventListener(AUTHENTICATION_REQUIRED_EVENT, requireAuthentication)
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const token = String(data.get('token') ?? '')
    setSubmitting(true)
    setError('')
    try {
      await api.login(token)
      setAuthenticated(true)
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.status === 401
          ? 'That access token was not accepted.'
          : reason instanceof Error
            ? reason.message
            : 'Unable to sign in',
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (checking) return <PageLoading />
  if (authenticated) return children
  if (!required) return children
  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <span className="auth-mark"><KeyRound size={24} aria-hidden="true" /></span>
        <h1>Private receiver</h1>
        <p>Enter the access token configured by the receiver administrator.</p>
        <label htmlFor="access-token">Access token</label>
        <input
          id="access-token"
          name="token"
          type="password"
          autoComplete="current-password"
          minLength={16}
          required
          autoFocus
          aria-describedby={error ? 'auth-error' : undefined}
        />
        {error ? <p id="auth-error" className="form-error" role="alert">{error}</p> : null}
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? 'Checking…' : 'Open flightmap'}
        </button>
      </form>
    </main>
  )
}

export function App() {
  return (
    <ErrorBoundary>
      <AuthenticationGate>
        <Router>
          <LiveProvider>
            <AppRoutes />
          </LiveProvider>
        </Router>
      </AuthenticationGate>
    </ErrorBoundary>
  )
}
