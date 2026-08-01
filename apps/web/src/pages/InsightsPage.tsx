import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type {
  InsightCoverageResponse,
  InsightLeader,
  InsightOverview,
  InsightSeriesPoint,
  SavedViewConfiguration,
} from '@flightmap/shared'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarDays,
  Download,
  Gauge,
  MapPinned,
  Plane,
  RadioTower,
  RefreshCw,
  Route,
} from 'lucide-react'
import { CoverageMap } from '../components/CoverageMap'
import type { CoverageMapHandle } from '../components/CoverageMap'
import { SavedViewsControl } from '../components/SavedViewsControl'
import { api } from '../lib/api'
import {
  compactNumber,
  dateTimeInputToIso,
  formatAltitude,
  formatDateTime,
  formatDateTimeInput,
  formatDistance,
} from '../lib/format'
import { useMapLayers } from '../lib/map-preferences'

type Preset = 'today' | '24h' | '7d' | '30d' | 'custom'
type InsightRange = { from: string; to: string; bucket: 'hour' | 'day' }

export function insightRangeForPreset(preset: Exclude<Preset, 'custom'>, now = new Date()): InsightRange {
  if (preset === 'today') {
    const localDate = formatDateTimeInput(now).slice(0, 10)
    return {
      from: dateTimeInputToIso(`${localDate}T00:00`),
      to: now.toISOString(),
      bucket: 'hour',
    }
  }
  const hours = preset === '24h' ? 24 : preset === '7d' ? 24 * 7 : 24 * 30
  return {
    from: new Date(now.getTime() - hours * 3_600_000).toISOString(),
    to: now.toISOString(),
    bucket: preset === '24h' ? 'hour' : 'day',
  }
}

function seriesLabel(point: InsightSeriesPoint, bucket: 'hour' | 'day') {
  return bucket === 'hour'
    ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(
        new Date(point.bucketStart),
      )
    : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(
        new Date(point.bucketStart),
      )
}

