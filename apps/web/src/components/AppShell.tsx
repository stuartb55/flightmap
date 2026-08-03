import { Activity, BarChart3, Bell, Clock3, Map, RadioTower, Settings2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { NavLink, useLocation } from '../lib/router'
import { useLiveStatus } from '../state/LiveContext'
import { KeyboardShortcuts } from './KeyboardShortcuts'

const navigation = [
  { to: '/', label: 'Live', icon: Map, end: true },
  { to: '/history', label: 'History', icon: Clock3 },
  { to: '/insights', label: 'Insights', icon: BarChart3 },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/system', label: 'System', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings2 },
]

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const mainRef = useRef<HTMLElement>(null)
  const { alerts, receiver, connection } = useLiveStatus()
  const activeAlerts = alerts.filter((alert) => !alert.dismissedAt).length
  const receiverState =
    connection === 'live' ? (receiver?.status ?? 'connecting') : connection === 'connecting' ? 'connecting' : connection

  useEffect(() => {
    const page = pathname.startsWith('/aircraft/')
      ? 'Aircraft'
      : navigation.find((item) => item.to === pathname)?.label ?? 'Live'
    document.title = `${page} · Flightmap`
    mainRef.current?.focus({ preventScroll: true })
  }, [pathname])

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="app-header">
        <NavLink className="brand" to="/" aria-label="Flightmap live dashboard">
          <span className="brand-mark" aria-hidden="true">
            <RadioTower size={19} />
          </span>
          <span>
            <strong>FLIGHTMAP</strong>
            <small>ADS-B RECEIVER</small>
          </span>
        </NavLink>

        <nav className="primary-nav" aria-label="Primary">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className="nav-item">
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {label === 'Alerts' && activeAlerts > 0 ? (
                <span className="nav-badge" aria-label={`${activeAlerts} active alerts`}>
                  {activeAlerts > 99 ? '99+' : activeAlerts}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>

        <div className="receiver-actions">
          <KeyboardShortcuts />
          <div className="receiver-chip" title={receiver?.lastSnapshotAt ?? 'Waiting for receiver'}>
            <span className={`status-dot status-${receiverState}`} aria-hidden="true" />
            <span className="receiver-chip-copy">
              <strong>{receiver?.name ?? 'Receiver'}</strong>
              <small>{receiverState}</small>
            </span>
          </div>
        </div>
      </header>

      <main id="main-content" className="app-content" ref={mainRef} tabIndex={-1}>
        {children}
      </main>

      <nav className="mobile-nav" aria-label="Primary">
        {navigation.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="mobile-nav-item">
            <span className="mobile-icon-wrap">
              <Icon size={20} strokeWidth={1.8} />
              {label === 'Alerts' && activeAlerts > 0 ? <span className="mobile-badge" /> : null}
            </span>
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
