import { aircraftShape, shapePoints } from '../lib/aircraft-category'
import { aircraftLabel, altitudeColour, formatAltitude, formatDistance } from '../lib/format'
import { useUnitPreferences } from '../lib/unit-preferences'
import type { Aircraft } from '../types'

interface Props {
  /** Matches for the current query, best first. Empty means no aircraft match. */
  matches: Aircraft[]
  query: string
  activeIndex: number
  onSelect: (icao: string) => void
}

/**
 * What the map's search field found, listed under it.
 *
 * The field used to do nothing but narrow the list in the sheet below, which at
 * the peek stop is a strip at the bottom of the screen and — once an aircraft
 * is selected — is not on screen at all. Typing the callsign of an aircraft
 * plainly visible on the map then produced no visible change whatsoever. The
 * answer belongs directly under the question, where it is visible at every
 * sheet stop, and picking one is what takes the map to that aircraft.
 */
export function MapSearchResults({ matches, query, activeIndex, onSelect }: Props) {
  const units = useUnitPreferences()

  if (!matches.length) {
    return (
      <div className="map-search-results" role="status">
        <p className="map-search-empty">
          No aircraft match <strong>{query.trim()}</strong>.
        </p>
      </div>
    )
  }

  return (
    <div className="map-search-results">
      <ul id="map-search-listbox" role="listbox" aria-label="Search results">
        {matches.map((item, index) => (
          <li key={item.icao} role="presentation">
            <button
              type="button"
              id={`map-search-result-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`map-search-result ${index === activeIndex ? 'active' : ''}`}
              /* Pointer down rather than click: the field is focused, and a tap
                 that first blurs it would close this list out from under the
                 finger before the click ever landed. */
              onPointerDown={(event) => {
                event.preventDefault()
                onSelect(item.icao)
              }}
            >
              <span
                className="map-search-result-tile"
                style={{ background: `${altitudeColour(item.altitudeBaro)}1f` }}
              >
                <svg
                  viewBox="0 0 34 34"
                  width={17}
                  height={17}
                  aria-hidden="true"
                  style={{ transform: `rotate(${item.track ?? 0}deg)` }}
                >
                  <polygon
                    points={shapePoints(aircraftShape(item))}
                    fill={altitudeColour(item.altitudeBaro)}
                  />
                </svg>
              </span>
              <span className="map-search-result-identity">
                <strong>{aircraftLabel(item)}</strong>
                <small>
                  {item.registration || item.icao.toUpperCase()}
                  {item.typeCode ? ` · ${item.typeCode}` : ''}
                </small>
              </span>
              <span className="map-search-result-readings">
                {/* An aircraft heard without a position can still be opened —
                    it just cannot be gone to, and saying so here is kinder than
                    a dash the reader has to interpret at the far end of a tap. */}
                {item.latitude == null || item.longitude == null ? (
                  <small>No position</small>
                ) : (
                  <>
                    <strong>{formatDistance(item.distanceNm, units)}</strong>
                    <small style={{ color: altitudeColour(item.altitudeBaro) }}>
                      {formatAltitude(item.altitudeBaro, units)}
                    </small>
                  </>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
