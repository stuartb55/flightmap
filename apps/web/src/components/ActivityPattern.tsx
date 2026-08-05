import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { InsightPatternCell, InsightPatternsResponse } from '@flightmap/shared'
import { ChartDataTable } from './ChartDataTable'

type Metric = 'uniqueAircraft' | 'sessions' | 'reports'
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const labels: Record<Metric, string> = { uniqueAircraft: 'Aircraft', sessions: 'Sessions', reports: 'Reports' }

export function ActivityPattern({
  patterns,
  onSelectCell,
}: {
  patterns: InsightPatternsResponse
  /** Drills into the weekday-hour window; absent leaves the grid inert. */
  onSelectCell?: (weekday: number, hour: number) => void
}) {
  const [metric, setMetric] = useState<Metric>('uniqueAircraft')
  /*
   * One tab stop for the whole grid: 168 focusable cells would bury every
   * control after it. Arrow keys move within the grid from wherever focus
   * landed, which is the pattern a spreadsheet already teaches.
   */
  const [cursor, setCursor] = useState({ weekday: 0, hour: 0 })
  const gridRef = useRef<HTMLDivElement>(null)
  const byCell = useMemo(() => new Map(patterns.cells.map((cell) => [`${cell.weekday}:${cell.hour}`, cell])), [patterns.cells])
  const maximum = Math.max(1, ...patterns.cells.map((cell) => cell[metric]))
  const valueFor = (cell?: InsightPatternCell) => cell?.[metric] ?? 0

  const moveCursor = (event: KeyboardEvent<HTMLElement>, weekday: number, hour: number) => {
    const next = { weekday, hour }
    if (event.key === 'ArrowRight') next.hour = Math.min(23, hour + 1)
    else if (event.key === 'ArrowLeft') next.hour = Math.max(0, hour - 1)
    else if (event.key === 'ArrowDown') next.weekday = Math.min(6, weekday + 1)
    else if (event.key === 'ArrowUp') next.weekday = Math.max(0, weekday - 1)
    else if (event.key === 'Home') next.hour = 0
    else if (event.key === 'End') next.hour = 23
    else return false
    event.preventDefault()
    setCursor(next)
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-cell="${next.weekday}:${next.hour}"]`)
      ?.focus()
    return true
  }

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
        <div className="pattern-grid" ref={gridRef} role="group" aria-label={`${labels[metric]} by local weekday and hour in ${patterns.timeZone}`}>
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
              const description = `${weekday} ${String(hour).padStart(2, '0')}:00: ${value.toLocaleString('en-GB')} ${labels[metric].toLowerCase()}${changeLabel}`
              const style = { '--pattern-opacity': opacity } as CSSProperties
              const body = <><i />{notableChange == null ? null : <b aria-hidden="true">{notableChange > 0 ? '↑' : '↓'}</b>}</>
              if (!onSelectCell) {
                return <span key={`${day}:${hour}`} className="pattern-cell" role="img" aria-label={description} style={style}>{body}</span>
              }
              return (
                <button
                  key={`${day}:${hour}`}
                  type="button"
                  className="pattern-cell"
                  data-cell={`${day}:${hour}`}
                  tabIndex={cursor.weekday === day && cursor.hour === hour ? 0 : -1}
                  aria-label={`${description}. Show sessions that started in this hour`}
                  style={style}
                  onFocus={() => setCursor({ weekday: day, hour })}
                  onKeyDown={(event) => moveCursor(event, day, hour)}
                  onClick={() => onSelectCell(day, hour)}
                >
                  {body}
                </button>
              )
            }),
          ])}
        </div>
      </div>
      <small>
        Hours use {patterns.timeZone}. Arrows mark changes of at least 20% from the preceding period.
        {onSelectCell
          ? ' Selecting a cell opens History filtered to the sessions that started in that hour; the grid counts every session heard during it.'
          : ''}
      </small>
      {/* The grid's change arrows carried their figure in a `title`, which a
          keyboard never reaches; the table is where that number now lives. */}
      <ChartDataTable
        summary={`View ${labels[metric].toLowerCase()} pattern data table`}
        caption={`${labels[metric]} by weekday and hour in ${patterns.timeZone}`}
        columns={['Weekday and hour', 'Aircraft', 'Sessions', 'Reports', 'Change vs preceding']}
        rows={weekdays.flatMap((weekday, day) =>
          Array.from({ length: 24 }, (_, hour) => {
            const cell = byCell.get(`${day}:${hour}`)
            const heading = `${weekday} ${String(hour).padStart(2, '0')}:00`
            return {
              key: `${day}:${hour}`,
              header: onSelectCell ? (
                <button type="button" className="text-button" onClick={() => onSelectCell(day, hour)}>
                  {heading}
                </button>
              ) : (
                heading
              ),
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
