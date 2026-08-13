import { type FormEvent, useEffect, useMemo, useState } from 'react'
import type { CustomAlertRule, CustomAlertRuleInput } from '@flightmap/shared'
import {
  AlertOctagon,
  Bell,
  Check,
  ChevronRight,
  Plane,
  Pencil,
  Plus,
  ShieldAlert,
  Star,
  Trash2,
} from 'lucide-react'
import { api } from '../lib/api'
import { formatDate, formatDateTimeInput, formatTime } from '../lib/format'
import { Link } from '../lib/router'
import { useLiveAircraft, useLiveDispatch, useLiveStatus } from '../state/LiveContext'
import type { AlertEvent, AlertKind, WatchlistEntry } from '../types'

type AlertStatusFilter = 'active' | 'all' | 'dismissed'
type KindFilter = 'all' | AlertKind
type RuleDraft = {
  name: string
  severity: 'info' | 'warning' | 'critical'
  callsignPrefix: string
  icao: string
  operator: string
  typeCode: string
  minimumAltitudeFt: string
  maximumAltitudeFt: string
  minimumDistanceNm: string
  maximumDistanceNm: string
  cooldownMinutes: string
}
const EMPTY_RULE_DRAFT: RuleDraft = { name: '', severity: 'warning', callsignPrefix: '', icao: '', operator: '', typeCode: '', minimumAltitudeFt: '', maximumAltitudeFt: '', minimumDistanceNm: '', maximumDistanceNm: '', cooldownMinutes: '0' }

const alertPresentation = {
  emergency: {
    icon: AlertOctagon,
    label: 'Emergency',
    description: 'Emergency states and squawk codes 7500, 7600, or 7700',
  },
  watchlist: {
    icon: Star,
    label: 'Watchlist',
    description: 'Aircraft you have explicitly chosen to track',
  },
  custom: {
    icon: Bell,
    label: 'Custom rule',
    description: 'Installation-wide identity, altitude, and receiver-distance conditions',
  },
} as const

/*
 * The window an alert's history link opens, either side of the event. It is
 * lopsided because the two sides are not doing the same job: sessions are
 * matched on the moment they started and a session always starts before the
 * alert it raises, so the lead is what decides whether the track is found at
 * all and the trail only buys some context around it. Nothing bounds how long
 * a session runs — the gap setting decides when the next one begins, not when
 * this one ends — so the lead is a day rather than a guess at flight length.
 */
const ALERT_HISTORY_LEAD_MS = 24 * 60 * 60_000
const ALERT_HISTORY_TRAIL_MS = 60 * 60_000

/**
 * History searches default to the last six hours, which is the right window for
 * someone arriving at the page and the wrong one for someone arriving from an
 * alert: an alert is by definition already in the past, and one older than the
 * default landed on "no sessions found" for a track that was in the database
 * the whole time. The link carries a window around the event instead.
 */
export function alertHistorySearch(icao: string, createdAt: string, now = new Date()): string {
  const occurred = new Date(createdAt)
  if (Number.isNaN(occurred.getTime())) return `/history?aircraft=${encodeURIComponent(icao)}`
  const from = new Date(occurred.getTime() - ALERT_HISTORY_LEAD_MS)
  const until = new Date(Math.min(occurred.getTime() + ALERT_HISTORY_TRAIL_MS, now.getTime()))
  const params = new URLSearchParams({
    aircraft: icao,
    from: formatDateTimeInput(from),
    to: formatDateTimeInput(until),
  })
  return `/history?${params.toString()}`
}

/**
 * Alerts read as a stream of events rather than a flat pile of cards, and a
 * stream needs to say when. The day is a heading over the run rather than a
 * date repeated on every entry, which leaves each entry carrying only the
 * clock time — the part that differs.
 */
