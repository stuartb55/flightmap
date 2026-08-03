import { describe, expect, it } from 'vitest'
import { waypointData, type Waypoint } from './waypoints'

const points: Waypoint[] = [
  { name: 'ROSUN', kind: 'arrival', latitude: 53.6689139, longitude: -2.3492389 },
  { name: 'POL', kind: 'departure', latitude: 53.7438889, longitude: -2.1033333 },
]

describe('configured route waypoints', () => {
  it('builds GeoJSON with longitude first', () => {
    const rosun = waypointData(points).features.find(
      (feature) => feature.properties?.name === 'ROSUN',
    )

    expect(rosun).toMatchObject({
      properties: { name: 'ROSUN', kind: 'arrival' },
      geometry: {
        type: 'Point',
        coordinates: [-2.3492389, 53.6689139],
      },
    })
  })

  it('produces an empty collection when no waypoints are configured', () => {
    expect(waypointData([])).toEqual({ type: 'FeatureCollection', features: [] })
  })
})
