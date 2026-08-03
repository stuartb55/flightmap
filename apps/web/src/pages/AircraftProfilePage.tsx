import { useEffect, useMemo, useState } from 'react'
import type { AircraftActivityResponse } from '@flightmap/shared'
import { Activity, CalendarDays, Clock3, MapPin, Plane, Radio, Star } from 'lucide-react'
import { api } from '../lib/api'
import { formatAltitude, formatDate, formatDateTime, formatDistance } from '../lib/format'
import { useUnitPreferences } from '../lib/unit-preferences'
import { Link, useLocation } from '../lib/router'
import type { AircraftDetail } from '../types'

type Preset = '30d' | '90d' | '1y' | 'all'

function rangeForPreset(preset: Preset, firstSeen?: string | null) {
  const to = new Date()
  const from = new Date(to)
  if (preset === '30d') from.setUTCDate(from.getUTCDate() - 30)
  else if (preset === '90d') from.setUTCDate(from.getUTCDate() - 90)
  else if (preset === '1y') from.setUTCFullYear(from.getUTCFullYear() - 1)
  else from.setTime(firstSeen ? Date.parse(firstSeen) : Date.parse('2000-01-01T00:00:00.000Z'))
  return { from: from.toISOString(), to: to.toISOString(), bucket: preset === 'all' ? 'month' as const : 'day' as const }
}

function ActivityBars({ activity }: { activity: AircraftActivityResponse }) {
  const maximum = Math.max(1, ...activity.series.map((point) => point.observations))
  return (
    <div className="aircraft-activity-chart" role="img" aria-label="Aircraft observations over time">
      {activity.series.map((point) => (
        <span
          key={point.bucketStart}
          style={{ height: `${Math.max(3, (point.observations / maximum) * 100)}%` }}
          title={`${formatDate(point.bucketStart)}: ${point.observations.toLocaleString('en-GB')} observations`}
        />
      ))}
    </div>
  )
}

