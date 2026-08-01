import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
  AlertOctagon,
  Bell,
  Check,
  ChevronRight,
  Eye,
  Plane,
  Pencil,
  Plus,
  ShieldAlert,
  Star,
  Trash2,
} from 'lucide-react'
import { api } from '../lib/api'
import { formatDate, formatTime } from '../lib/format'
import { Link } from '../lib/router'
import { useLive } from '../state/LiveContext'
import type { AlertEvent, AlertKind, WatchlistEntry } from '../types'

type AlertStatusFilter = 'active' | 'all' | 'dismissed'
type KindFilter = 'all' | AlertKind

const alertPresentation = {
  emergency: {
    icon: AlertOctagon,
    label: 'Emergency',
    description: 'Emergency state or squawk code',
  },
  watchlist: {
    icon: Star,
    label: 'Watchlist',
    description: 'Aircraft on your watchlist',
  },
  first_seen: {
    icon: Eye,
    label: 'First sighting',
    description: 'Never previously seen by this receiver',
  },
} as const

function AlertCard({
  alert,
  live,
  pending,
  onDismiss,
}: {
  alert: AlertEvent
  live: boolean
  pending: boolean
  onDismiss: () => void
}) {
  const presentation = alertPresentation[alert.type]
  const Icon = presentation.icon
  return (
    <article className={`alert-card alert-${alert.severity} ${alert.dismissedAt ? 'dismissed' : ''}`}>
      <span className="alert-card-icon">
        <Icon size={20} />
      </span>
      <div className="alert-card-body">
        <div className="alert-card-heading">
          <span className="alert-kind">{presentation.label}</span>
          <span className="alert-time">{formatDate(alert.createdAt)} · {formatTime(alert.createdAt)}</span>
        </div>
        <h2>{alert.title}</h2>
        <p>{alert.message}</p>
        <div className="alert-aircraft">
          <Plane size={14} />
          <strong>{alert.callsign || alert.icao.toUpperCase()}</strong>
          <span className="mono">{alert.icao.toUpperCase()}</span>
        </div>
      </div>
      <div className="alert-actions">
        <Link
          className="secondary-button small"
          to={live ? `/?aircraft=${alert.icao}` : `/history?aircraft=${alert.icao}`}
        >
          {live ? 'View live aircraft' : 'Search history'} <ChevronRight size={14} />
        </Link>
        {alert.dismissedAt ? (
          <span className="dismissed-label"><Check size={13} /> Dismissed</span>
        ) : (
          <button className="text-button" type="button" onClick={onDismiss} disabled={pending}>
            {pending ? 'Dismissing…' : 'Dismiss'}
          </button>
        )}
      </div>
    </article>
  )
}

