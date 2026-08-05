import { useMemo, useState, type PointerEvent } from 'react'
import { Activity, Gauge, MapPin, MoveVertical } from 'lucide-react'
import {
  formatAltitude,
  formatDistance,
  formatElapsed,
  formatSpeed,
  formatTime,
  formatVerticalRateValue,
} from '../lib/format'
import { useUnitPreferences } from '../lib/unit-preferences'
import { ChartDataTable } from './ChartDataTable'
import { useResolvedTheme } from '../lib/theme'
import { trackColour, trackIdentity, type TrackColourMode } from '../lib/track-colour'
import type { TrackPoint, TrackResponse } from '../types'

type Metric = 'altitude' | 'speed' | 'verticalRate' | 'distance'

/**
 * How the chart's x axis is laid out. Absolute time is the default and shares
 * its axis with the replay slider and the session timeline; aligning on start
 * is what makes two approaches to the same runway comparable, and is the only
 * reason to overlay them at all.
 */
export const profileAxisModes = ['absolute', 'aligned'] as const
export type ProfileAxisMode = (typeof profileAxisModes)[number]
export const defaultProfileAxisMode: ProfileAxisMode = 'absolute'

export function parseProfileAxisMode(value: string | null | undefined): ProfileAxisMode {
  return profileAxisModes.includes(value as ProfileAxisMode)
    ? (value as ProfileAxisMode)
    : defaultProfileAxisMode
}

/**
 * Past four overlaid series the chart stops answering the question it was
 * opened to answer, so the rest stay in the selection and reach the chart
 * through the focus control instead.
 */
export const maximumComparedTracks = 4

/**
 * The series the chart draws, in selection order. `slot` is the track's
 * position in the whole selection rather than in this list, so its identity
 * colour and dash do not shuffle when the focus moves.
 */
export function comparedSeries<T extends { session: { id: string } }>(
  tracks: readonly T[],
  focusedTrackId: string | null,
): Array<{ track: T; slot: number }> {
  const drawn = tracks
    .slice(0, maximumComparedTracks)
    .map((track, slot) => ({ track, slot }))
  const focusedIndex = tracks.findIndex((track) => track.session.id === focusedTrackId)
  // A focused track beyond the cap takes the last slot: the chart must always
  // draw the series whose values the readout and crosshair report.
  if (focusedIndex >= maximumComparedTracks && drawn.length) {
    drawn[drawn.length - 1] = { track: tracks[focusedIndex]!, slot: focusedIndex }
  }
  return drawn
}

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

const trackLabel = (track: TrackResponse) =>
  track.session.callsigns[0] || track.session.registration || track.session.icao.toUpperCase()

const trackStart = (track: TrackResponse) =>
  Date.parse(track.points[0]?.recordedAt ?? track.session.startedAt)

const trackEnd = (track: TrackResponse) =>
  Date.parse(
    track.points.at(-1)?.recordedAt ?? track.session.endedAt ?? track.session.startedAt,
  )