export function AircraftProfilePage() {
  useUnitPreferences()
  const { pathname } = useLocation()
  const icao = pathname.split('/').at(-1)?.toLowerCase() ?? ''
  const [detail, setDetail] = useState<AircraftDetail | null>(null)
  const [activity, setActivity] = useState<AircraftActivityResponse | null>(null)
  const [preset, setPreset] = useState<Preset>('90d')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [watchPending, setWatchPending] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void api.aircraft(icao, controller.signal).then((response) => {
      setDetail(response)
      setError(null)
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Aircraft could not be loaded')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [icao])

  const firstSeen = detail?.summary?.firstSeenAt ?? detail?.aircraft?.firstSeenAt
  useEffect(() => {
    const controller = new AbortController()
    const range = rangeForPreset(preset, firstSeen)
    void api.aircraftActivity(icao, range, controller.signal).then(setActivity).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Activity could not be loaded')
    })
    return () => controller.abort()
  }, [firstSeen, icao, preset])

  const aircraft = detail?.aircraft
  const metadata = detail?.metadata
  const identity = aircraft?.callsign?.trim() || metadata?.registration || icao.toUpperCase()
  const watched = aircraft?.watched ?? false
  const callsigns = useMemo(() => activity?.callsigns.slice(0, 12) ?? [], [activity])

  const toggleWatch = async () => {
    setWatchPending(true)
    try {
      if (watched) await api.removeWatchlist(icao)
      else await api.addWatchlist(icao)
      const next = await api.aircraft(icao)
      setDetail(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Watchlist could not be updated')
    } finally {
      setWatchPending(false)
    }
  }

  if (loading) return <div className="standard-page profile-loading" role="status">Loading aircraft profile…</div>
  if (!detail) return <div className="standard-page"><div className="empty-state"><Plane size={28} /><h1>Aircraft not found</h1><p>{error}</p><Link to="/history">Search history</Link></div></div>

  return (
    <div className="standard-page aircraft-profile-page">
      <header className="aircraft-profile-hero">
        <div className="profile-plane"><Plane size={30} /></div>
        <div>
          <span className="eyebrow">AIRCRAFT PROFILE</span>
          <h1>{identity}</h1>
          <p>{metadata?.registration || icao.toUpperCase()} · {metadata?.description || metadata?.typeCode || 'Unknown type'}{metadata?.operator ? ` · ${metadata.operator}` : ''}</p>
        </div>
        <div className="aircraft-profile-actions">
          <button type="button" className={`watch-button ${watched ? 'active' : ''}`} disabled={watchPending} onClick={() => void toggleWatch()}><Star size={16} fill={watched ? 'currentColor' : 'none'} />{watched ? 'On watchlist' : 'Add to watchlist'}</button>
          {aircraft ? <Link className="primary-button" to={`/?aircraft=${encodeURIComponent(icao)}`}><Radio size={15} /> View live</Link> : null}
          <Link className="secondary-button" to={`/history?icao=${encodeURIComponent(icao)}`}><Clock3 size={15} /> History</Link>
        </div>
      </header>

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <section className="profile-stat-grid" aria-label="Lifetime aircraft statistics">
        <article><Activity size={18} /><span><small>Observations</small><strong>{detail.summary?.observationCount?.toLocaleString('en-GB') ?? '—'}</strong></span></article>
        <article><Plane size={18} /><span><small>Track sessions</small><strong>{detail.summary?.sessionCount?.toLocaleString('en-GB') ?? '—'}</strong></span></article>
        <article><MapPin size={18} /><span><small>Closest approach</small><strong>{formatDistance(detail.summary?.closestDistanceNm)}</strong></span></article>
        <article><CalendarDays size={18} /><span><small>First seen</small><strong>{formatDateTime(firstSeen ?? null)}</strong></span></article>
      </section>

      <section className="aircraft-profile-panel">
        <header>
          <div><span className="eyebrow">RECEIVER ACTIVITY</span><h2>Sighting frequency</h2></div>
          <div className="preset-tabs" role="group" aria-label="Aircraft activity range">
            {(['30d', '90d', '1y', 'all'] as const).map((value) => <button key={value} type="button" aria-pressed={preset === value} onClick={() => setPreset(value)}>{value === 'all' ? 'All time' : value === '1y' ? '1 year' : value.replace('d', ' days')}</button>)}
          </div>
        </header>
        {activity?.series.length ? <ActivityBars activity={activity} /> : <div className="empty-state compact">No activity in this range.</div>}
        {activity ? (
          <dl className="profile-range-summary">
            <div><dt>Active days</dt><dd>{activity.totals.activeDays.toLocaleString('en-GB')}</dd></div>
            <div><dt>Observations</dt><dd>{activity.totals.observations.toLocaleString('en-GB')}</dd></div>
            <div><dt>Highest observed</dt><dd>{formatAltitude(activity.totals.maximumAltitudeFt)}</dd></div>
            <div><dt>Closest observed</dt><dd>{formatDistance(activity.totals.closestRangeNm)}</dd></div>
          </dl>
        ) : null}
      </section>

      <div className="aircraft-profile-columns">
        <section className="aircraft-profile-panel">
          <header><div><span className="eyebrow">IDENTITY</span><h2>Known details</h2></div></header>
          <dl className="property-list">
            <div><dt>ICAO address</dt><dd className="mono">{icao.toUpperCase()}</dd></div>
            <div><dt>Registration</dt><dd>{metadata?.registration ?? '—'}</dd></div>
            <div><dt>Type</dt><dd>{metadata?.description ?? metadata?.typeCode ?? '—'}</dd></div>
            <div><dt>Operator</dt><dd>{metadata?.operator ?? '—'}</dd></div>
            <div><dt>Owner</dt><dd>{metadata?.owner ?? '—'}</dd></div>
            <div><dt>Country</dt><dd>{metadata?.country ?? '—'}</dd></div>
          </dl>
          {callsigns.length ? <div className="callsign-cloud"><strong>Observed callsigns</strong><div>{callsigns.map((callsign) => <span key={callsign}>{callsign}</span>)}</div></div> : null}
        </section>

        <section className="aircraft-profile-panel">
          <header><div><span className="eyebrow">RECENT</span><h2>Track sessions</h2></div></header>
          <div className="profile-session-list">
            {detail.recentSessions.length ? detail.recentSessions.map((session) => (
              <Link key={session.id} to={`/history?icao=${icao}&from=${encodeURIComponent(session.startedAt)}&to=${encodeURIComponent(session.endedAt ?? new Date().toISOString())}&session=${session.id}`}>
                <span><strong>{formatDateTime(session.startedAt)}</strong><small>{session.sampleCount.toLocaleString('en-GB')} samples</small></span>
                <span>{formatAltitude(session.maximumAltitudeFt)}</span>
              </Link>
            )) : <div className="empty-state compact">No retained detailed sessions.</div>}
          </div>
        </section>
      </div>
    </div>
  )
}
