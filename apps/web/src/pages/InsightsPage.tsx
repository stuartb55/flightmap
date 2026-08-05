import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CoverageCell,
  CoverageCellDetailResponse,
  InsightCoverageResponse,
  InsightLeader,
  InsightOverview,
  InsightPatternsResponse,
  InsightSeriesPreferences,
  RangeProfileResponse,
  ReceiverRecord,
  ReceiverRecordKind,
  ReceiverRecordsResponse,
  InsightSeriesPoint,
  SavedViewConfiguration,
} from '@flightmap/shared'
import { calculateRangeAndBearing } from '@flightmap/shared'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarDays,
  Compass,
  Download,
  Gauge,
  MapPinned,
  Plane,
  RadioTower,
  RefreshCw,
  Route,
  Timer,
} from 'lucide-react'
import { CoverageMap } from '../components/CoverageMap'
import { ActivityPattern } from '../components/ActivityPattern'
import { RangeProfile } from '../components/RangeProfile'
import type { CoverageMapHandle } from '../components/CoverageMap'
import { SavedViewsControl } from '../components/SavedViewsControl'
import { ChartDataTable } from '../components/ChartDataTable'
import { api } from '../lib/api'
import {
  compactNumber,
  dateTimeInputToIso,
  formatAltitude,
  formatDate,
  formatDateTime,
  formatDateTimeInput,
  formatDistance,
  formatDurationSeconds,
} from '../lib/format'
import {
  convertAltitude,
  convertDistance,
  unitLabels,
  useUnitPreferences,
} from '../lib/unit-preferences'
import { useMapLayers } from '../lib/map-preferences'
import { useInsightSeries } from '../lib/insight-preferences'
import { useAppCommands } from '../lib/app-commands'
import { useDefaultSavedView } from '../lib/saved-views'
import { Link, useLocation } from '../lib/router'
import { displayTimeZone, useRuntimeConfig } from '../config'

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

/*
 * The three things the activity chart plots. Reports and positioned reports
 * share the report scale; availability is a percentage drawn against the full
 * height, which is why it is a line rather than a fourth bar.
 */
const seriesLabels: Record<keyof InsightSeriesPreferences, string> = {
  reports: 'Reports',
  positionedReports: 'Positioned reports',
  receiverAvailability: 'Receiver availability',
}

