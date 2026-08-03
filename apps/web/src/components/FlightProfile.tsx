import { useMemo, useState, type PointerEvent } from 'react'
import { Activity, Gauge, MapPin, MoveVertical } from 'lucide-react'
import {
  formatAltitude,
  formatDistance,
  formatSpeed,
  formatTime,
  formatVerticalRateValue,
} from '../lib/format'
import { useUnitPreferences } from '../lib/unit-preferences'
import type { TrackPoint, TrackResponse } from '../types'

type Metric = 'altitude' | 'speed' | 'verticalRate' | 'distance'

const metrics: Record<Metric, {
  label: string
  icon: typeof Activity
  value: (point: TrackPoint) => number | null
  format: (value: number | null) => string
}> = {
  altitude: {
    label: 'Altitude',
    icon: Activity,
    value: (point) => point.altitudeFt,
    format: formatAltitude,
  },
  speed: {
    label: 'Speed',
    icon: Gauge,
    value: (point) => point.groundSpeedKt,
    format: formatSpeed,
  },
  verticalRate: {
    label: 'Vertical rate',
    icon: MoveVertical,
    value: (point) => point.verticalRateFpm ?? null,
    format: formatVerticalRateValue,
  },
  distance: {
    label: 'Receiver distance',
    icon: MapPin,
    value: (point) => point.distanceNm ?? null,
    format: formatDistance,
  },
}

function nearestPoint(points: TrackPoint[], time: number): TrackPoint | null {
  if (!points.length) return null
  let low = 0
  let high = points.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (Date.parse(points[middle]!.recordedAt) < time) low = middle + 1
    else high = middle
  }
  const current = points[low]!
  const previous = points[Math.max(0, low - 1)]!
  return Math.abs(Date.parse(previous.recordedAt) - time) <= Math.abs(Date.parse(current.recordedAt) - time)
    ? previous
    : current
}

export function FlightProfile({
  track,
  replayTime,
  onReplayTime,
}: {
  track: TrackResponse
  replayTime: number | null
  onReplayTime: (time: number) => void
}) {
  useUnitPreferences()
  const [metric, setMetric] = useState<Metric>('altitude')
  const definition = metrics[metric]
  const bounds = useMemo(() => {
    const points = track.points
    const start = Date.parse(points[0]?.recordedAt ?? track.session.startedAt)
    const end = Date.parse(points.at(-1)?.recordedAt ?? track.session.endedAt ?? track.session.startedAt)
    const values = points.map(definition.value).filter((value): value is number => value != null && Number.isFinite(value))
    const minimum = values.length ? Math.min(...values) : 0
    const maximum = values.length ? Math.max(...values) : 1
    return { start, end: Math.max(start + 1, end), minimum, maximum: Math.max(minimum + 1, maximum) }
  }, [definition, track])
  const width = 900
  const height = 180
  const chartTop = 14
  const chartBottom = 150
  const path = useMemo(() => track.points.flatMap((point) => {
    const value = definition.value(point)
    if (value == null) return []
    const x = ((Date.parse(point.recordedAt) - bounds.start) / (bounds.end - bounds.start)) * width
    const y = chartBottom - ((value - bounds.minimum) / (bounds.maximum - bounds.minimum)) * (chartBottom - chartTop)
    return [{ x, y }]
  }).map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '), [bounds, definition, track.points])
  const activeTime = replayTime ?? bounds.start
  const active = nearestPoint(track.points, activeTime)
  const crosshairX = ((activeTime - bounds.start) / (bounds.end - bounds.start)) * width

  const scrub = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
    onReplayTime(bounds.start + ratio * (bounds.end - bounds.start))
  }

  return (
    <section className="flight-profile" aria-label="Flight profile and event timeline">
      <header>
        <div>
          <span className="eyebrow">FLIGHT PROFILE</span>
          <h2>{track.session.callsigns[0] || track.session.registration || track.session.icao.toUpperCase()}</h2>
        </div>
        <div className="profile-metric-tabs" role="group" aria-label="Profile metric">
          {(Object.entries(metrics) as [Metric, typeof definition][]).map(([key, item]) => (
            <button key={key} type="button" aria-pressed={metric === key} onClick={() => setMetric(key)}>
              <item.icon size={14} /> {item.label}
            </button>
          ))}
        </div>
      </header>

      <div className="profile-readout" aria-live="polite">
        <span><small>Time</small><strong>{active ? formatTime(active.recordedAt) : '—'}</strong></span>
        <span><small>Altitude</small><strong>{formatAltitude(active?.altitudeFt ?? null)}</strong></span>
        <span><small>Speed</small><strong>{formatSpeed(active?.groundSpeedKt ?? null)}</strong></span>
        <span><small>Vertical rate</small><strong>{metrics.verticalRate.format(active?.verticalRateFpm ?? null)}</strong></span>
        <span><small>Distance</small><strong>{formatDistance(active?.distanceNm ?? null)}</strong></span>
      </div>

      <svg
        className="profile-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${definition.label} over the selected flight. Click or drag to scrub replay.`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          scrub(event)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event)
        }}
      >
        <line x1="0" y1={chartBottom} x2={width} y2={chartBottom} className="profile-axis" />
        <line x1="0" y1={(chartTop + chartBottom) / 2} x2={width} y2={(chartTop + chartBottom) / 2} className="profile-grid" />
        {path ? <path d={path} className="profile-line" /> : null}
        {track.events.map((event) => {
          const x = ((Date.parse(event.occurredAt) - bounds.start) / (bounds.end - bounds.start)) * width
          return x < 0 || x > width ? null : (
            <g key={`${event.type}-${event.occurredAt}`}>
              <line x1={x} y1={chartTop} x2={x} y2={chartBottom} className={`profile-event severity-${event.severity}`} />
              <title>{`${event.label}${event.value ? `: ${event.value}` : ''} at ${formatTime(event.occurredAt)}`}</title>
            </g>
          )
        })}
        <line x1={crosshairX} y1={chartTop} x2={crosshairX} y2={chartBottom} className="profile-crosshair" />
        <text x="4" y="174">{formatTime(new Date(bounds.start).toISOString())}</text>
        <text x={width - 4} y="174" textAnchor="end">{formatTime(new Date(bounds.end).toISOString())}</text>
      </svg>

      {track.events.length ? (
        <details className="profile-events">
          <summary>{track.events.length} flight events</summary>
          <ol>
            {track.events.map((event) => (
              <li key={`${event.type}-${event.occurredAt}`} className={`severity-${event.severity}`}>
                <time>{formatTime(event.occurredAt)}</time>
                <span><strong>{event.label}</strong>{event.value ? <small>{event.value}</small> : null}</span>
                <button type="button" onClick={() => onReplayTime(Date.parse(event.occurredAt))}>Go to event</button>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  )
}
