import type { FeatureCollection, Point } from 'geojson'
import { mapWaypoints } from '../config'

export type WaypointKind = 'arrival' | 'departure'

export interface Waypoint {
  name: string
  kind: WaypointKind
  latitude: number
  longitude: number
}

/**
 * Display-only reference points supplied by the server's `mapWaypoints`
 * setting, so a receiver anywhere can show its own arrival and departure
 * fixes. They are not intended for navigation.
 */
export function waypoints(): readonly Waypoint[] {
  return mapWaypoints()
}

export function waypointData(
  points: readonly Waypoint[] = waypoints(),
): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: points.map((waypoint) => ({
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
