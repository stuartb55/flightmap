import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { InsightPatternCell, InsightPatternsResponse } from '@flightmap/shared'
import { ChartDataTable } from './ChartDataTable'

type Metric = 'uniqueAircraft' | 'sessions' | 'reports'
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const labels: Record<Metric, string> = { uniqueAircraft: 'Aircraft', sessions: 'Sessions', reports: 'Reports' }

export function ActivityPattern({ patterns }: { patterns: InsightPatternsResponse }) {
  const [metric, setMetric] = useState<Metric>('uniqueAircraft')
  const byCell = useMemo(() => new Map(patterns.cells.map((cell) => [`${cell.weekday}:${cell.hour}`, cell])), [patterns.cells])
  const maximum = Math.max(1, ...patterns.cells.map((cell) => cell[metric]))
  const valueFor = (cell?: InsightPatternCell) => cell?.[metric] ?? 0
  return (
    <section className="insight-panel pattern-panel" aria-label="Weekly activity pattern">
      <header>
        <div><span className="eyebrow">TIME PATTERNS</span><h2>Activity by weekday and hour</h2></div>
        <div className="preset-tabs" role="group" aria-label="Pattern metric">
          {(Object.keys(labels) as Metric[]).map((key) => <button key={key} type="button" aria-pressed={metric === key} onClick={() => setMetric(key)}>{labels[key]}</button>)}
        </div>
      </header>
      {patterns.busiest ? <p className="chart-summary">Busiest window: {weekdays[patterns.busiest.weekday]} at {String(patterns.busiest.hour).padStart(2, '0')}:00, with {patterns.busiest.reports.toLocaleString('en-GB')} reports.</p> : null}
      <div className="pattern-scroll">
        <div className="pattern-grid" role="group" aria-label={`${labels[metric]} by local weekday and hour in ${patterns.timeZone}`}>
          <span />
          {Array.from({ length: 24 }, (_, hour) => <span className="pattern-hour" key={hour}>{hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}</span>)}
          {weekdays.flatMap((weekday, day) => [
            <strong className="pattern-day" key={`${weekday}-label`}>{weekday}</strong>,
            ...Array.from({ length: 24 }, (_, hour) => {
              const cell = byCell.get(`${day}:${hour}`)
              const value = valueFor(cell)
              const opacity = value === 0 ? 0.04 : 0.18 + (value / maximum) * 0.82
              const notableChange = cell?.changePercent != null && Math.abs(cell.changePercent) >= 20 ? cell.changePercent : null
              const changeLabel = notableChange == null ? '' : `, ${notableChange > 0 ? 'up' : 'down'} ${Math.abs(notableChange).toFixed(0)}% versus preceding period`
              return <span key={`${day}:${hour}`} className="pattern-cell" role="img" aria-label={`${weekday} ${String(hour).padStart(2, '0')}:00: ${value.toLocaleString('en-GB')} ${labels[metric].toLowerCase()}${changeLabel}`} style={{ '--pattern-opacity': opacity } as CSSProperties}><i />{notableChange == null ? null : <b aria-hidden="true">{notableChange > 0 ? '↑' : '↓'}</b>}</span>
            }),
          ])}
        </div>
      </div>
      <small>Hours use {patterns.timeZone}. Arrows mark changes of at least 20% from the preceding period.</small>
      {/* The grid's change arrows carried their figure in a `title`, which a
          keyboard never reaches; the table is where that number now lives. */}
      <ChartDataTable
        summary={`View ${labels[metric].toLowerCase()} pattern data table`}
        caption={`${labels[metric]} by weekday and hour in ${patterns.timeZone}`}
        columns={['Weekday and hour', 'Aircraft', 'Sessions', 'Reports', 'Change vs preceding']}
        rows={weekdays.flatMap((weekday, day) =>
          Array.from({ length: 24 }, (_, hour) => {
            const cell = byCell.get(`${day}:${hour}`)
            return {
              key: `${day}:${hour}`,
              header: `${weekday} ${String(hour).padStart(2, '0')}:00`,
              cells: [
                (cell?.uniqueAircraft ?? 0).toLocaleString('en-GB'),
                (cell?.sessions ?? 0).toLocaleString('en-GB'),
                (cell?.reports ?? 0).toLocaleString('en-GB'),
                cell?.changePercent == null
                  ? '—'
                  : `${cell.changePercent > 0 ? '+' : ''}${cell.changePercent.toFixed(0)}%`,
              ],
            }
          }),
        )}
      />
    </section>
  )
}