function ActivityChart({
  overview,
  series,
  onSelect,
}: {
  overview: InsightOverview
  series: InsightSeriesPreferences
  onSelect: (point: InsightSeriesPoint) => void
}) {
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
  const availabilityPoints = !series.receiverAvailability
    ? []
    : overview.series.flatMap((point, index) =>
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
      {!series.reports && !series.positionedReports && !series.receiverAvailability ? (
        // Empty axes look like a failed request. Say which it is.
        <p className="chart-summary" role="status">
          Every series is hidden. Choose one above to draw the chart; the data table below still
          lists every value.
        </p>
      ) : null}
      {overview.series.length ? (
        <svg
          className="activity-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={`Activity by ${overview.bucket}; maximum ${maxReports.toLocaleString('en-GB')} reports`}
        >
          <line x1="0" y1={chartBottom} x2={width} y2={chartBottom} className="chart-axis" />
          <line x1="0" y1={chartTop} x2={width} y2={chartTop} className="chart-grid" />
          <line x1="0" y1={(chartTop + chartBottom) / 2} x2={width} y2={(chartTop + chartBottom) / 2} className="chart-grid" />
          {overview.series.map((point, index) => {
            const barHeight = Math.max(1, (point.reports / maxReports) * (chartBottom - chartTop))
            const x = index * barSpace + (barSpace - barWidth) / 2
            const barLabel = `${seriesLabel(point, overview.bucket)}: ${point.reports.toLocaleString('en-GB')} reports, ${point.uniqueAircraft.toLocaleString('en-GB')} aircraft`
            /*
             * Positioned reports are a subset of reports, so they are drawn as
             * a narrower bar inside the same column rather than beside it:
             * the inset shows the shortfall as a gap, which is the thing worth
             * seeing. With reports hidden it stands on its own at full width.
             */
            const positionedWidth = series.reports ? Math.max(2, barWidth * 0.5) : barWidth
            const positionedHeight = Math.max(
              1,
              (point.positionedReports / maxReports) * (chartBottom - chartTop),
            )
            return (
              <g key={point.bucketStart}>
                {series.reports ? (
                  <rect
                    x={x}
                    y={chartBottom - barHeight}
                    width={barWidth}
                    height={barHeight}
                    rx="2"
                    className="chart-bar"
                    role="button"
                    tabIndex={0}
                    aria-label={barLabel}
                    onClick={() => onSelect(point)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') onSelect(point)
                    }}
                  >
                    <title>{barLabel}</title>
                  </rect>
                ) : null}
                {series.positionedReports ? (
                  <rect
                    x={x + (barWidth - positionedWidth) / 2}
                    y={chartBottom - positionedHeight}
                    width={positionedWidth}
                    height={positionedHeight}
                    rx="2"
                    className="chart-bar positioned"
                    // With reports drawn, the column already carries a button
                    // and a second one on the same target would be two tab
                    // stops onto the same drill-down.
                    {...(series.reports
                      ? { 'aria-hidden': true }
                      : {
                          role: 'button',
                          tabIndex: 0,
                          'aria-label': `${seriesLabel(point, overview.bucket)}: ${point.positionedReports.toLocaleString('en-GB')} positioned reports`,
                          onClick: () => onSelect(point),
                          onKeyDown: (event: KeyboardEvent<SVGElement>) => {
                            if (event.key === 'Enter' || event.key === ' ') onSelect(point)
                          },
                        })}
                  >
                    <title>
                      {`${seriesLabel(point, overview.bucket)}: ${point.positionedReports.toLocaleString('en-GB')} positioned reports`}
                    </title>
                  </rect>
                ) : null}
              </g>
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
      <p className="chart-legend">
        {series.reports ? <span><i className="reports" aria-hidden="true" /> Reports</span> : null}
        {series.positionedReports ? (
          <span><i className="positioned" aria-hidden="true" /> Positioned reports</span>
        ) : null}
        {availabilityPoints.length ? (
          <span><i className="availability" aria-hidden="true" /> Receiver availability</span>
        ) : null}
      </p>
      <ChartDataTable
        summary="View activity data table"
        caption="Activity chart values"
        columns={[
          'Period',
          'Aircraft',
          'Sessions',
          'Reports',
          'Positioned',
          'Maximum range',
          'Maximum altitude',
          'Message rate',
          'Receiver availability',
          'Rejected records',
          'Data gaps',
        ]}
        rows={overview.series.map((point) => ({
          key: point.bucketStart,
          header: formatDateTime(point.bucketStart),
          cells: [
            point.uniqueAircraft.toLocaleString('en-GB'),
            point.sessions.toLocaleString('en-GB'),
            point.reports.toLocaleString('en-GB'),
            point.positionedReports.toLocaleString('en-GB'),
            formatDistance(point.maximumRangeNm),
            formatAltitude(point.maximumAltitudeFt),
            point.messageRatePerSecond == null ? '—' : `${point.messageRatePerSecond.toFixed(1)}/s`,
            point.receiverAvailabilityPercent == null ? 'Not retained' : `${point.receiverAvailabilityPercent.toFixed(1)}%`,
            point.rejectedRecords?.toLocaleString('en-GB') ?? '—',
            point.dataGapMinutes == null ? 'Not retained' : `${point.dataGapMinutes.toLocaleString('en-GB')} min`,
          ],
        }))}
      />
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
  const units = useUnitPreferences()
  const comparison = overview.comparison
  if (!comparison) return null
  // Absolute changes are differences in canonical units, so they convert by
  // scale alone — no offset to worry about.
  const identity = (value: number) => value
  const entries = [
    ['Unique aircraft', 'uniqueAircraft', '', 0, identity],
    ['Sessions', 'sessions', '', 0, identity],
    ['Reports', 'reports', '', 0, identity],
    ['Positioned reports', 'positionedReports', '', 0, identity],
    [
      'Maximum range',
      'maximumRangeNm',
      ` ${unitLabels.distance[units.distance]}`,
      1,
      (value: number) => convertDistance(value, units.distance),
    ],
    [
      'Maximum altitude',
      'maximumAltitudeFt',
      ` ${unitLabels.altitude[units.altitude]}`,
      0,
      (value: number) => convertAltitude(value, units.altitude),
    ],
  ] as const
  return (
    <section className="comparison-panel" aria-label="Period comparison">
      <header><div><span className="eyebrow">PERIOD COMPARISON</span><h2>Compared with the preceding period</h2></div><small>{formatDateTime(comparison.from)} — {formatDateTime(comparison.to)}</small></header>
      <div>{entries.map(([label, key, unit, fractionDigits, convert]) => {
        const change = comparison.changes[key]
        const absolute = change?.absolute == null ? null : convert(change.absolute)
        return <article key={key} className={(change?.absolute ?? 0) < 0 ? 'negative' : (change?.absolute ?? 0) > 0 ? 'positive' : ''}><small>{label}</small><strong>{signedChange(absolute, unit, fractionDigits)}</strong><span>{change?.percent == null ? 'No percentage baseline' : `${signedChange(change.percent, '%', 1)} vs previous`}</span></article>
      })}</div>
    </section>
  )
}

/*
 * All-time records, above the date controls and deliberately outside them.
 * Every figure comes from an aggregate that is retained indefinitely, so these
 * numbers do not move when the range does — which reads as a bug unless the
 * panel says so, hence the standing note rather than a tooltip.
 */
const recordDefinitions: Record<
  ReceiverRecordKind,
  { title: string; icon: typeof Activity; describe: (record: ReceiverRecord) => string }
> = {
  farthest_contact: { title: 'Farthest contact', icon: Route, describe: (record) => formatDistance(record.value) },
  highest_altitude: { title: 'Highest altitude', icon: Activity, describe: (record) => formatAltitude(record.value) },
  closest_approach: { title: 'Closest approach', icon: MapPinned, describe: (record) => formatDistance(record.value) },
  longest_contact: { title: 'Longest contact', icon: Timer, describe: (record) => formatDurationSeconds(record.value) },
  busiest_day: { title: 'Busiest day', icon: BarChart3, describe: (record) => `${compactNumber(record.value)} reports` },
  most_observed_airframe: { title: 'Most-observed airframe', icon: Plane, describe: (record) => `${compactNumber(record.value)} reports` },
}

/** The History range for the UTC day a record was set. */
function recordDayHref(record: ReceiverRecord) {
  const start = `${record.occurredOn}T00:00:00.000Z`
  const end = `${record.occurredOn}T23:59:59.999Z`
  const params = new URLSearchParams({ from: start, to: end })
  if (record.icao) params.set('icao', record.icao)
  return `/history?${params.toString()}`
}

function RecordsPanel({
  records,
  loading,
}: {
  records: ReceiverRecordsResponse | null
  loading: boolean
}) {
  useUnitPreferences()
  if (loading && !records) {
    return <div className="records-panel skeleton-card" role="status" aria-label="Loading receiver records" />
  }
  if (!records) return null
  return (
    <section className="records-panel" aria-label="All-time receiver records">
      <header>
        <div>
          <span className="eyebrow">ALL-TIME RECORDS</span>
          <h2>Receiver records</h2>
        </div>
        <p>
          {records.availableFrom
            ? `Every observation since ${formatDate(records.availableFrom)}. These do not change with the date range below.`
            : 'Every observation this receiver has kept. These do not change with the date range below.'}
        </p>
      </header>
      {records.records.length ? (
        <ol>
          {records.records.map((record) => {
            const definition = recordDefinitions[record.kind]
            return (
              <li key={record.kind}>
                <span className="record-icon" aria-hidden="true"><definition.icon size={15} /></span>
                <small>{definition.title}</small>
                <strong>{definition.describe(record)}</strong>
                <span className="record-context">
                  {record.label ? <b>{record.label}</b> : null}
                  {record.secondary ? <i>{record.secondary}</i> : null}
                  <time dateTime={record.occurredOn}>{formatDate(record.occurredOn)}</time>
                </span>
                <span className="record-links">
                  {record.icao ? (
                    <Link to={`/aircraft/${encodeURIComponent(record.icao)}`}>
                      Aircraft profile
                    </Link>
                  ) : null}
                  {record.detailedTrackAvailable ? (
                    <Link to={recordDayHref(record)}>History</Link>
                  ) : (
                    // The record itself is kept for ever; the track behind it
                    // is not, and saying so is better than a link that lands
                    // on an empty search.
                    <em>Detailed track expired</em>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="records-empty">
          No records yet. They appear once this receiver has aggregated its first day of
          observations, and are kept for ever after that.
        </p>
      )}
    </section>
  )
}

/**
 * The coverage cells lying on a five-degree bearing from the receiver.
 *
 * The bearing comes from the same helper the ingestion path buckets the range
 * histogram with, so a cell lands in the wedge the chart drew it into. The
 * receiver's own cell has no bearing at all and stays in every wedge — leaving
 * it out would drop the busiest cell on the map.
 */
export function cellsOnBearing(
  cells: CoverageCell[],
  receiver: { latitude: number; longitude: number },
  bearingStartDeg: number,
): CoverageCell[] {
  return cells.filter((cell) => {
    const { distanceNm, bearingDeg } = calculateRangeAndBearing(
      receiver.latitude,
      receiver.longitude,
      cell.latitude,
      cell.longitude,
    )
    if (distanceNm < 1) return true
    const offset = (bearingDeg - bearingStartDeg + 360) % 360
    return offset < 5
  })
}

/**
 * The History link for a pattern-grid cell.
 *
 * Session searches are capped at 32 days, while an insight range runs to 366,
 * so a wider range drills into its most recent 32 days rather than failing.
 * The dates travel in the URL and are shown by History's own range fields, so
 * the narrowing is visible where it applies.
 */
export function patternCellHref(range: { from: string; to: string }, weekday: number, hour: number) {
  const to = Date.parse(range.to)
  const from = Math.max(Date.parse(range.from), to - 32 * 86_400_000)
  const params = new URLSearchParams({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    weekday: String(weekday),
    hour: String(hour),
  })
  return `/history?${params.toString()}`
}

function exportHref(path: string, values: Record<string, string | boolean>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) params.set(key, String(value))
  return `/api/v1/exports/${path}?${params.toString()}`
}

function LeaderList({ title, leaders, kind }: { title: string; leaders: InsightLeader[]; kind: 'aircraft' | 'type' | 'operator' }) {
  const maximum = Math.max(1, ...leaders.map((leader) => leader.reports))
  return (
    <section className="leader-card">
      <h3>{title}</h3>
      {leaders.length ? (
        <ol>
          {leaders.map((leader) => (
            <li key={leader.key}>
              <span className="leader-rank" aria-hidden="true" />
              <Link className="leader-copy" to={kind === 'aircraft' ? `/aircraft/${encodeURIComponent(leader.key)}` : `/history?${kind}=${encodeURIComponent(leader.label)}`}>
                <strong>{leader.label}</strong>
                <small>{leader.secondary ?? `${leader.sessions.toLocaleString('en-GB')} sessions`}</small>
                <span className="leader-meter" aria-hidden="true">
                  <i style={{ width: `${Math.max(3, (leader.reports / maximum) * 100)}%` }} />
                </span>
              </Link>
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
  useUnitPreferences()
  const { navigate, search } = useLocation()
  const initial = useMemo(() => insightRangeForPreset('today'), [])
  const [preset, setPreset] = useState<Preset>('today')
  const [range, setRange] = useState<InsightRange>(initial)
  const [customFrom, setCustomFrom] = useState(formatDateTimeInput(new Date(initial.from)))
  const [customTo, setCustomTo] = useState(formatDateTimeInput(new Date(initial.to)))
  const [overview, setOverview] = useState<InsightOverview | null>(null)
  const [coverage, setCoverage] = useState<InsightCoverageResponse | null>(null)
  const [patterns, setPatterns] = useState<InsightPatternsResponse | null>(null)
  const [rangeProfile, setRangeProfile] = useState<RangeProfileResponse | null>(null)
  const [records, setRecords] = useState<ReceiverRecordsResponse | null>(null)
  const [recordsLoading, setRecordsLoading] = useState(true)
  const [altitudeBand, setAltitudeBand] = useState<'all' | 'ground' | 'low' | 'medium' | 'high'>('all')
  const [selectedCoverage, setSelectedCoverage] = useState<CoverageCellDetailResponse | null>(null)
  const [coverageDetailLoading, setCoverageDetailLoading] = useState(false)
  const [sectorFilter, setSectorFilter] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [compare, setCompare] = useState(false)
  const [mapLayers, setMapLayers] = useMapLayers()
  const [series, setSeries] = useInsightSeries()
  const coverageMapRef = useRef<CoverageMapHandle>(null)
  const coveragePanelRef = useRef<HTMLElement>(null)

  const applySavedView = (configuration: SavedViewConfiguration) => {
    if (configuration.surface !== 'insights') return
    setPreset(configuration.preset)
    setRange({ from: configuration.from, to: configuration.to, bucket: configuration.bucket })
    setCustomFrom(formatDateTimeInput(new Date(configuration.from)))
    setCustomTo(formatDateTimeInput(new Date(configuration.to)))
    setMapLayers(configuration.mapLayers)
    setCompare(configuration.compare)
    setSeries(configuration.series)
    if (configuration.viewport) {
      const viewport = configuration.viewport
      window.setTimeout(() => coverageMapRef.current?.applyViewport(viewport), 0)
    }
  }

  /*
   * A default view has to be in place before the first query goes out: the
   * range it carries is the range the server should be asked about.
   */
  const defaultReady = useDefaultSavedView('insights', search !== '', applySavedView)

  /*
   * Records are all-time, so they are fetched once per visit and not again
   * when the range changes — refetching them alongside the range would imply
   * to anyone watching the network that they depend on it.
   */
  useEffect(() => {
    const controller = new AbortController()
    setRecordsLoading(true)
    void api
      .receiverRecords(controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setRecords(response)
      })
      .catch(() => {
        // A records failure must not take the rest of Insights with it: the
        // panel simply does not render.
        if (!controller.signal.aborted) setRecords(null)
      })
      .finally(() => {
        if (!controller.signal.aborted) setRecordsLoading(false)
      })
    return () => controller.abort()
  }, [refreshKey])

  useEffect(() => {
    if (!defaultReady) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setCoverageError(null)
    void Promise.allSettled([
      api.insightsOverview({ ...range, compare }, controller.signal),
      api.insightsCoverage(range, controller.signal),
      api.insightPatterns({ from: range.from, to: range.to, timeZone: displayTimeZone(), compare }, controller.signal),
      api.rangeProfile({ from: range.from, to: range.to, altitudeBand, compare }, controller.signal),
    ]).then(([overviewResult, coverageResult, patternsResult, rangeProfileResult]) => {
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
      setPatterns(patternsResult.status === 'fulfilled' ? patternsResult.value : null)
      setRangeProfile(rangeProfileResult.status === 'fulfilled' ? rangeProfileResult.value : null)
      setLoading(false)
    })
    return () => controller.abort()
  }, [defaultReady, range, compare, altitudeBand, refreshKey])

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

  /*
   * The wedge is applied to the cells already fetched rather than re-queried:
   * the coverage response is the whole grid for the range, and filtering it in
   * the browser keeps the drill-down instant and the server out of it.
   */
  const receiver = useRuntimeConfig().receiver
  const visibleCoverageCells = useMemo(() => {
    if (!coverage) return []
    return sectorFilter == null
      ? coverage.cells
      : cellsOnBearing(coverage.cells, receiver, sectorFilter)
  }, [coverage, sectorFilter, receiver])

  const selectSector = (bearingStartDeg: number) => {
    setSectorFilter((current) => (current === bearingStartDeg ? null : bearingStartDeg))
    setSelectedCoverage(null)
    // The panel the selection acts on is below the chart that made it, so the
    // drill-down moves the viewport to the result rather than leaving it
    // looking as though nothing happened. Optional because jsdom has no
    // scrollIntoView, and the filter is the point — the scroll is a courtesy.
    window.setTimeout(() => {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      coveragePanelRef.current?.scrollIntoView?.({
        behavior: reduced ? 'auto' : 'smooth',
        block: 'start',
      })
    }, 0)
  }

  const selectCoverageCell = (cell: CoverageCell) => {
    setCoverageDetailLoading(true)
    setSelectedCoverage(null)
    void api.coverageCellDetail({ from: range.from, to: range.to, latitude: cell.latitude, longitude: cell.longitude })
      .then(setSelectedCoverage)
      .catch((reason) => setCoverageError(reason instanceof Error ? reason.message : 'Coverage cell details are unavailable.'))
      .finally(() => setCoverageDetailLoading(false))
  }

  useAppCommands((command) => {
    if (command.type !== 'apply-saved-view' || command.configuration.surface !== 'insights') {
      return false
    }
    applySavedView(command.configuration)
    return true
  })

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
              series,
              mapLayers,
              viewport: coverageMapRef.current?.getViewport() ?? null,
            })}
            onApply={applySavedView}
          />
          <a className="secondary-button" download href={exportHref('insights', { ...range, compare })}><Download size={15} /> CSV</a>
          <a className="secondary-button" download href={exportHref('coverage', { from: range.from, to: range.to })}><Download size={15} /> GeoJSON</a>
          <small className="export-units-note">Exports use ft, kt and nm</small>
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

      <RecordsPanel records={records} loading={recordsLoading} />

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
        <div className="insight-metrics" role="status" aria-label="Loading insight metrics">
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
                <header>
                  <div><span className="eyebrow">ACTIVITY</span><h2>Reports by {overview.bucket}</h2></div>
                  <div className="preset-tabs" role="group" aria-label="Activity chart series">
                    {(Object.keys(seriesLabels) as (keyof InsightSeriesPreferences)[]).map((key) => (
                      <button
                        type="button"
                        key={key}
                        aria-pressed={series[key]}
                        onClick={() => setSeries({ ...series, [key]: !series[key] })}
                      >
                        {seriesLabels[key]}
                      </button>
                    ))}
                  </div>
                  <small>{formatDateTime(overview.from)} — {formatDateTime(overview.to)}</small>
                </header>
                <ReceiverContext series={overview.series} />
                <ActivityChart
                  overview={overview}
                  series={series}
                  onSelect={(point) => { navigate(`/history?from=${encodeURIComponent(point.bucketStart)}&to=${encodeURIComponent(point.bucketEnd)}`) }}
                />
              </section>

              <section className="insight-panel">
                <header><div><span className="eyebrow">FREQUENCY</span><h2>Most observed</h2></div><small>Ranked by receiver reports</small></header>
                <div className="leader-grid">
                  <LeaderList title="Aircraft" leaders={overview.leaders.aircraft} kind="aircraft" />
                  <LeaderList title="Types" leaders={overview.leaders.types} kind="type" />
                  <LeaderList title="Operators" leaders={overview.leaders.operators} kind="operator" />
                </div>
              </section>
              {patterns?.cells.length ? (
                <ActivityPattern
                  patterns={patterns}
                  onSelectCell={(weekday, hour) => navigate(patternCellHref(range, weekday, hour))}
                />
              ) : null}
            </>
          )}
        </>
      ) : null}

      <section className="insight-panel coverage-panel">
        <header><div><span className="eyebrow">RANGE QUALITY</span><h2>Receiver range profile</h2></div><label className="compact-select"><span>Altitude</span><select value={altitudeBand} onChange={(event) => setAltitudeBand(event.target.value as typeof altitudeBand)}><option value="all">All altitudes</option><option value="ground">Ground / under {formatAltitude(1_000)}</option><option value="low">{formatAltitude(1_000)}–{formatAltitude(10_000)}</option><option value="medium">{formatAltitude(10_000)}–{formatAltitude(25_000)}</option><option value="high">{formatAltitude(25_000)} and above</option></select></label></header>
        {rangeProfile?.sectors.some((sector) => sector.reports > 0) ? (
          <RangeProfile
            profile={rangeProfile}
            onSelectSector={selectSector}
            selectedSectorStartDeg={sectorFilter}
          />
        ) : <div className="coverage-empty"><RadioTower size={21} /><strong>No range profile yet</strong><span>New positioned reports populate the bearing and altitude histogram.</span></div>}
      </section>

      <section className="insight-panel coverage-panel" ref={coveragePanelRef}>
        <header>
          <div><span className="eyebrow">POSITION COVERAGE</span><h2>Receiver coverage heatmap</h2></div>
          <small>Aggregated 0.05° cells · retained independently of detailed tracks</small>
        </header>
        {sectorFilter != null ? (
          <div className="sector-filter-chip" role="status">
            <Compass size={15} aria-hidden="true" />
            <span>
              <strong>Bearing {sectorFilter}–{sectorFilter + 5}° from the receiver</strong>
              <small>
                {visibleCoverageCells.length.toLocaleString('en-GB')} of{' '}
                {(coverage?.cells.length ?? 0).toLocaleString('en-GB')} cells. Coverage in the
                direction of the range sector you chose — not the reports the sector counted, which
                the daily histogram cannot name individually.
              </small>
            </span>
            <button type="button" className="text-button" onClick={() => setSectorFilter(null)}>
              Show all bearings
            </button>
          </div>
        ) : null}
        {loading && !coverage ? <div className="coverage-skeleton skeleton-card" /> : coverageError ? (
          <div className="coverage-empty" role="status"><AlertTriangle size={21} /><strong>Coverage unavailable</strong><span>{coverageError}</span></div>
        ) : visibleCoverageCells.length ? (
          <>
            <CoverageMap ref={coverageMapRef} cells={visibleCoverageCells} onSelectCell={selectCoverageCell} />
            <p className="coverage-summary">
              {visibleCoverageCells.length.toLocaleString('en-GB')} cells returned. The busiest cell contains{' '}
              {Math.max(...visibleCoverageCells.map((cell) => cell.reports)).toLocaleString('en-GB')} positioned reports.
              {coverage?.truncated ? ' The display limit was reached; narrow the date range for complete cell detail.' : ''}
            </p>
            <ChartDataTable
              summary="View busiest coverage cells"
              caption="Top coverage heatmap cells"
              columns={['Centre', 'Reports', 'Aircraft', 'Maximum altitude']}
              rowCap={50}
              rows={visibleCoverageCells.map((cell) => ({
                key: `${cell.latitude}:${cell.longitude}`,
                header: (
                  <button type="button" className="text-button" onClick={() => selectCoverageCell(cell)}>
                    {cell.latitude.toFixed(3)}, {cell.longitude.toFixed(3)}
                  </button>
                ),
                cells: [
                  cell.reports.toLocaleString('en-GB'),
                  cell.uniqueAircraft.toLocaleString('en-GB'),
                  formatAltitude(cell.maximumAltitudeFt),
                ],
              }))}
            />
          </>
        ) : sectorFilter != null && coverage?.cells.length ? (
          // Coverage exists; this wedge is simply empty, which is a different
          // statement from having no coverage at all.
          <div className="coverage-empty" role="status">
            <Compass size={21} />
            <strong>No coverage cells on this bearing</strong>
            <span>The range profile counts reports the coverage grid has no cell for here. Choose another sector, or show all bearings.</span>
          </div>
        ) : (
          <div className="coverage-empty"><MapPinned size={21} /><strong>No aggregated coverage yet</strong><span>Coverage is populated by positioned reports and can still be backfilling even when activity summaries are available.</span></div>
        )}
        {coverageDetailLoading ? <p className="coverage-summary" role="status">Loading selected coverage cell…</p> : null}
        {selectedCoverage ? (
          <aside className="coverage-cell-detail" aria-label="Selected coverage cell details">
            <header><div><span className="eyebrow">SELECTED CELL</span><h3>{selectedCoverage.cell.latitude.toFixed(3)}, {selectedCoverage.cell.longitude.toFixed(3)}</h3></div><button type="button" className="text-button" onClick={() => setSelectedCoverage(null)}>Close</button></header>
            <dl><div><dt>Reports</dt><dd>{selectedCoverage.cell.reports.toLocaleString('en-GB')}</dd></div><div><dt>Aircraft</dt><dd>{selectedCoverage.cell.uniqueAircraft.toLocaleString('en-GB')}</dd></div><div><dt>Maximum altitude</dt><dd>{formatAltitude(selectedCoverage.cell.maximumAltitudeFt)}</dd></div></dl>
            <div className="coverage-aircraft-links">{selectedCoverage.aircraft.slice(0, 50).map((aircraft) => <Link key={aircraft.icao} to={`/aircraft/${encodeURIComponent(aircraft.icao)}`}><strong>{aircraft.registration || aircraft.icao.toUpperCase()}</strong><small>{aircraft.typeCode || aircraft.operator || 'Aircraft profile'}</small></Link>)}</div>
          </aside>
        ) : null}
      </section>
    </div>
  )
}
