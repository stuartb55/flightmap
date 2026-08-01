import { AlertTriangle, ChevronDown, ChevronUp, MapPinOff, Star } from 'lucide-react'
import { aircraftLabel, formatAltitude, formatDistance, formatSpeed } from '../lib/format'
import type { AircraftSort, AircraftSortKey } from '../lib/aircraft-filter'
import type { Aircraft } from '../types'

interface Props {
  aircraft: Aircraft[]
  selectedIcao: string | null
  sort: AircraftSort
  onSort: (sort: AircraftSort) => void
  onSelect: (icao: string) => void
  loading?: boolean
  emptyTitle?: string
  emptyDescription?: string
}

const columns: { key: AircraftSortKey; label: string }[] = [
  { key: 'identity', label: 'Aircraft' },
  { key: 'altitude', label: 'Altitude' },
  { key: 'speed', label: 'Speed' },
  { key: 'distance', label: 'Range' },
]

export function AircraftTable({
  aircraft,
  selectedIcao,
  sort,
  onSort,
  onSelect,
  loading = false,
  emptyTitle = 'No aircraft match',
  emptyDescription = 'Try widening the current filters.',
}: Props) {
  const changeSort = (key: AircraftSortKey) =>
    onSort({
      key,
      direction: sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc',
    })

  return (
    <div className="aircraft-table-wrap">
      <table className="aircraft-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                aria-sort={
                  sort.key === column.key
                    ? sort.direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                <button type="button" onClick={() => changeSort(column.key)}>
                  {column.label}
                  {sort.key === column.key ? (
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
          {aircraft.map((item) => {
            const isSelected = selectedIcao === item.icao
            const isStale = (item.seenSeconds ?? 0) > 15
            return (
              <tr
                key={item.icao}
                className={`${isSelected ? 'selected' : ''} ${isStale ? 'stale' : ''}`}
                onClick={() => onSelect(item.icao)}
              >
                <td>
                  <button
                    className="aircraft-identity"
                    type="button"
                    aria-label={`Select ${aircraftLabel(item)}`}
                    aria-pressed={isSelected}
                  >
                    <span className="aircraft-id-top">
                      <strong>{aircraftLabel(item)}</strong>
                      {item.watched ? <Star size={14} fill="currentColor" aria-label="Watched" /> : null}
                      {item.hasActiveAlert ? (
                        <AlertTriangle size={15} aria-label="Active alert" />
                      ) : null}
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
                </td>
                <td>
                  <span className="primary-cell">{formatAltitude(item.altitudeBaro)}</span>
                </td>
                <td>
                  <span className="primary-cell">{formatSpeed(item.groundSpeed)}</span>
                </td>
                <td>
                  <span className="primary-cell">{formatDistance(item.distanceNm)}</span>
                </td>
              </tr>
            )
          })}
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
