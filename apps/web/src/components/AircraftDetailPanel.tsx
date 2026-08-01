import { type FormEvent, useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  Compass,
  Gauge,
  MapPin,
  Plane,
  Radio,
  Star,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { Link } from '../lib/router'
import {
  aircraftLabel,
  formatAltitude,
  formatBearing,
  formatDateTime,
  formatDateTimeInput,
  formatDistance,
  formatSpeed,
  formatVerticalRate,
} from '../lib/format'
import { useLive } from '../state/LiveContext'
import type { Aircraft, AircraftDetail } from '../types'

interface Props {
  aircraft: Aircraft
  onClose: () => void
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Gauge
  label: string
  value: string
}) {
  return (
    <div className="detail-metric">
      <Icon size={15} aria-hidden="true" />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
    </div>
  )
}

export function AircraftDetailPanel({ aircraft, onClose }: Props) {
  const { dispatch } = useLive()
  const [detail, setDetail] = useState<AircraftDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [watchPending, setWatchPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setDetail(null)
    setError(null)
    api
      .aircraft(aircraft.icao, controller.signal)
      .then(setDetail)
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : 'Details are unavailable')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [aircraft.icao])

  const toggleWatch = async () => {
    const watched = !aircraft.watched
    setWatchPending(true)
    dispatch({ type: 'watch-state', icao: aircraft.icao, watched })
    try {
      if (watched) {
        const entry = await api.addWatchlist(aircraft.icao, watchFields.label, watchFields.notes)
        const next = { label: entry.label ?? '', notes: entry.notes ?? '' }
        setWatchFields(next)
        setSavedWatchFields(next)
      }
      else await api.removeWatchlist(aircraft.icao)
    } catch (requestError) {
      dispatch({ type: 'watch-state', icao: aircraft.icao, watched: !watched })
      setError(requestError instanceof Error ? requestError.message : 'Watchlist update failed')
    } finally {
      setWatchPending(false)
    }
  }

  const [watchFields, setWatchFields] = useState({ label: '', notes: '' })
  const [savedWatchFields, setSavedWatchFields] = useState({ label: '', notes: '' })

  useEffect(() => {
    if (!aircraft.watched) return
    const controller = new AbortController()
    void api.watchlist(controller.signal).then((entries) => {
      const entry = entries.find((item) => item.icao === aircraft.icao)
      if (!entry) return
      const fields = { label: entry.label ?? '', notes: entry.notes ?? '' }
      setWatchFields(fields)
      setSavedWatchFields(fields)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [aircraft.icao, aircraft.watched])

  const saveWatchDetails = async (event: FormEvent) => {
    event.preventDefault()
    const previous = savedWatchFields
    const wasWatched = aircraft.watched
    setWatchPending(true)
    setSavedWatchFields(watchFields)
    if (!wasWatched) dispatch({ type: 'watch-state', icao: aircraft.icao, watched: true })
    try {
      const entry = await api.addWatchlist(aircraft.icao, watchFields.label, watchFields.notes)
      const fields = { label: entry.label ?? '', notes: entry.notes ?? '' }
      setWatchFields(fields)
      setSavedWatchFields(fields)
    } catch (requestError) {
      setWatchFields(previous)
      setSavedWatchFields(previous)
      if (!wasWatched) dispatch({ type: 'watch-state', icao: aircraft.icao, watched: false })
      setError(requestError instanceof Error ? requestError.message : 'Watchlist details could not be saved')
    } finally {
      setWatchPending(false)
    }
  }

  const metadata = detail?.metadata
  const summary = detail?.summary
  const positionAvailable = aircraft.latitude != null && aircraft.longitude != null

  return (
    <aside className="detail-panel" aria-label={`${aircraftLabel(aircraft)} aircraft details`}>
      <div className={`detail-hero ${aircraft.hasActiveAlert ? 'detail-hero-alert' : ''}`}>
        <div className="panel-title-row">
          <span className="aircraft-category-icon" aria-hidden="true">
            <Plane size={23} />
          </span>
          <div className="detail-identity">
            <span className="eyebrow">{aircraft.typeCode || 'AIRCRAFT'}</span>
            <h2>{aircraftLabel(aircraft)}</h2>
            <p>
              {aircraft.registration || aircraft.icao.toUpperCase()}
              {aircraft.country ? ` · ${aircraft.country}` : ''}
            </p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close details">
            <X size={18} />
          </button>
        </div>

        <button
          className={`watch-button ${aircraft.watched ? 'active' : ''}`}
          type="button"
          onClick={toggleWatch}
          disabled={watchPending}
          aria-pressed={aircraft.watched}
        >
          <Star size={16} fill={aircraft.watched ? 'currentColor' : 'none'} />
          {aircraft.watched ? 'On watchlist' : 'Add to watchlist'}
        </button>
        <div className="aircraft-workflow-links">
          <Link to={`/?aircraft=${encodeURIComponent(aircraft.icao)}`}>Live</Link>
          <Link to={`/history?aircraft=${encodeURIComponent(aircraft.icao)}`}>History</Link>
        </div>
        {aircraft.watched ? (
          <form className="watchlist-detail-editor" onSubmit={saveWatchDetails}>
            <label><span>Watchlist label</span><input value={watchFields.label} maxLength={100} onChange={(event) => setWatchFields({ ...watchFields, label: event.target.value })} placeholder="Optional name" /></label>
            <label><span>Notes</span><textarea value={watchFields.notes} maxLength={1000} rows={2} onChange={(event) => setWatchFields({ ...watchFields, notes: event.target.value })} placeholder="Optional context" /></label>
            <button type="submit" className="secondary-button small" disabled={watchPending || (watchFields.label === savedWatchFields.label && watchFields.notes === savedWatchFields.notes)}>Save watchlist details</button>
          </form>
        ) : null}
      </div>

      {aircraft.hasActiveAlert ? (
        <div className="inline-alert critical">
          <AlertTriangle size={17} />
          <span>
            <strong>Active aircraft alert</strong>
            <small>
              {aircraft.emergency && aircraft.emergency !== 'none'
                ? aircraft.emergency
                : aircraft.squawk
                  ? `Squawk ${aircraft.squawk}`
                  : 'Watchlist rule matched'}
            </small>
          </span>
        </div>
      ) : null}

      {!positionAvailable ? (
        <div className="inline-alert neutral">
          <MapPin size={17} />
          <span>
            <strong>No current position</strong>
            <small>This aircraft remains visible from non-position messages.</small>
          </span>
        </div>
      ) : null}

      <section className="detail-section">
        <div className="section-heading">
          <h3>Live telemetry</h3>
          <span>{aircraft.seenSeconds == null ? 'Unknown age' : `${Math.round(aircraft.seenSeconds)}s ago`}</span>
        </div>
        <div className="metric-grid">
          <Metric icon={Gauge} label="Barometric altitude" value={formatAltitude(aircraft.altitudeBaro)} />
          <Metric icon={Activity} label="Ground speed" value={formatSpeed(aircraft.groundSpeed)} />
          <Metric icon={Compass} label="Track" value={formatBearing(aircraft.track)} />
          <Metric icon={ArrowDownRight} label="Vertical rate" value={formatVerticalRate(aircraft.verticalRate)} />
          <Metric icon={MapPin} label="Receiver range" value={formatDistance(aircraft.distanceNm)} />
          <Metric icon={Radio} label="Signal" value={aircraft.rssi == null ? '—' : `${aircraft.rssi.toFixed(1)} dBFS`} />
        </div>
      </section>

      <section className="detail-section">
        <div className="section-heading">
          <h3>Navigation & quality</h3>
        </div>
        <dl className="property-list">
          <div><dt>Geometric altitude</dt><dd>{formatAltitude(aircraft.altitudeGeom)}</dd></div>
          <div><dt>True airspeed</dt><dd>{formatSpeed(aircraft.trueAirspeed)}</dd></div>
          <div><dt>Indicated airspeed</dt><dd>{formatSpeed(aircraft.indicatedAirspeed)}</dd></div>
          <div><dt>Selected altitude</dt><dd>{formatAltitude(aircraft.navigation.altitude)}</dd></div>
          <div><dt>Selected heading</dt><dd>{formatBearing(aircraft.navigation.heading)}</dd></div>
          <div><dt>QNH</dt><dd>{aircraft.navigation.qnh == null ? '—' : `${aircraft.navigation.qnh.toFixed(1)} hPa`}</dd></div>
          <div><dt>Squawk</dt><dd className={['7500', '7600', '7700'].includes(aircraft.squawk ?? '') ? 'danger-text' : ''}>{aircraft.squawk ?? '—'}</dd></div>
          <div><dt>Source</dt><dd>{aircraft.source?.toUpperCase() ?? '—'}</dd></div>
          <div><dt>Messages</dt><dd>{aircraft.messages?.toLocaleString('en-GB') ?? '—'}</dd></div>
          <div><dt>Receiver bearing</dt><dd>{formatBearing(aircraft.bearing)}</dd></div>
          <div><dt>NIC / NACp</dt><dd>{aircraft.quality.nic ?? '—'} / {aircraft.quality.nacP ?? '—'}</dd></div>
          <div><dt>NACv / SIL</dt><dd>{aircraft.quality.nacV ?? '—'} / {aircraft.quality.sil ?? '—'}</dd></div>
          <div><dt>Containment radius</dt><dd>{aircraft.quality.rcMetres == null ? '—' : `${Math.round(aircraft.quality.rcMetres)} m`}</dd></div>
          <div><dt>ADS-B version</dt><dd>{aircraft.quality.adsbVersion ?? '—'}</dd></div>
        </dl>
      </section>

      <section className="detail-section">
        <div className="section-heading">
          <h3>Aircraft identity</h3>
          {loading ? <span>Loading…</span> : null}
        </div>
        <dl className="property-list">
          <div><dt>ICAO address</dt><dd className="mono">{aircraft.icao.toUpperCase()}</dd></div>
          <div><dt>Registration</dt><dd>{metadata?.registration ?? aircraft.registration ?? '—'}</dd></div>
          <div><dt>Type</dt><dd>{metadata?.description ?? aircraft.description ?? '—'}</dd></div>
          <div><dt>Operator</dt><dd>{metadata?.operator ?? aircraft.operator ?? '—'}</dd></div>
          <div><dt>Owner</dt><dd>{metadata?.owner ?? '—'}</dd></div>
          <div><dt>Country</dt><dd>{metadata?.country ?? aircraft.country ?? '—'}</dd></div>
        </dl>
      </section>

      <section className="detail-section">
        <div className="section-heading"><h3>Receiver history</h3></div>
        <dl className="property-list">
          <div><dt>First seen</dt><dd>{formatDateTime(summary?.firstSeenAt ?? aircraft.firstSeenAt)}</dd></div>
          <div><dt>Last seen</dt><dd>{formatDateTime(summary?.lastSeenAt ?? aircraft.lastSeenAt)}</dd></div>
          <div><dt>Observations</dt><dd>{summary?.observationCount?.toLocaleString('en-GB') ?? '—'}</dd></div>
          <div><dt>Track sessions</dt><dd>{summary?.sessionCount?.toLocaleString('en-GB') ?? '—'}</dd></div>
          <div><dt>Closest approach</dt><dd>{formatDistance(summary?.closestDistanceNm)}</dd></div>
        </dl>
        {detail?.recentSessions.length ? (
          <div className="recent-session-links">
            <strong>Recent tracks</strong>
            {detail.recentSessions.slice(0, 5).map((session) => (
              <Link
                key={session.id}
                to={`/history?q=${encodeURIComponent(aircraft.icao)}&from=${encodeURIComponent(
                  formatDateTimeInput(new Date(session.startedAt)),
                )}&to=${encodeURIComponent(
                  formatDateTimeInput(
                    new Date(session.endedAt ?? aircraft.lastSeenAt ?? session.startedAt),
                  ),
                )}&session=${encodeURIComponent(session.id)}`}
              >
                <span>{formatDateTime(session.startedAt)}</span>
                <small>{session.sampleCount.toLocaleString('en-GB')} samples</small>
              </Link>
            ))}
          </div>
        ) : null}
      </section>

      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </aside>
  )
}
