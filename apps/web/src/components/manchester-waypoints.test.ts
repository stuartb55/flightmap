import { describe, expect, it } from 'vitest'
import { MANCHESTER_WAYPOINTS, manchesterWaypointData } from './manchester-waypoints'

describe('Manchester route waypoints', () => {
  it('includes the three terminal arrival fixes and the local departure endpoints', () => {
    expect(
      MANCHESTER_WAYPOINTS.filter((waypoint) => waypoint.kind === 'arrival').map(
        (waypoint) => waypoint.name,
      ),
    ).toEqual(['ROSUN', 'MIRSI', 'DAYNE'])
    expect(
      MANCHESTER_WAYPOINTS.filter((waypoint) => waypoint.kind === 'departure').map(
        (waypoint) => waypoint.name,
      ),
    ).toEqual(['ASMIM', 'KUXEM', 'EKLAD', 'LISTO', 'POL', 'SONEX', 'DESIG', 'SANBA'])
  })

  it('builds GeoJSON with longitude first', () => {
    const rosun = manchesterWaypointData().features.find(
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
})
