import { AlertTriangle, ChevronDown, ChevronUp, MapPinOff, Star } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  aircraftLabel,
  formatAltitude,
  formatBearing,
  formatDistance,
  formatSpeed,
  formatVerticalRate,
  verticalTrend,
} from '../lib/format'
import { useUnitPreferences } from '../lib/unit-preferences'
import type { AircraftSort, AircraftSortKey } from '../lib/aircraft-filter'
import { columnDefinitions, defaultColumns, type ColumnKey } from '../lib/table-columns'
import { useWindowList } from '../lib/use-window-list'
import type { Aircraft } from '../types'

interface Props {
  aircraft: Aircraft[]
  selectedIcao: string | null
  sort: AircraftSort
  onSort: (sort: AircraftSort) => void
  onSelect: (icao: string) => void
  columns?: readonly ColumnKey[]
  loading?: boolean
  emptyTitle?: string
  emptyDescription?: string
}

/**
 * `.aircraft-table td { height: 70px }` and `th { height: 44px }`, used until
 * the table can measure itself.
 */
const estimatedMetrics = { rowHeight: 70, headerHeight: 44 }

/**
 * Stands in for the rows the window leaves out, so the scrollbar reflects the
 * whole list. Hidden from assistive technology, which reads the real total from
 * `aria-rowcount` instead.
 */
function Spacer({ height, columns }: { height: number; columns: number }) {
  if (height <= 0) return null
  return (
    <tr aria-hidden="true" className="row-spacer">
      <td colSpan={columns} style={{ height, padding: 0, border: 0 }} />
    </tr>
  )
}

const trendGlyph = { climb: '↑', descent: '↓', level: '→' } as const
const trendLabel = { climb: 'Climbing', descent: 'Descending', level: 'Level' } as const

function AltitudeCell({ item }: { item: Aircraft }) {
  const trend = verticalTrend(item.verticalRate)
  return (
    <>
      <span className="primary-cell">{formatAltitude(item.altitudeBaro)}</span>
      {trend ? (
        <span className={`vertical-trend trend-${trend}`} title={formatVerticalRate(item.verticalRate)}>
          <span aria-hidden="true">{trendGlyph[trend]}</span>
          <span className="visually-hidden">
            {trendLabel[trend]}, {formatVerticalRate(item.verticalRate)}
          </span>
        </span>
      ) : null}
    </>
  )
}

function cellContent(key: ColumnKey, item: Aircraft, isSelected: boolean): ReactNode {
  switch (key) {
    case 'identity': {
      const isStale = (item.seenSeconds ?? 0) > 15
      return (
        <button
          className="aircraft-identity"
          type="button"
          aria-label={`Select ${aircraftLabel(item)}`}
          aria-pressed={isSelected}
        >
          <span className="aircraft-id-top">
            <strong>{aircraftLabel(item)}</strong>
            {item.watched ? <Star size={14} fill="currentColor" aria-label="Watched" /> : null}
            {item.hasActiveAlert ? <AlertTriangle size={15} aria-label="Active alert" /> : null}
            {item.latitude == null || item.longitude == null ? (
              <MapPinOff size={14} aria-label="No position" />
            ) : null}
            <span
              className={`freshness ${isStale ? 'freshness-stale' : ''}`}
              title="Time since last report"
            >
              {item.seenSeconds == null ? '—' : `${Math.round(item.seenSeconds)}s`}
            </span>
          </span>
          <small>
            {item.registration || item.icao.toUpperCase()}
            {item.typeCode ? ` · ${item.typeCode}` : ''}
          </small>
        </button>
      )
    }
    case 'altitude':
      return <AltitudeCell item={item} />
    case 'speed':
      return <span className="primary-cell">{formatSpeed(item.groundSpeed)}</span>
    case 'distance':
      return <span className="primary-cell">{formatDistance(item.distanceNm)}</span>
    case 'verticalRate':
      return <span className="primary-cell">{formatVerticalRate(item.verticalRate)}</span>
    case 'track':
      return <span className="primary-cell">{formatBearing(item.track ?? item.trueHeading)}</span>
    case 'squawk':
      return (
        <span
          className={`primary-cell ${['7500', '7600', '7700'].includes(item.squawk ?? '') ? 'danger-text' : ''}`}
        >
          {item.squawk ?? '—'}
        </span>
      )
    case 'operator':
      return <span className="primary-cell truncate-cell">{item.operator || '—'}</span>
    case 'type':
      return <span className="primary-cell">{item.typeCode || '—'}</span>
    case 'age':
      return (
        <span className="primary-cell">
          {item.seenSeconds == null ? '—' : `${Math.round(item.seenSeconds)}s`}
        </span>
      )
  }
}

/**
 * Rows update at 1 Hz, so each one is memoised. Live deltas replace only the
 * aircraft that changed, which leaves the rest referentially equal and lets
 * the comparison below skip them.
 */
