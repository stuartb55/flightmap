import type { FeatureCollection, Point } from 'geojson'

export type ManchesterWaypointKind = 'arrival' | 'departure'

export interface ManchesterWaypoint {
  name: string
  kind: ManchesterWaypointKind
  latitude: number
  longitude: number
}

// Display-only reference points from the UK AIP Manchester SID/STAR charts
// current in AIRAC 07/2026. They are not intended for navigation.
export const MANCHESTER_WAYPOINTS: readonly ManchesterWaypoint[] = [
  { name: 'ROSUN', kind: 'arrival', latitude: 53.6689139, longitude: -2.3492389 },
  { name: 'MIRSI', kind: 'arrival', latitude: 53.5379694, longitude: -2.7117111 },
  { name: 'DAYNE', kind: 'arrival', latitude: 53.2386444, longitude: -2.0292389 },
  { name: 'ASMIM', kind: 'departure', latitude: 53.4461111, longitude: -2.6530556 },
  { name: 'KUXEM', kind: 'departure', latitude: 53.2530556, longitude: -2.6797222 },
  { name: 'EKLAD', kind: 'departure', latitude: 53.2538889, longitude: -2.8247222 },
  { name: 'LISTO', kind: 'departure', latitude: 53.1433333, longitude: -2.1991667 },
  { name: 'POL', kind: 'departure', latitude: 53.7438889, longitude: -2.1033333 },
  { name: 'SONEX', kind: 'departure', latitude: 53.4980556, longitude: -2.1725 },
  { name: 'DESIG', kind: 'departure', latitude: 53.5272222, longitude: -1.8927778 },
  { name: 'SANBA', kind: 'departure', latitude: 53.1394444, longitude: -2.3341667 },
]

export function manchesterWaypointData(): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: MANCHESTER_WAYPOINTS.map((waypoint) => ({
      type: 'Feature',
      properties: {
        name: waypoint.name,
        kind: waypoint.kind,
      },
      geometry: {
        type: 'Point',
        coordinates: [waypoint.longitude, waypoint.latitude],
      },
    })),
  }
}
