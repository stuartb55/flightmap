import { AlertTriangle, ChevronDown, ChevronUp, MapPinOff, Star } from 'lucide-react'
import { memo, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import {
  aircraftLabel,
  formatAltitude,
  formatBearing,
  formatDistance,
  formatSpeed,
  formatVerticalRate,
  verticalTrend,
} from '../lib/format'
import type { AircraftSort, AircraftSortKey } from '../lib/aircraft-filter'
import { columnDefinitions, defaultColumns, type ColumnKey } from '../lib/table-columns'
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
  rowRef,
  onSelect,
}: {
  item: Aircraft
  isSelected: boolean
  columns: readonly ColumnKey[]
  rowRef?: RefObject<HTMLTableRowElement | null>
  onSelect: (icao: string) => void
}) {
  const isStale = (item.seenSeconds ?? 0) > 15
  return (
    <tr
      ref={rowRef}
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
  const selectedRowRef = useRef<HTMLTableRowElement>(null)

  // Keyboard navigation is useless if the row it moves to is off screen. Only
  // the nearest edge is scrolled, so a row already in view does not jump.
  useEffect(() => {
    if (!selectedIcao) return
    selectedRowRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    })
  }, [selectedIcao])

  const changeSort = (key: AircraftSortKey) =>
    onSort({
      key,
      direction: sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc',
    })

  return (
    <div className="aircraft-table-wrap">
      <table className={`aircraft-table ${visible.length > 4 ? 'wide-columns' : ''}`}>
        <thead>
          <tr>
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
        <tbody>
          {aircraft.map((item) => (
            <AircraftRow
              key={item.icao}
              item={item}
              isSelected={selectedIcao === item.icao}
              columns={columns}
              rowRef={selectedIcao === item.icao ? selectedRowRef : undefined}
              onSelect={onSelect}
            />
          ))}
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