export function FlightProfile({
  tracks,
  focusedTrackId,
  onFocusTrack,
  axisMode = defaultProfileAxisMode,
  onAxisModeChange,
  replayTime,
  onReplayTime,
  colourMode = 'altitude',
}: {
  /** The whole selection, in selection order; the chart draws the first few. */
  tracks: TrackResponse[]
  focusedTrackId: string | null
  onFocusTrack?: (id: string) => void
  axisMode?: ProfileAxisMode
  onAxisModeChange?: (mode: ProfileAxisMode) => void
  replayTime: number | null
  onReplayTime: (time: number) => void
  /** Matches the map, so a colour means the same thing on both. */
  colourMode?: TrackColourMode
}) {
  useUnitPreferences()
  // The ramps have a variant per theme, so a theme change must recolour the line.
  const theme = useResolvedTheme()
  const [metric, setMetric] = useState<Metric>('altitude')
  const definition = metrics[metric]
  const series = useMemo(
    () => comparedSeries(tracks, focusedTrackId),
    [focusedTrackId, tracks],
  )
  /*
   * One series keeps the per-point ramp, which is the whole point of a single
   * profile: the line says what the aircraft was doing along its length. Four
   * overlaid ramps say nothing, so comparison swaps to one identity colour per
   * series.
   */
  const comparing = series.length > 1
  const focusedTrack =
    (series.find((entry) => entry.track.session.id === focusedTrackId) ?? series[0])?.track ?? null

  const bounds = useMemo(() => {
    const start = Math.min(...series.map((entry) => trackStart(entry.track)), Number.POSITIVE_INFINITY)
    const end = Math.max(...series.map((entry) => trackEnd(entry.track)), Number.NEGATIVE_INFINITY)
    const elapsed = Math.max(
      1,
      ...series.map((entry) => trackEnd(entry.track) - trackStart(entry.track)),
    )
    // Reduced rather than spread: four twenty-thousand-point tracks are more
    // arguments than Math.min will take.
    let minimum: number | null = null
    let maximum: number | null = null
    for (const entry of series) {
      for (const point of entry.track.points) {
        const value = definition.value(point)
        if (value == null || !Number.isFinite(value)) continue
        if (minimum == null || value < minimum) minimum = value
        if (maximum == null || value > maximum) maximum = value
      }
    }
    const low = minimum ?? 0
    return {
      start: Number.isFinite(start) ? start : 0,
      end: Math.max((Number.isFinite(start) ? start : 0) + 1, Number.isFinite(end) ? end : 0),
      elapsed,
      minimum: low,
      maximum: Math.max(low + 1, maximum ?? 1),
    }
  }, [definition, series])

  const width = 900
  const height = 180
  const chartTop = 14
  const chartBottom = 150
  const aligned = comparing && axisMode === 'aligned'
  const span = aligned ? bounds.elapsed : bounds.end - bounds.start
  // Aligned, every series starts at the axis origin; otherwise they share the
  // wall clock, as the replay slider and the session timeline do.
  const originOf = (track: TrackResponse) => (aligned ? trackStart(track) : bounds.start)
  const axisX = (origin: number, time: number) => ((time - origin) / span) * width

  /*
   * The line is drawn as one path per run of same-coloured points rather than
   * one path per point: a track can carry twenty thousand samples but crosses
   * only a handful of colour boundaries. A segment takes the colour of the
   * point it arrives at, matching how the map colours the same track. A
   * comparison series is one colour throughout, so it collapses to one run.
   */
  const lines = useMemo(
    () =>
      series.map(({ track, slot }) => {
        const identity = trackIdentity(slot, theme)
        const origin = aligned ? trackStart(track) : bounds.start
        const plotted = track.points.flatMap((point) => {
          const value = definition.value(point)
          if (value == null || !Number.isFinite(value)) return []
          return [{
            x: ((Date.parse(point.recordedAt) - origin) / span) * width,
            y:
              chartBottom -
              ((value - bounds.minimum) / (bounds.maximum - bounds.minimum)) * (chartBottom - chartTop),
            colour: comparing ? identity.colour : trackColour(colourMode, point, theme),
          }]
        })
        const runs: Array<{ colour: string; d: string }> = []
        const at = (point: { x: number; y: number }) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`
        for (let index = 1; index < plotted.length; index += 1) {
          const previous = plotted[index - 1]!
          const point = plotted[index]!
          const run = runs[runs.length - 1]
          if (run && run.colour === point.colour) run.d += ` L${at(point)}`
          else runs.push({ colour: point.colour, d: `M${at(previous)} L${at(point)}` })
        }
        return {
          track,
          identity,
          origin,
          runs,
          focused: track.session.id === focusedTrack?.session.id,
        }
      }),
    [aligned, bounds, colourMode, comparing, definition, focusedTrack, series, span, theme],
  )

  if (!focusedTrack) return null

  const focusedOrigin = originOf(focusedTrack)
  const activeTime = replayTime ?? focusedOrigin
  const active = nearestPoint(focusedTrack.points, activeTime)
  const crosshairX = axisX(focusedOrigin, activeTime)
  // The focused series draws last so it sits over the rest at full width.
  const drawOrder = [...lines].sort((left, right) => Number(left.focused) - Number(right.focused))

  const scrub = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    // A chart that has not been laid out yet has no width, and the ratio would
    // be NaN — replay would take a position it cannot show.
    if (box.width <= 0) return
    const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
    onReplayTime(focusedOrigin + ratio * span)
  }

  return (
    <section className="flight-profile" aria-label="Flight profile and event timeline">
      <header>
        <div>
          <span className="eyebrow">FLIGHT PROFILE</span>
          <h2>{trackLabel(focusedTrack)}</h2>
        </div>
        <div className="profile-metric-tabs" role="group" aria-label="Profile metric">
          {(Object.entries(metrics) as [Metric, typeof definition][]).map(([key, item]) => (
            <button key={key} type="button" aria-pressed={metric === key} onClick={() => setMetric(key)}>
              <item.icon size={14} /> {item.label}
            </button>
          ))}
        </div>
      </header>

      {comparing ? (
        <div className="profile-compare-bar">
          {/* Aligning is the reason to overlay at all, so the control sits with
              the series rather than in a menu. */}
          <div className="profile-axis-tabs" role="group" aria-label="Profile time axis">
            <button
              type="button"
              aria-pressed={axisMode === 'absolute'}
              onClick={() => onAxisModeChange?.('absolute')}
            >
              Absolute time
            </button>
            <button
              type="button"
              aria-pressed={axisMode === 'aligned'}
              onClick={() => onAxisModeChange?.('aligned')}
            >
              Align on start
            </button>
          </div>
          <ul className="profile-series-legend">
            {lines.map((line) => (
              <li key={line.track.session.id}>
                <button
                  type="button"
                  aria-pressed={line.focused}
                  aria-label={`${trackLabel(line.track)}, ${line.identity.pattern} line. ${
                    line.focused ? 'Focused series' : 'Focus this series'
                  }`}
                  onClick={() => onFocusTrack?.(line.track.session.id)}
                >
                  <svg className="series-swatch" viewBox="0 0 28 8" aria-hidden="true" focusable="false">
                    <line
                      x1="1"
                      y1="4"
                      x2="27"
                      y2="4"
                      style={{
                        stroke: line.identity.colour,
                        strokeDasharray: line.identity.dash || undefined,
                      }}
                    />
                  </svg>
                  <strong>{trackLabel(line.track)}</strong>
                  <small>{line.identity.pattern}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tracks.length > series.length ? (
        <p className="profile-compare-note">
          Comparing {series.length} of {tracks.length} selected tracks. Choose Profile on another
          track to bring it into the chart.
        </p>
      ) : null}

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
        aria-label={
          comparing
            ? `${definition.label} for ${series.length} overlaid tracks, ${
                aligned ? 'aligned on each track’s start' : 'against absolute time'
              }. The readout and crosshair follow ${trackLabel(focusedTrack)}. Click or drag to scrub replay.`
            : `${definition.label} over the selected flight. Click or drag to scrub replay.`
        }
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
        {drawOrder.map((line) =>
          line.runs.map((run) => (
            <path
              key={`${line.track.session.id}:${run.d}`}
              d={run.d}
              className={['profile-line', comparing ? 'comparison' : '', line.focused ? 'focused' : '']
                .filter(Boolean)
                .join(' ')}
              style={{ stroke: run.colour, strokeDasharray: comparing ? line.identity.dash || undefined : undefined }}
            />
          )),
        )}
        {focusedTrack.events.map((event) => {
          const x = axisX(focusedOrigin, Date.parse(event.occurredAt))
          return x < 0 || x > width ? null : (
            <g key={`${event.type}-${event.occurredAt}`}>
              <line x1={x} y1={chartTop} x2={x} y2={chartBottom} className={`profile-event severity-${event.severity}`} />
              <title>{`${event.label}${event.value ? `: ${event.value}` : ''} at ${formatTime(event.occurredAt)}`}</title>
            </g>
          )
        })}
        <line x1={crosshairX} y1={chartTop} x2={crosshairX} y2={chartBottom} className="profile-crosshair" />
        <text x="4" y="174">
          {aligned ? formatElapsed(0) : formatTime(new Date(bounds.start).toISOString())}
        </text>
        <text x={width - 4} y="174" textAnchor="end">
          {aligned ? formatElapsed(bounds.elapsed) : formatTime(new Date(bounds.end).toISOString())}
        </text>
      </svg>

      {/* A one-second track is thousands of points; the cap keeps the table
          usable while still answering what the chart shows. Comparison gives
          each series its own table rather than one interleaved list, so a cap
          on a long track can never hide a short one entirely. */}
      {lines.map((line) => (
        <ChartDataTable
          key={line.track.session.id}
          summary={
            comparing
              ? `View ${trackLabel(line.track)} data table`
              : 'View flight profile data table'
          }
          caption={`Flight profile values for ${
            line.track.session.callsigns[0] || line.track.session.icao.toUpperCase()
          }`}
          columns={[aligned ? 'Elapsed' : 'Time', 'Altitude', 'Speed', 'Vertical rate', 'Receiver distance']}
          rowCap={200}
          rows={line.track.points.map((point) => ({
            key: point.recordedAt,
            header: aligned
              ? formatElapsed(Date.parse(point.recordedAt) - line.origin)
              : formatTime(point.recordedAt),
            cells: [
              formatAltitude(point.altitudeFt),
              formatSpeed(point.groundSpeedKt),
              formatVerticalRateValue(point.verticalRateFpm ?? null),
              formatDistance(point.distanceNm ?? null),
            ],
          }))}
        />
      ))}

      {focusedTrack.events.length ? (
        <details className="profile-events">
          <summary>{focusedTrack.events.length} flight events</summary>
          <ol>
            {focusedTrack.events.map((event) => (
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
