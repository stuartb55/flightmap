import type { FeatureCollection, LineString, Point } from 'geojson'
import type { Airport } from '@flightmap/shared'

/**
 * Airports and runway centrelines as GeoJSON, mirroring `waypoints.ts`.
 *
 * The dataset comes from `GET /api/v1/airports` rather than the page config
 * blob, because it is a few thousand records rather than eleven — see
 * `docs/airports.md`. These are display-only reference points; they are not
 * intended for navigation.
 */

/**
 * MapLibre places the feature with the *lowest* `symbol-sort-key` first, and
 * whatever is placed first wins a collision. Rank runs the other way — 3 is a
 * large airport — so it is inverted here rather than in the layer, where the
 * reason for the arithmetic would not be visible.
 */
export function labelSortKey(rank: number): number {
  return 3 - rank
}

export function airportData(airports: readonly Airport[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: airports.map((airport) => ({
      type: 'Feature',
      id: airport.icao,
      properties: {
        icao: airport.icao,
        iata: airport.iata,
        name: airport.name,
        rank: airport.rank,
        sortKey: labelSortKey(airport.rank),
        // IATA is what most people recognise an airport by and is three
        // characters wide, which is what a label at this zoom has room for;
        // ICAO is the fallback because every airport in the set has one.
        label: airport.iata ?? airport.icao,
        elevationFt: airport.elevationFt,
      },
      geometry: { type: 'Point', coordinates: [airport.longitude, airport.latitude] },
    })),
  }
}

export function runwayData(airports: readonly Airport[]): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: airports.flatMap((airport) =>
      airport.runways.map((runway) => ({
        type: 'Feature' as const,
        id: `${airport.icao}-${runway.ident}`,
        properties: {
          icao: airport.icao,
          ident: runway.ident,
          lengthFt: runway.lengthFt,
        },
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [runway.lowLongitude, runway.lowLatitude],
            [runway.highLongitude, runway.highLatitude],
          ],
        },
      })),
    ),
  }
}
