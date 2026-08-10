import { useMemo } from 'react'
import { aircraftShape, shapePoints } from '../lib/aircraft-category'
import {
  aircraftLabel,
  altitudeColour,
  formatAltitude,
  formatBearing,
  formatDistance,
} from '../lib/format'
import { isNewSighting } from '../lib/sighting-preferences'
import { useUnitPreferences } from '../lib/unit-preferences'
import type { Aircraft } from '../types'

/**
 * How many aircraft the strip along the top of the sheet carries. Enough that
 * the answer to "what is that" is usually already on screen at the peek stop,
 * few enough that the strip is a glance rather than a second list.
 */
const NEAREST_COUNT = 6

interface Props {
  aircraft: Aircraft[]
  selectedIcao: string | null
  onSelect: (icao: string) => void
  /** Cutoff from the sighting preference; null when the marker is off. */
  newSince: number | null
  loading: boolean
  emptyTitle: string
  emptyDescription: string
}

/**
 * The glyph the map draws for this aircraft, at list size and turned to its
 * track. Sharing `shapePoints` with the map is what lets a row be matched to a
 * marker by shape rather than by reading the callsign off both.
 */
function AircraftGlyph({ aircraft, size }: { aircraft: Aircraft; size: number }) {
  const colour = altitudeColour(aircraft.altitudeBaro)
  return (
    <svg
      className="sheet-row-glyph"
      viewBox="0 0 34 34"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ transform: `rotate(${aircraft.track ?? 0}deg)` }}
    >
      <polygon points={shapePoints(aircraftShape(aircraft))} fill={colour} />
    </svg>
  )
}

/** WATCHED outranks NEW: it is the one the reader asked to be told about. */
function rowBadge(aircraft: Aircraft, newSince: number | null) {
  if (aircraft.watched) return { label: 'WATCHED', className: 'watched' }
  if (isNewSighting(aircraft.firstSeenAt, newSince)) return { label: 'NEW', className: 'new' }
  return null
}

/**
 * What the persistent sheet shows when no aircraft is selected: the nearest few
 * as cards that can be read from the peek stop, and the whole filtered list
 * below them for the stops that are tall enough to hold it.
 */
export function LiveSheetTraffic({
  aircraft,
  selectedIcao,
  onSelect,
  newSince,
  loading,
  emptyTitle,
  emptyDescription,
}: Props) {
  useUnitPreferences()

  /*
   * The list arrives in whatever order the table's sort asked for, which is not
   * necessarily by distance — but "overhead now" is a claim about distance, so
   * the strip sorts for itself rather than showing the top of someone else's
   * sort under that heading. Aircraft heard without a position have no distance
   * and cannot be nearest anything.
   *
   * A receiver with no position of its own has no distances at all, and the
   * strip is the whole of what the sheet shows at its first stop — so rather
   * than collapse to a bare heading there, it falls back to the head of the
   * list. It is still what is being heard right now, which is what the heading
   * claims; only the ordering is someone else's.
   */
  const positioned = useMemo(
    () =>
      aircraft
        .filter((item) => item.distanceNm != null)
        .sort((left, right) => (left.distanceNm ?? 0) - (right.distanceNm ?? 0)),
    [aircraft],
  )
  const nearest = (positioned.length ? positioned : aircraft).slice(0, NEAREST_COUNT)

  if (!aircraft.length) {
    return (
      <div className="sheet-empty">
        {loading ? (
          <p>Waiting for the first receiver snapshot…</p>
        ) : (
          <>
            <strong>{emptyTitle}</strong>
            <p>{emptyDescription}</p>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      {nearest.length ? (
        <div className="sheet-nearest" aria-label="Nearest aircraft">
          {nearest.map((item) => (
            <button
              key={item.icao}
              type="button"
              className={`sheet-nearest-card ${item.icao === selectedIcao ? 'selected' : ''}`}
              onClick={() => onSelect(item.icao)}
            >
              <span className="sheet-nearest-identity">
                <i style={{ background: altitudeColour(item.altitudeBaro) }} aria-hidden="true" />
                <strong>{aircraftLabel(item)}</strong>
              </span>
              <span className="sheet-nearest-type">
                {item.description ?? item.typeCode ?? 'Unidentified type'}
              </span>
              <span className="sheet-nearest-range">
                <strong>{formatDistance(item.distanceNm)}</strong>
                <span>{formatBearing(item.bearing)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="sheet-rows">
        {aircraft.map((item) => {
          const badge = rowBadge(item, newSince)
          return (
            <button
              key={item.icao}
              type="button"
              className={`sheet-row ${item.icao === selectedIcao ? 'selected' : ''}`}
              aria-current={item.icao === selectedIcao}
              onClick={() => onSelect(item.icao)}
            >
              <span
                className="sheet-row-tile"
                /* The tile is the marker's own colour at a twelfth strength, so
                   a row reads as the same aircraft as the dot on the map
                   without a second legend to learn. Both ramps are opaque hex,
                   so the tint is the same value with an alpha pair appended. */
                style={{ background: `${altitudeColour(item.altitudeBaro)}1f` }}
              >
                <AircraftGlyph aircraft={item} size={19} />
              </span>
              <span className="sheet-row-identity">
                <span className="sheet-row-name">
                  <strong>{aircraftLabel(item)}</strong>
                  {badge ? <span className={`sheet-row-badge ${badge.className}`}>{badge.label}</span> : null}
                </span>
                <small>
                  {item.registration || item.icao.toUpperCase()}
                  {item.typeCode ? ` · ${item.typeCode}` : ''}
                </small>
              </span>
              <span className="sheet-row-readings">
                <strong>{formatDistance(item.distanceNm)}</strong>
                <small style={{ color: altitudeColour(item.altitudeBaro) }}>
                  {formatAltitude(item.altitudeBaro)}
                </small>
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}