export function groupByDay(alerts: AlertEvent[]): [label: string, entries: AlertEvent[]][] {
  const today = formatDate(new Date().toISOString())
  const yesterday = formatDate(new Date(Date.now() - 86_400_000).toISOString())
  const groups = new Map<string, AlertEvent[]>()
  for (const alert of alerts) {
    const date = formatDate(alert.createdAt)
    const label = date === today ? 'Today' : date === yesterday ? 'Yesterday' : date
    const existing = groups.get(label)
    if (existing) existing.push(alert)
    else groups.set(label, [alert])
  }
  return [...groups]
}

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
          <span className="alert-time">
            {/* Dropped where a day heading above the run already says it. */}
            <span className="alert-date">{formatDate(alert.createdAt)} · </span>
            {formatTime(alert.createdAt)}
          </span>
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
        <Link className="secondary-button small" to={`/aircraft/${alert.icao}`}>Profile</Link>
        <Link
          className="secondary-button small"
          to={
            live
              ? `/?aircraft=${encodeURIComponent(alert.icao)}`
              : alertHistorySearch(alert.icao, alert.createdAt)
          }
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
  const { alerts } = useLiveStatus()
  const { aircraftList } = useLiveAircraft()
  const dispatch = useLiveDispatch()
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
  const [customRules, setCustomRules] = useState<CustomAlertRule[]>([])
  const [rulePending, setRulePending] = useState(false)
  const [rulePreview, setRulePreview] = useState<Awaited<ReturnType<typeof api.previewCustomAlertRule>> | null>(null)
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(EMPTY_RULE_DRAFT)

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

  useEffect(() => {
    const controller = new AbortController()
    void api.customAlertRules(controller.signal).then(setCustomRules).catch((requestError) => {
      if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : 'Custom alert rules are unavailable')
    })
    return () => controller.abort()
  }, [retryKey])

  const ruleInput = (): CustomAlertRuleInput => {
    const optionalNumber = (value: string) => value.trim() === '' ? null : Number(value)
    return {
      name: ruleDraft.name.trim(),
      enabled: editingRuleId ? customRules.find((rule) => rule.id === editingRuleId)?.enabled ?? true : true,
      severity: ruleDraft.severity,
      callsignPrefix: ruleDraft.callsignPrefix.trim() || null,
      icao: ruleDraft.icao.trim().toLowerCase() || null,
      operator: ruleDraft.operator.trim() || null,
      typeCode: ruleDraft.typeCode.trim() || null,
      minimumAltitudeFt: optionalNumber(ruleDraft.minimumAltitudeFt),
      maximumAltitudeFt: optionalNumber(ruleDraft.maximumAltitudeFt),
      minimumDistanceNm: optionalNumber(ruleDraft.minimumDistanceNm),
      maximumDistanceNm: optionalNumber(ruleDraft.maximumDistanceNm),
      cooldownMinutes: Number(ruleDraft.cooldownMinutes || 0),
    }
  }

  const saveRule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setRulePending(true)
    setError(null)
    try {
      const saved = editingRuleId
        ? await api.updateCustomAlertRule(editingRuleId, ruleInput())
        : await api.createCustomAlertRule(ruleInput())
      setCustomRules((current) => [saved, ...current.filter((rule) => rule.id !== saved.id)])
      setRuleDraft(EMPTY_RULE_DRAFT)
      setRulePreview(null)
      setEditingRuleId(null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Alert rule could not be saved')
    } finally { setRulePending(false) }
  }

  const previewRule = async () => {
    setRulePending(true)
    setError(null)
    try { setRulePreview(await api.previewCustomAlertRule(ruleInput())) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Rule preview failed') }
    finally { setRulePending(false) }
  }

  const editRule = (rule: CustomAlertRule) => {
    setEditingRuleId(rule.id)
    setRuleDraft({
      name: rule.name, severity: rule.severity, callsignPrefix: rule.callsignPrefix ?? '', icao: rule.icao ?? '', operator: rule.operator ?? '', typeCode: rule.typeCode ?? '',
      minimumAltitudeFt: rule.minimumAltitudeFt?.toString() ?? '', maximumAltitudeFt: rule.maximumAltitudeFt?.toString() ?? '', minimumDistanceNm: rule.minimumDistanceNm?.toString() ?? '', maximumDistanceNm: rule.maximumDistanceNm?.toString() ?? '', cooldownMinutes: rule.cooldownMinutes.toString(),
    })
  }

  const toggleRule = async (rule: CustomAlertRule) => {
    const enabled = !rule.enabled
    setError(null)
    setCustomRules((current) => current.map((item) => item.id === rule.id ? { ...item, enabled } : item))
    try {
      const updated = await api.updateCustomAlertRule(rule.id, { enabled })
      setCustomRules((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (requestError) {
      setCustomRules((current) => current.map((item) => item.id === rule.id ? { ...item, enabled: rule.enabled } : item))
      setError(requestError instanceof Error ? requestError.message : 'Rule could not be updated')
    }
  }

  const deleteRule = async (id: string) => {
    setRulePending(true)
    try { await api.deleteCustomAlertRule(id); setCustomRules((current) => current.filter((rule) => rule.id !== id)) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Alert rule could not be deleted') }
    finally { setRulePending(false) }
  }

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
          <p>Events that may need attention: emergency reports and watchlist matches.</p>
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
          groupByDay(filtered).map(([day, entries]) => (
            <section className="alert-day" key={day} aria-label={day}>
              <h2 className="alert-day-label">{day}</h2>
              {entries.map((alert) => (
                <AlertCard
                  key={alert.id}
                  alert={alert}
                  live={liveIcaos.has(alert.icao)}
                  pending={pending.has(alert.id)}
                  onDismiss={() => void dismiss(alert)}
                />
              ))}
            </section>
          ))
        ) : (
          <div className="empty-state large">
            <span className="empty-icon"><Bell size={27} /></span>
            <strong>No {statusFilter === 'all' ? '' : statusFilter} alerts</strong>
            <p>Emergency reports and watchlist matches will appear here.</p>
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
          New aircraft are recorded in receiver history without creating an alert. Alert rules are
          deduplicated per track session and follow detailed-history retention.
        </p>

        <section className="custom-rule-manager">
          <span className="eyebrow">CUSTOM RULES</span>
          <h2>Match aircraft conditions</h2>
          <p className="rules-note">Every filled condition must match. Alerts stay inside Flightmap.</p>
          <form onSubmit={saveRule}>
            <label className="rule-name"><span>Rule name</span><input required maxLength={80} value={ruleDraft.name} onChange={(event) => setRuleDraft({ ...ruleDraft, name: event.target.value })} /></label>
            <label><span>Severity</span><select value={ruleDraft.severity} onChange={(event) => setRuleDraft({ ...ruleDraft, severity: event.target.value as typeof ruleDraft.severity })}><option value="info">Information</option><option value="warning">Warning</option><option value="critical">Critical</option></select></label>
            <label><span>ICAO</span><input maxLength={6} pattern="[0-9A-Fa-f]{6}" value={ruleDraft.icao} onChange={(event) => setRuleDraft({ ...ruleDraft, icao: event.target.value })} /></label>
            <label><span>Callsign prefix</span><input maxLength={16} value={ruleDraft.callsignPrefix} onChange={(event) => setRuleDraft({ ...ruleDraft, callsignPrefix: event.target.value })} /></label>
            <label><span>Operator contains</span><input maxLength={128} value={ruleDraft.operator} onChange={(event) => setRuleDraft({ ...ruleDraft, operator: event.target.value })} /></label>
            <label><span>Type code</span><input maxLength={16} value={ruleDraft.typeCode} onChange={(event) => setRuleDraft({ ...ruleDraft, typeCode: event.target.value })} /></label>
            <label><span>Minimum altitude (ft)</span><input type="number" value={ruleDraft.minimumAltitudeFt} onChange={(event) => setRuleDraft({ ...ruleDraft, minimumAltitudeFt: event.target.value })} /></label>
            <label><span>Maximum altitude (ft)</span><input type="number" value={ruleDraft.maximumAltitudeFt} onChange={(event) => setRuleDraft({ ...ruleDraft, maximumAltitudeFt: event.target.value })} /></label>
            <label><span>Minimum distance (nm)</span><input type="number" min={0} step="any" value={ruleDraft.minimumDistanceNm} onChange={(event) => setRuleDraft({ ...ruleDraft, minimumDistanceNm: event.target.value })} /></label>
            <label><span>Maximum distance (nm)</span><input type="number" min={0} step="any" value={ruleDraft.maximumDistanceNm} onChange={(event) => setRuleDraft({ ...ruleDraft, maximumDistanceNm: event.target.value })} /></label>
            <label><span>Cooldown (minutes)</span><input type="number" min={0} max={10080} value={ruleDraft.cooldownMinutes} onChange={(event) => setRuleDraft({ ...ruleDraft, cooldownMinutes: event.target.value })} /></label>
            <div className="custom-rule-actions"><button type="button" className="secondary-button small" disabled={rulePending} onClick={() => void previewRule()}>Preview matches</button><button type="submit" className="primary-button small" disabled={rulePending}>{editingRuleId ? 'Update rule' : 'Create rule'}</button></div>
          </form>
          {rulePreview ? <p className="rule-preview" role="status">{rulePreview.matches.length ? `${rulePreview.matches.length} current aircraft match: ${rulePreview.matches.slice(0, 5).map((match) => match.callsign || match.registration || match.icao.toUpperCase()).join(', ')}` : 'No current aircraft match this rule.'}</p> : null}
          <div className="custom-rule-list">{customRules.map((rule) => <article key={rule.id}><div><strong>{rule.name}</strong><small>{rule.severity} · {rule.cooldownMinutes ? `${rule.cooldownMinutes} min cooldown` : 'once per encounter'}</small></div><label className="rule-enabled"><span>{rule.enabled ? 'Enabled' : 'Disabled'}</span><input type="checkbox" checked={rule.enabled} disabled={rulePending} onChange={() => void toggleRule(rule)} /></label><button type="button" className="icon-button" aria-label={`Edit ${rule.name}`} onClick={() => editRule(rule)}><Pencil size={14} /></button><button type="button" className="icon-button" aria-label={`Delete ${rule.name}`} onClick={() => void deleteRule(rule.id)}><Trash2 size={14} /></button></article>)}</div>
        </section>

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