export function AlertsPage() {
  const { alerts, aircraftList, dispatch } = useLive()
  const [statusFilter, setStatusFilter] = useState<AlertStatusFilter>('active')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [bulkPending, setBulkPending] = useState(false)
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([])
  const [watchlistPending, setWatchlistPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [watchDraft, setWatchDraft] = useState({ icao: '', label: '', notes: '' })

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    api
      .alertsPage(true, null, controller.signal)
      .then((page) => {
        dispatch({ type: 'hydrate-alerts', alerts: page.items })
        setNextCursor(page.nextCursor)
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : 'Alerts are unavailable')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [dispatch, retryKey])

  useEffect(() => {
    const controller = new AbortController()
    void api
      .watchlist(controller.signal)
      .then(setWatchlist)
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : 'Watchlist is unavailable')
        }
      })
    return () => controller.abort()
  }, [retryKey])

  const filtered = useMemo(
    () =>
      alerts.filter((alert) => {
        if (statusFilter === 'active' && alert.dismissedAt) return false
        if (statusFilter === 'dismissed' && !alert.dismissedAt) return false
        return kindFilter === 'all' || alert.type === kindFilter
      }),
    [alerts, statusFilter, kindFilter],
  )
  const active = alerts.filter((alert) => !alert.dismissedAt)
  const emergencyCount = active.filter((alert) => alert.type === 'emergency').length
  const watchCount = active.filter((alert) => alert.type === 'watchlist').length
  const liveIcaos = useMemo(() => new Set(aircraftList.map((aircraft) => aircraft.icao)), [aircraftList])

  const loadMore = async () => {
    if (!nextCursor) return
    setLoadingMore(true)
    setError(null)
    try {
      const page = await api.alertsPage(true, nextCursor)
      dispatch({ type: 'hydrate-alerts', alerts: page.items })
      setNextCursor(page.nextCursor)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'More alerts could not be loaded')
    } finally {
      setLoadingMore(false)
    }
  }

  const dismiss = async (alert: AlertEvent) => {
    setPending((current) => new Set(current).add(alert.id))
    setError(null)
    try {
      await api.dismissAlert(alert.id)
      dispatch({ type: 'dismiss-alert', id: alert.id })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Alert could not be dismissed')
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(alert.id)
        return next
      })
    }
  }

  const dismissFiltered = async () => {
    const ids = filtered.filter((alert) => !alert.dismissedAt).map((alert) => alert.id)
    if (!ids.length) return
    setBulkPending(true)
    setError(null)
    try {
      for (let index = 0; index < ids.length; index += 200) {
        const dismissed = await api.dismissAlerts(ids.slice(index, index + 200))
        for (const alert of dismissed) dispatch({ type: 'dismiss-alert', id: alert.id })
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Alerts could not be dismissed')
    } finally {
      setBulkPending(false)
    }
  }

  const saveWatchlist = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const icao = watchDraft.icao.trim().toLowerCase()
    if (!/^[0-9a-f]{6}$/.test(icao)) {
      setError('ICAO must contain exactly six hexadecimal characters.')
      return
    }
    setWatchlistPending(true)
    setError(null)
    const previous = watchlist
    const optimistic: WatchlistEntry = {
      icao,
      label: watchDraft.label.trim() || null,
      notes: watchDraft.notes.trim() || null,
      createdAt: previous.find((entry) => entry.icao === icao)?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    setWatchlist((current) => [optimistic, ...current.filter((entry) => entry.icao !== icao)])
    dispatch({ type: 'watch-state', icao, watched: true })
    try {
      const entry = await api.addWatchlist(
        icao,
        watchDraft.label.trim() || null,
        watchDraft.notes.trim() || null,
      )
      setWatchlist((current) => [entry, ...current.filter((item) => item.icao !== entry.icao)])
      setWatchDraft({ icao: '', label: '', notes: '' })
    } catch (requestError) {
      setWatchlist(previous)
      dispatch({ type: 'watch-state', icao, watched: previous.some((entry) => entry.icao === icao) })
      setError(requestError instanceof Error ? requestError.message : 'Watchlist entry could not be saved')
    } finally {
      setWatchlistPending(false)
    }
  }

  const removeWatchlist = async (icao: string) => {
    setWatchlistPending(true)
    setError(null)
    const previous = watchlist
    setWatchlist((current) => current.filter((entry) => entry.icao !== icao))
    dispatch({ type: 'watch-state', icao, watched: false })
    try {
      await api.removeWatchlist(icao)
    } catch (requestError) {
      setWatchlist(previous)
      dispatch({ type: 'watch-state', icao, watched: true })
      setError(requestError instanceof Error ? requestError.message : 'Watchlist entry could not be removed')
    } finally {
      setWatchlistPending(false)
    }
  }

  return (
    <div className="standard-page alerts-page">
      <header className="standard-page-header">
        <div className="page-heading">
          <span className="eyebrow">RECEIVER EVENTS</span>
          <h1>Alerts</h1>
          <p>Emergency reports, first-ever sightings, and watchlist matches.</p>
        </div>
        <div className="alert-stats">
          <div className="stat-card">
            <span className="stat-icon critical"><ShieldAlert size={18} /></span>
            <span><small>Active</small><strong>{active.length}</strong></span>
          </div>
          <div className="stat-card">
            <span className="stat-icon emergency"><AlertOctagon size={18} /></span>
            <span><small>Emergencies</small><strong>{emergencyCount}</strong></span>
          </div>
          <div className="stat-card">
            <span className="stat-icon watched"><Star size={18} /></span>
            <span><small>Watchlist</small><strong>{watchCount}</strong></span>
          </div>
        </div>
      </header>

      <div className="alerts-toolbar">
        <div className="segmented-control" aria-label="Alert status">
          {(['active', 'all', 'dismissed'] as const).map((option) => (
            <button
              type="button"
              key={option}
              className={statusFilter === option ? 'active' : ''}
              onClick={() => setStatusFilter(option)}
              aria-pressed={statusFilter === option}
            >
              {option[0]?.toUpperCase()}{option.slice(1)}
            </button>
          ))}
        </div>
        <label className="compact-select alert-kind-select">
          <Bell size={14} />
          <select
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value as KindFilter)}
            aria-label="Alert type"
          >
            <option value="all">All alert types</option>
            <option value="emergency">Emergency</option>
            <option value="watchlist">Watchlist</option>
            <option value="first_seen">First sighting</option>
          </select>
        </label>
        {filtered.some((alert) => !alert.dismissedAt) ? (
          <button
            type="button"
            className="secondary-button small"
            disabled={bulkPending}
            onClick={() => void dismissFiltered()}
          >
            <Check size={14} aria-hidden="true" />
            {bulkPending ? 'Dismissing…' : 'Dismiss filtered'}
          </button>
        ) : null}
      </div>

      {error ? <div className="form-error page-error retry-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetryKey((key) => key + 1)}>Retry</button></div> : null}
      <div className="alert-list" aria-live="polite">
        {loading && !alerts.length ? (
          Array.from({ length: 3 }, (_, index) => <div className="alert-card-skeleton" key={index} />)
        ) : filtered.length ? (
          filtered.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              live={liveIcaos.has(alert.icao)}
              pending={pending.has(alert.id)}
              onDismiss={() => void dismiss(alert)}
            />
          ))
        ) : (
          <div className="empty-state large">
            <span className="empty-icon"><Bell size={27} /></span>
            <strong>No {statusFilter === 'all' ? '' : statusFilter} alerts</strong>
            <p>New receiver events will appear here and on the live map.</p>
          </div>
        )}
        {nextCursor ? (
          <button
            type="button"
            className="secondary-button alerts-load-more"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading…' : 'Load more alerts'}
          </button>
        ) : null}
      </div>

      <aside className="alert-rules">
        <span className="eyebrow">ACTIVE RULES</span>
        <h2>What creates an alert?</h2>
        <div>
          {(Object.entries(alertPresentation) as [AlertKind, (typeof alertPresentation)[AlertKind]][]).map(
            ([kind, presentation]) => {
              const Icon = presentation.icon
              return (
                <article key={kind}>
                  <span><Icon size={17} /></span>
                  <div><strong>{presentation.label}</strong><p>{presentation.description}</p></div>
                </article>
              )
            },
          )}
        </div>
        <p className="rules-note">
          Each rule is deduplicated per track session. Alerts follow detailed-history retention.
        </p>

        <section className="watchlist-manager">
          <span className="eyebrow">WATCHLIST</span>
          <h2>Tracked aircraft</h2>
          <form onSubmit={saveWatchlist}>
            <label>
              <span>ICAO hex</span>
              <input name="icao" required maxLength={6} pattern="[0-9A-Fa-f]{6}" placeholder="40621f" value={watchDraft.icao} onChange={(event) => setWatchDraft({ ...watchDraft, icao: event.target.value })} />
            </label>
            <label>
              <span>Label</span>
              <input name="label" maxLength={100} placeholder="Optional name" value={watchDraft.label} onChange={(event) => setWatchDraft({ ...watchDraft, label: event.target.value })} />
            </label>
            <label>
              <span>Notes</span>
              <textarea name="notes" maxLength={1000} rows={2} placeholder="Optional context" value={watchDraft.notes} onChange={(event) => setWatchDraft({ ...watchDraft, notes: event.target.value })} />
            </label>
            <button type="submit" className="secondary-button small" disabled={watchlistPending}>
              <Plus size={14} aria-hidden="true" /> Add or update
            </button>
          </form>
          <div className="watchlist-entries">
            {watchlist.length ? watchlist.map((entry) => (
              <article key={entry.icao}>
                <div>
                  <strong>{entry.label || entry.icao.toUpperCase()}</strong>
                  <span className="mono">{entry.icao.toUpperCase()}</span>
                  {entry.notes ? <p>{entry.notes}</p> : null}
                </div>
                <div className="watchlist-entry-actions">
                  <Link to={`/?aircraft=${entry.icao}`}>Live</Link>
                  <Link to={`/history?aircraft=${entry.icao}`}>History</Link>
                  <button type="button" className="icon-button" aria-label={`Edit ${entry.label || entry.icao}`} disabled={watchlistPending} onClick={() => setWatchDraft({ icao: entry.icao, label: entry.label ?? '', notes: entry.notes ?? '' })}><Pencil size={14} /></button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${entry.label || entry.icao} from watchlist`}
                    disabled={watchlistPending}
                    onClick={() => void removeWatchlist(entry.icao)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              </article>
            )) : <p className="rules-note">No aircraft are currently watched.</p>}
          </div>
        </section>
      </aside>
    </div>
  )
}