function ActivityChart({ overview }: { overview: InsightOverview }) {
  const width = 760
  const height = 220
  const chartTop = 18
  const chartBottom = 178
  const maxReports = Math.max(1, ...overview.series.map((point) => point.reports))
  const barSpace = width / Math.max(1, overview.series.length)
  const barWidth = Math.max(2, Math.min(24, barSpace - 2))
  const busiest = overview.series.reduce<InsightSeriesPoint | null>(
    (best, point) => (!best || point.reports > best.reports ? point : best),
    null,
  )
  const availabilityPoints = overview.series.flatMap((point, index) =>
    point.receiverAvailabilityPercent == null
      ? []
      : [{
          x: index * barSpace + barSpace / 2,
          y: chartBottom - (point.receiverAvailabilityPercent / 100) * (chartBottom - chartTop),
          value: point.receiverAvailabilityPercent,
        }],
  )

  return (
    <>
      <p className="chart-summary">
        {busiest
          ? `Busiest ${overview.bucket}: ${seriesLabel(busiest, overview.bucket)}, with ${busiest.reports.toLocaleString('en-GB')} reports from ${busiest.uniqueAircraft.toLocaleString('en-GB')} aircraft.`
          : 'No activity was recorded in this range.'}
      </p>
      {overview.series.length ? (
        <svg
          className="activity-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Activity by ${overview.bucket}; maximum ${maxReports.toLocaleString('en-GB')} reports`}
        >
          <line x1="0" y1={chartBottom} x2={width} y2={chartBottom} className="chart-axis" />
          <line x1="0" y1={chartTop} x2={width} y2={chartTop} className="chart-grid" />
          <line x1="0" y1={(chartTop + chartBottom) / 2} x2={width} y2={(chartTop + chartBottom) / 2} className="chart-grid" />
          {overview.series.map((point, index) => {
            const barHeight = Math.max(1, (point.reports / maxReports) * (chartBottom - chartTop))
            const x = index * barSpace + (barSpace - barWidth) / 2
            return (
              <rect
                key={point.bucketStart}
                x={x}
                y={chartBottom - barHeight}
                width={barWidth}
                height={barHeight}
                rx="2"
                className="chart-bar"
              >
                <title>{`${seriesLabel(point, overview.bucket)}: ${point.reports.toLocaleString('en-GB')} reports, ${point.uniqueAircraft.toLocaleString('en-GB')} aircraft`}</title>
              </rect>
            )
          })}
          {availabilityPoints.length > 1 ? (
            <polyline
              points={availabilityPoints.map((point) => `${point.x},${point.y}`).join(' ')}
              className="receiver-availability-line"
            />
          ) : null}
          {availabilityPoints.map((point) => (
            <circle key={`${point.x}:${point.y}`} cx={point.x} cy={point.y} r="3" className="receiver-availability-point">
              <title>{`Receiver availability: ${point.value.toFixed(1)}%`}</title>
            </circle>
          ))}
          {[0, Math.floor((overview.series.length - 1) / 2), overview.series.length - 1]
            .filter((index, position, indexes) => index >= 0 && indexes.indexOf(index) === position)
            .map((index) => (
              <text
                key={index}
                x={index * barSpace + barSpace / 2}
                y="207"
                textAnchor={index === 0 ? 'start' : index === overview.series.length - 1 ? 'end' : 'middle'}
                className="chart-label"
              >
                {seriesLabel(overview.series[index]!, overview.bucket)}
              </text>
            ))}
        </svg>
      ) : null}
      {availabilityPoints.length ? (
        <p className="chart-legend"><i aria-hidden="true" /> Receiver availability</p>
      ) : null}
      <details className="chart-data-table">
        <summary>View activity data table</summary>
        <div className="table-scroll">
          <table>
            <caption>Activity chart values</caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">Aircraft</th>
                <th scope="col">Sessions</th>
                <th scope="col">Reports</th>
                <th scope="col">Positioned</th>
                <th scope="col">Maximum range</th>
                <th scope="col">Maximum altitude</th>
                <th scope="col">Message rate</th>
                <th scope="col">Receiver availability</th>
                <th scope="col">Rejected records</th>
                <th scope="col">Data gaps</th>
              </tr>
            </thead>
            <tbody>
              {overview.series.map((point) => (
                <tr key={point.bucketStart}>
                  <th scope="row">{formatDateTime(point.bucketStart)}</th>
                  <td>{point.uniqueAircraft.toLocaleString('en-GB')}</td>
                  <td>{point.sessions.toLocaleString('en-GB')}</td>
                  <td>{point.reports.toLocaleString('en-GB')}</td>
                  <td>{point.positionedReports.toLocaleString('en-GB')}</td>
                  <td>{formatDistance(point.maximumRangeNm)}</td>
                  <td>{formatAltitude(point.maximumAltitudeFt)}</td>
                  <td>{point.messageRatePerSecond == null ? '—' : `${point.messageRatePerSecond.toFixed(1)}/s`}</td>
                  <td>{point.receiverAvailabilityPercent == null ? 'Not retained' : `${point.receiverAvailabilityPercent.toFixed(1)}%`}</td>
                  <td>{point.rejectedRecords?.toLocaleString('en-GB') ?? '—'}</td>
                  <td>{point.dataGapMinutes == null ? 'Not retained' : `${point.dataGapMinutes.toLocaleString('en-GB')} min`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  )
}

function ReceiverContext({ series }: { series: InsightSeriesPoint[] }) {
  const retained = series.filter((point) => point.receiverAvailabilityPercent != null)
  if (!retained.length) {
    return (
      <div className="receiver-context-empty" role="status">
        Receiver performance context follows detailed-history retention and is unavailable for this period.
      </div>
    )
  }
  const rates = retained.flatMap((point) => point.messageRatePerSecond == null ? [] : [point.messageRatePerSecond])
  const averageAvailability = retained.reduce((total, point) => total + (point.receiverAvailabilityPercent ?? 0), 0) / retained.length
  const averageRate = rates.length ? rates.reduce((total, value) => total + value, 0) / rates.length : null
  const rejected = retained.reduce((total, point) => total + (point.rejectedRecords ?? 0), 0)
  const gaps = retained.reduce((total, point) => total + (point.dataGapMinutes ?? 0), 0)
  return (
    <section className="receiver-context" aria-label="Receiver performance context">
      <div><Gauge size={16} /><span><small>Average message rate</small><strong>{averageRate == null ? '—' : `${averageRate.toFixed(1)}/s`}</strong></span></div>
      <div><RadioTower size={16} /><span><small>Receiver availability</small><strong>{averageAvailability.toFixed(1)}%</strong></span></div>
      <div><AlertTriangle size={16} /><span><small>Rejected records</small><strong>{rejected.toLocaleString('en-GB')}</strong></span></div>
      <div><Activity size={16} /><span><small>Data gaps</small><strong>{gaps.toLocaleString('en-GB')} min</strong></span></div>
    </section>
  )
}

function signedChange(value: number | null, unit = '', fractionDigits = 0) {
  if (value == null) return 'Unavailable'
  const formatted = value.toLocaleString('en-GB', { maximumFractionDigits: fractionDigits })
  return `${value > 0 ? '+' : ''}${formatted}${unit}`
}

function ComparisonPanel({ overview }: { overview: InsightOverview }) {
  const comparison = overview.comparison
  if (!comparison) return null
  const entries = [
    ['Unique aircraft', 'uniqueAircraft', '', 0],
    ['Sessions', 'sessions', '', 0],
    ['Reports', 'reports', '', 0],
    ['Positioned reports', 'positionedReports', '', 0],
    ['Maximum range', 'maximumRangeNm', ' nm', 1],
    ['Maximum altitude', 'maximumAltitudeFt', ' ft', 0],
  ] as const
  return (
    <section className="comparison-panel" aria-label="Period comparison">
      <header><div><span className="eyebrow">PERIOD COMPARISON</span><h2>Compared with the preceding period</h2></div><small>{formatDateTime(comparison.from)} — {formatDateTime(comparison.to)}</small></header>
      <div>{entries.map(([label, key, unit, fractionDigits]) => {
        const change = comparison.changes[key]
        return <article key={key} className={(change?.absolute ?? 0) < 0 ? 'negative' : (change?.absolute ?? 0) > 0 ? 'positive' : ''}><small>{label}</small><strong>{signedChange(change?.absolute ?? null, unit, fractionDigits)}</strong><span>{change?.percent == null ? 'No percentage baseline' : `${signedChange(change.percent, '%', 1)} vs previous`}</span></article>
      })}</div>
    </section>
  )
}

function exportHref(path: string, values: Record<string, string | boolean>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) params.set(key, String(value))
  return `/api/v1/exports/${path}?${params.toString()}`
}

function LeaderList({ title, leaders }: { title: string; leaders: InsightLeader[] }) {
  const maximum = Math.max(1, ...leaders.map((leader) => leader.reports))
  return (
    <section className="leader-card">
      <h3>{title}</h3>
      {leaders.length ? (
        <ol>
          {leaders.map((leader) => (
            <li key={leader.key}>
              <span className="leader-rank" aria-hidden="true" />
              <span className="leader-copy">
                <strong>{leader.label}</strong>
                <small>{leader.secondary ?? `${leader.sessions.toLocaleString('en-GB')} sessions`}</small>
                <span className="leader-meter" aria-hidden="true">
                  <i style={{ width: `${Math.max(3, (leader.reports / maximum) * 100)}%` }} />
                </span>
              </span>
              <span className="leader-value">{compactNumber(leader.reports)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p>No ranked activity yet.</p>
      )}
    </section>
  )
}

export function InsightsPage() {
  const initial = useMemo(() => insightRangeForPreset('today'), [])
  const [preset, setPreset] = useState<Preset>('today')
  const [range, setRange] = useState<InsightRange>(initial)
  const [customFrom, setCustomFrom] = useState(formatDateTimeInput(new Date(initial.from)))
  const [customTo, setCustomTo] = useState(formatDateTimeInput(new Date(initial.to)))
  const [overview, setOverview] = useState<InsightOverview | null>(null)
  const [coverage, setCoverage] = useState<InsightCoverageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [compare, setCompare] = useState(false)
  const [mapLayers, setMapLayers] = useMapLayers()
  const coverageMapRef = useRef<CoverageMapHandle>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setCoverageError(null)
    void Promise.allSettled([
      api.insightsOverview({ ...range, compare }, controller.signal),
      api.insightsCoverage(range, controller.signal),
    ]).then(([overviewResult, coverageResult]) => {
      if (controller.signal.aborted) return
      if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value)
      else {
        setOverview(null)
        setError(
          overviewResult.reason instanceof Error
            ? overviewResult.reason.message
            : 'Insights are unavailable.',
        )
      }
      if (coverageResult.status === 'fulfilled') setCoverage(coverageResult.value)
      else {
        setCoverage(null)
        setCoverageError(
          coverageResult.reason instanceof Error
            ? coverageResult.reason.message
            : 'Coverage is unavailable.',
        )
      }
      setLoading(false)
    })
    return () => controller.abort()
  }, [range, compare, refreshKey])

  const choosePreset = (value: Exclude<Preset, 'custom'>) => {
    const next = insightRangeForPreset(value)
    setPreset(value)
    setRange(next)
    setCustomFrom(formatDateTimeInput(new Date(next.from)))
    setCustomTo(formatDateTimeInput(new Date(next.to)))
  }

  const submitCustom = (event: FormEvent) => {
    event.preventDefault()
    try {
      const from = dateTimeInputToIso(customFrom)
      const to = dateTimeInputToIso(customTo)
      if (Date.parse(from) >= Date.parse(to)) throw new Error('The start must be before the end.')
      const duration = Date.parse(to) - Date.parse(from)
      if (duration > 366 * 86_400_000) throw new Error('Custom insight ranges are limited to 366 days.')
      setPreset('custom')
      setRange({ from, to, bucket: duration <= 48 * 3_600_000 ? 'hour' : 'day' })
      setError(null)
    } catch (rangeError) {
      setError(rangeError instanceof Error ? rangeError.message : 'Enter a valid range.')
    }
  }

  const backfill = overview?.availability.backfill ?? coverage?.availability.backfill
  const backfillPercent = backfill?.totalDays
    ? Math.min(100, (backfill.processedDays / backfill.totalDays) * 100)
    : 0
  const activityEmpty = !loading && overview?.metrics.reports === 0

  const applySavedView = (configuration: SavedViewConfiguration) => {
    if (configuration.surface !== 'insights') return
    setPreset(configuration.preset)
    setRange({ from: configuration.from, to: configuration.to, bucket: configuration.bucket })
    setCustomFrom(formatDateTimeInput(new Date(configuration.from)))
    setCustomTo(formatDateTimeInput(new Date(configuration.to)))
    setMapLayers(configuration.mapLayers)
    setCompare(configuration.compare)
    if (configuration.viewport) {
      const viewport = configuration.viewport
      window.setTimeout(() => coverageMapRef.current?.applyViewport(viewport), 0)
    }
  }

  return (
    <div className="standard-page insights-page">
      <header className="standard-page-header insights-header">
        <div className="page-heading">
          <span className="eyebrow">RECEIVER ANALYTICS</span>
          <h1>Activity &amp; coverage</h1>
          <p>Understand what your receiver hears and where positioned reports are observed.</p>
        </div>
        <div className="insights-header-actions">
          <SavedViewsControl
            surface="insights"
            configuration={() => ({
              surface: 'insights',
              from: range.from,
              to: range.to,
              bucket: range.bucket,
              preset,
              sort: 'reports_desc',
              compare,
              mapLayers,
              viewport: coverageMapRef.current?.getViewport() ?? null,
            })}
            onApply={applySavedView}
          />
          <a className="secondary-button" download href={exportHref('insights', { ...range, compare })}><Download size={15} /> CSV</a>
          <a className="secondary-button" download href={exportHref('coverage', { from: range.from, to: range.to })}><Download size={15} /> GeoJSON</a>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setRefreshKey((key) => key + 1)}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            Refresh
          </button>
        </div>
      </header>

      <section className="insight-controls" aria-label="Insight date range">
        <div className="preset-tabs" role="group" aria-label="Date range presets">
          {([
            ['today', 'Today'],
            ['24h', '24 hours'],
            ['7d', '7 days'],
            ['30d', '30 days'],
          ] as const).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={preset === value ? 'active' : ''}
              aria-pressed={preset === value}
              onClick={() => choosePreset(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <form className="insight-custom-range" onSubmit={submitCustom}>
          <label>
            <span>From</span>
            <input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} />
          </label>
          <label>
            <span>To</span>
            <input type="datetime-local" value={customTo} onChange={(event) => setCustomTo(event.target.value)} />
          </label>
          <button className="secondary-button small" type="submit">
            <CalendarDays size={14} /> Apply
          </button>
        </form>
        <label className="compare-toggle"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} /><span>Compare preceding period</span></label>
      </section>

      {!navigator.onLine ? (
        <div className="insight-notice error" role="alert">
          <RadioTower size={17} /> You are offline. Reconnect and retry to refresh insights.
        </div>
      ) : null}
      {error ? (
        <div className="insight-notice error" role="alert">
          <AlertTriangle size={17} />
          <span>{error}</span>
          <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>Retry</button>
        </div>
      ) : null}
      {overview?.availability.partial ? (
        <div className="insight-notice" role="status">
          <AlertTriangle size={17} />
          <span>{overview.availability.notices.join(' ')}</span>
        </div>
      ) : null}
      {backfill && backfill.status !== 'complete' ? (
        <section className="backfill-progress" aria-label="Historical aggregate backfill">
          <div>
            <span><strong>Preparing historical insights</strong><small>{backfill.processedDays} of {backfill.totalDays} days</small></span>
            <span>{Math.round(backfillPercent)}%</span>
          </div>
          <progress value={backfill.processedDays} max={Math.max(1, backfill.totalDays)} />
          {backfill.error ? <p>{backfill.error}</p> : null}
        </section>
      ) : null}

      {loading && !overview ? (
        <div className="insight-metrics" aria-label="Loading insight metrics">
          {Array.from({ length: 6 }, (_, index) => <div className="metric-card skeleton-card" key={index} />)}
        </div>
      ) : overview ? (
        <>
          <section className="insight-metrics" aria-label="Activity totals">
            <article className="metric-card"><Plane size={18} /><span><small>Unique aircraft</small><strong>{overview.metrics.uniqueAircraft.toLocaleString('en-GB')}</strong></span></article>
            <article className="metric-card"><Route size={18} /><span><small>Sessions</small><strong>{overview.metrics.sessions.toLocaleString('en-GB')}</strong></span></article>
            <article className="metric-card"><Activity size={18} /><span><small>Reports</small><strong>{compactNumber(overview.metrics.reports)}</strong></span></article>
            <article className="metric-card"><MapPinned size={18} /><span><small>Positioned reports</small><strong>{compactNumber(overview.metrics.positionedReports)}</strong></span></article>
            <article className="metric-card"><RadioTower size={18} /><span><small>Maximum range</small><strong>{formatDistance(overview.metrics.maximumRangeNm)}</strong></span></article>
            <article className="metric-card"><BarChart3 size={18} /><span><small>Maximum altitude</small><strong>{formatAltitude(overview.metrics.maximumAltitudeFt)}</strong></span></article>
          </section>

          <ComparisonPanel overview={overview} />

          {activityEmpty ? (
            <section className="insight-empty">
              <span><Plane size={25} /></span>
              <h2>No receiver activity in this range</h2>
              <p>Try a wider period. Collection can continue while this page is open.</p>
            </section>
          ) : (
            <>
              <section className="insight-panel activity-panel">
                <header><div><span className="eyebrow">ACTIVITY</span><h2>Reports by {overview.bucket}</h2></div><small>{formatDateTime(overview.from)} — {formatDateTime(overview.to)}</small></header>
                <ReceiverContext series={overview.series} />
                <ActivityChart overview={overview} />
              </section>

              <section className="insight-panel">
                <header><div><span className="eyebrow">FREQUENCY</span><h2>Most observed</h2></div><small>Ranked by receiver reports</small></header>
                <div className="leader-grid">
                  <LeaderList title="Aircraft" leaders={overview.leaders.aircraft} />
                  <LeaderList title="Types" leaders={overview.leaders.types} />
                  <LeaderList title="Operators" leaders={overview.leaders.operators} />
                </div>
              </section>
            </>
          )}
        </>
      ) : null}

      <section className="insight-panel coverage-panel">
        <header>
          <div><span className="eyebrow">POSITION COVERAGE</span><h2>Receiver coverage heatmap</h2></div>
          <small>Aggregated 0.05° cells · retained independently of detailed tracks</small>
        </header>
        {loading && !coverage ? <div className="coverage-skeleton skeleton-card" /> : coverageError ? (
          <div className="coverage-empty" role="status"><AlertTriangle size={21} /><strong>Coverage unavailable</strong><span>{coverageError}</span></div>
        ) : coverage?.cells.length ? (
          <>
            <CoverageMap ref={coverageMapRef} cells={coverage.cells} />
            <p className="coverage-summary">
              {coverage.cells.length.toLocaleString('en-GB')} cells returned. The busiest cell contains{' '}
              {Math.max(...coverage.cells.map((cell) => cell.reports)).toLocaleString('en-GB')} positioned reports.
              {coverage.truncated ? ' The display limit was reached; narrow the date range for complete cell detail.' : ''}
            </p>
            <details className="chart-data-table">
              <summary>View busiest coverage cells</summary>
              <div className="table-scroll">
                <table>
                  <caption>Top coverage heatmap cells</caption>
                  <thead><tr><th scope="col">Centre</th><th scope="col">Reports</th><th scope="col">Aircraft</th><th scope="col">Maximum altitude</th></tr></thead>
                  <tbody>{coverage.cells.slice(0, 50).map((cell) => <tr key={`${cell.latitude}:${cell.longitude}`}><th scope="row">{cell.latitude.toFixed(3)}, {cell.longitude.toFixed(3)}</th><td>{cell.reports.toLocaleString('en-GB')}</td><td>{cell.uniqueAircraft.toLocaleString('en-GB')}</td><td>{formatAltitude(cell.maximumAltitudeFt)}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
          </>
        ) : (
          <div className="coverage-empty"><MapPinned size={21} /><strong>No aggregated coverage yet</strong><span>Coverage is populated by positioned reports and can still be backfilling even when activity summaries are available.</span></div>
        )}
      </section>
    </div>
  )
}