const AircraftRow = memo(function AircraftRow({
  item,
  isSelected,
  columns,
  rowIndex,
  onSelect,
}: {
  item: Aircraft
  isSelected: boolean
  columns: readonly ColumnKey[]
  rowIndex: number
  onSelect: (icao: string) => void
}) {
  // Subscribing here rather than in the table means a unit change repaints the
  // rows despite the memo: their props are unchanged by it.
  useUnitPreferences()
  const isStale = (item.seenSeconds ?? 0) > 15
  return (
    <tr
      data-aircraft-row=""
      // The header is row one, so data rows start at two. Windowing removes
      // rows from the tree, and this is what keeps the position each row
      // reports true to the whole list rather than to the rendered slice.
      aria-rowindex={rowIndex + 2}
      className={`${isSelected ? 'selected' : ''} ${isStale ? 'stale' : ''}`}
      onClick={() => onSelect(item.icao)}
    >
      {columns.map((key) => (
        <td key={key} className={`col-${key}`}>
          {cellContent(key, item, isSelected)}
        </td>
      ))}
    </tr>
  )
})

export function AircraftTable({
  aircraft,
  selectedIcao,
  sort,
  onSort,
  onSelect,
  columns = defaultColumns,
  loading = false,
  emptyTitle = 'No aircraft match',
  emptyDescription = 'Try widening the current filters.',
}: Props) {
  const visible = columnDefinitions.filter((column) => columns.includes(column.key))
  const headRef = useRef<HTMLTableSectionElement>(null)
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  const hasRows = aircraft.length > 0
  const [metrics, setMetrics] = useState(estimatedMetrics)
  const { ref: scrollRef, range, scrollToIndex } = useWindowList<HTMLDivElement>({
    count: aircraft.length,
    ...metrics,
  })
  const scrolledTo = useRef<string | null>(null)

  // Rows are a fixed height set in CSS, but which fixed height depends on the
  // stylesheet in force — the mobile sheet is tighter than the desktop panel.
  // Measure rather than assume, and only when the shape of a row can have
  // changed, since reading layout back forces one.
  useLayoutEffect(() => {
    const rowHeight =
      bodyRef.current?.querySelector<HTMLTableRowElement>('tr[data-aircraft-row]')?.getBoundingClientRect()
        .height ?? 0
    const headerHeight = headRef.current?.getBoundingClientRect().height ?? 0
    if (!rowHeight) return
    setMetrics((current) =>
      Math.abs(current.rowHeight - rowHeight) < 0.5 &&
      Math.abs(current.headerHeight - headerHeight) < 0.5
        ? current
        : { rowHeight, headerHeight },
    )
  }, [columns, hasRows])

  // Keyboard navigation is useless if the row it moves to is off screen, and a
  // windowed row may not be in the tree at all. Scroll on a change of
  // selection only: re-sorting the list should not drag the view around.
  useEffect(() => {
    if (!selectedIcao) {
      scrolledTo.current = null
      return
    }
    if (scrolledTo.current === selectedIcao) return
    const index = aircraft.findIndex((item) => item.icao === selectedIcao)
    if (index < 0) return
    scrolledTo.current = selectedIcao
    scrollToIndex(
      index,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    )
  }, [aircraft, scrollToIndex, selectedIcao])

  const changeSort = (key: AircraftSortKey) =>
    onSort({
      key,
      direction: sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc',
    })

  return (
    <div className="aircraft-table-wrap" ref={scrollRef}>
      <table
        className={`aircraft-table ${visible.length > 4 ? 'wide-columns' : ''}`}
        // Windowing renders a slice, so the true total comes from here and from
        // each row's `aria-rowindex`; the header itself is row one.
        aria-rowcount={aircraft.length + 1}
      >
        <thead ref={headRef}>
          <tr aria-rowindex={1}>
            {visible.map((column) => (
              <th
                key={column.key}
                className={`col-${column.key}`}
                aria-sort={
                  sort.key === column.sortKey
                    ? sort.direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                <button type="button" onClick={() => changeSort(column.sortKey)}>
                  {column.label}
                  {sort.key === column.sortKey ? (
                    sort.direction === 'asc' ? (
                      <ChevronUp size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )
                  ) : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          <Spacer height={range.paddingTop} columns={visible.length} />
          {aircraft.slice(range.start, range.end).map((item, offset) => (
            <AircraftRow
              key={item.icao}
              item={item}
              isSelected={selectedIcao === item.icao}
              columns={columns}
              rowIndex={range.start + offset}
              onSelect={onSelect}
            />
          ))}
          <Spacer height={range.paddingBottom} columns={visible.length} />
        </tbody>
      </table>
      {!aircraft.length && loading ? (
        <div className="empty-state compact" role="status">
          <span className="mini-spinner" aria-hidden="true" />
          <strong>Loading aircraft</strong>
          <span>Waiting for the first receiver snapshot.</span>
        </div>
      ) : !aircraft.length ? (
        <div className="empty-state compact">
          <strong>{emptyTitle}</strong>
          <span>{emptyDescription}</span>
        </div>
      ) : null}
    </div>
  )
}
