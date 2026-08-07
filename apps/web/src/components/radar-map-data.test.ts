import { describe, expect, it, vi } from 'vitest'
import {
  aircraftIconId,
  applyBasemapContrast,
  bandDescription,
  bandLabel,
  greatCircle,
  needsRecentre,
  interpolateTrack,
  isEmergencyAircraft,
  liveAircraftData,
  replayPointAtTime,
  resolveStyleImageAlias,
  rulerData,
} from './radar-map-data'
import { altitudeBands } from '../lib/altitude-bands'
import { aviationUnits, metricUnits } from '../lib/unit-preferences'
import { aircraft } from '../test/fixtures'
import type { TrackPoint } from '../types'

describe('track interpolation', () => {
  const points: TrackPoint[] = [
    {
      recordedAt: '2026-07-29T12:00:00.000Z',
      latitude: 53,
      longitude: -2,
      altitudeFt: 10_000,
      groundSpeedKt: 300,
      trackDegrees: 90,
    },
    {
      recordedAt: '2026-07-29T12:00:10.000Z',
      latitude: 54,
      longitude: -1,
      altitudeFt: 12_000,
      groundSpeedKt: 320,
      trackDegrees: 100,
    },
  ]

  it('interpolates between stored source-of-truth samples', () => {
    const result = interpolateTrack(points, Date.parse('2026-07-29T12:00:05.000Z'))
    expect(result).toMatchObject({
      latitude: 53.5,
      longitude: -1.5,
      altitudeFt: 11_000,
      groundSpeedKt: 310,
      trackDegrees: 95,
    })
  })

  it('clamps to the first and last samples', () => {
    expect(interpolateTrack(points, Date.parse('2026-07-29T11:00:00.000Z'))).toBe(points[0])
    expect(interpolateTrack(points, Date.parse('2026-07-29T13:00:00.000Z'))).toBe(points[1])
  })

  it('omits a replay marker outside its session time range', () => {
    expect(replayPointAtTime(points, Date.parse('2026-07-29T11:59:59.000Z'))).toBeNull()
    expect(replayPointAtTime(points, Date.parse('2026-07-29T12:00:11.000Z'))).toBeNull()
    expect(replayPointAtTime(points, Date.parse('2026-07-29T12:00:05.000Z'))?.latitude).toBe(53.5)
  })

  it('distinguishes emergencies from ordinary alert states', () => {
    expect(isEmergencyAircraft({ squawk: '7700', emergency: 'none' })).toBe(true)
    expect(isEmergencyAircraft({ squawk: '1234', emergency: 'no emergency' })).toBe(false)
    expect(isEmergencyAircraft({ squawk: '1234', emergency: 'no_emergency' })).toBe(false)
    expect(isEmergencyAircraft({ squawk: '1234', emergency: 'general' })).toBe(true)
  })
})

/*
 * An aircraft can be several things at once, and the halos are separate layers
 * that would otherwise all draw. Precedence is resolved into the feature so
 * exactly one matches: emergency, then alert, then watchlist, then new. A first
 * sighting is the least urgent of the four and must never be what somebody sees
 * where an alert should have been.
 */
describe('map emphasis precedence', () => {
  const cutoff = Date.parse('2026-08-01T00:00:00.000Z')
  const newly = { firstSeenAt: '2026-08-04T09:00:00.000Z' }
  const propertiesFor = (overrides: Parameters<typeof aircraft>[0]) =>
    liveAircraftData([aircraft({ ...newly, ...overrides })], aviationUnits, null, cutoff)
      .features[0]!.properties!

  it('marks a first sighting that is nothing else', () => {
    expect(propertiesFor({})).toMatchObject({ newSighting: 1, emergency: 0, watched: 0 })
  })

  it('yields to an emergency, an alert, and the watchlist', () => {
    expect(propertiesFor({ squawk: '7700' })).toMatchObject({ newSighting: 0, emergency: 1 })
    expect(propertiesFor({ hasActiveAlert: true }).newSighting).toBe(0)
    expect(propertiesFor({ watched: true })).toMatchObject({ newSighting: 0, watched: 1 })
  })

  it('marks nothing when the preference is off or the airframe is not new', () => {
    expect(
      liveAircraftData([aircraft(newly)], aviationUnits, null, null).features[0]!.properties!
        .newSighting,
    ).toBe(0)
    expect(propertiesFor({ firstSeenAt: '2019-01-02T09:00:00.000Z' }).newSighting).toBe(0)
    expect(propertiesFor({ firstSeenAt: null }).newSighting).toBe(0)
  })
})

describe('aircraftIconId', () => {
  it('pairs a shape with its altitude band', () => {
    expect(aircraftIconId('heavy', 'middle')).toBe('aircraft-heavy-middle')
  })

  it('keeps surface vehicles on the ground colour whatever the altitude band', () => {
    expect(aircraftIconId('ground', 'unknown')).toBe('aircraft-ground-ground')
    expect(aircraftIconId('ground', 'high')).toBe('aircraft-ground-ground')
  })
})

describe('needsRecentre', () => {
  it('leaves the camera alone for an aircraft comfortably in view', () => {
    expect(needsRecentre({ x: 500, y: 400 }, 1000, 800)).toBe(false)
  })

  it('recentres when the aircraft is off screen', () => {
    expect(needsRecentre({ x: -40, y: 400 }, 1000, 800)).toBe(true)
    expect(needsRecentre({ x: 1200, y: 400 }, 1000, 800)).toBe(true)
    expect(needsRecentre({ x: 500, y: -10 }, 1000, 800)).toBe(true)
    expect(needsRecentre({ x: 500, y: 900 }, 1000, 800)).toBe(true)
  })

  it('treats an aircraft crowding an edge as needing a recentre', () => {
    expect(needsRecentre({ x: 20, y: 400 }, 1000, 800)).toBe(true)
    expect(needsRecentre({ x: 985, y: 400 }, 1000, 800)).toBe(true)
  })

  it('clamps the margin so a small map does not recentre on everything', () => {
    // A 120px-wide map would have no interior at all with a 90px margin.
    expect(needsRecentre({ x: 60, y: 60 }, 120, 120)).toBe(false)
    expect(needsRecentre({ x: 5, y: 60 }, 120, 120)).toBe(true)
  })

  it('recentres when the map has not been laid out yet', () => {
    expect(needsRecentre({ x: 0, y: 0 }, 0, 0)).toBe(true)
  })
})

describe('resolveStyleImageAlias', () => {
  it('registers the OpenFreeMap circle image under the ID used by its style', () => {
    const source = {
      data: {
        width: 15,
        height: 15,
        data: new Uint8Array(15 * 15 * 4),
      },
      pixelRatio: 1,
      sdf: false,
    }
    const map = {
      hasImage: vi.fn((id: string) => id === 'circle_11'),
      getImage: vi.fn(() => source),
      addImage: vi.fn(),
    }

    resolveStyleImageAlias(map as never, 'circle-11')

    expect(map.getImage).toHaveBeenCalledWith('circle_11')
    expect(map.addImage).toHaveBeenCalledWith(
      'circle-11',
      {
        width: 15,
        height: 15,
        data: source.data.data,
      },
      expect.objectContaining({ pixelRatio: 1, sdf: false }),
    )
  })

  it('ignores unrelated missing images', () => {
    const map = {
      hasImage: vi.fn(),
      getImage: vi.fn(),
      addImage: vi.fn(),
    }

    resolveStyleImageAlias(map as never, 'airport')

    expect(map.hasImage).not.toHaveBeenCalled()
    expect(map.getImage).not.toHaveBeenCalled()
    expect(map.addImage).not.toHaveBeenCalled()
  })
})

describe('greatCircle', () => {
  it('measures a known leg in nautical miles and degrees', () => {
    // Manchester to Heathrow, roughly 131 nm on a south-south-east track.
    const result = greatCircle([-2.275, 53.3537], [-0.4543, 51.47])
    expect(result.distanceNm).toBeCloseTo(131.3, 1)
    expect(result.bearingDegrees).toBeCloseTo(148.8, 1)
  })

  it('measures a degree of latitude as sixty nautical miles either way round', () => {
    expect(greatCircle([-2, 53], [-2, 54]).distanceNm).toBeCloseTo(60, 0)
    expect(greatCircle([-2, 54], [-2, 53]).distanceNm).toBeCloseTo(60, 0)
  })

  it('reports the cardinal bearings', () => {
    expect(greatCircle([-2, 53], [-2, 54]).bearingDegrees).toBeCloseTo(0, 6)
    expect(greatCircle([-2, 54], [-2, 53]).bearingDegrees).toBeCloseTo(180, 6)
    expect(greatCircle([0, 0], [1, 0]).bearingDegrees).toBeCloseTo(90, 6)
    expect(greatCircle([0, 0], [-1, 0]).bearingDegrees).toBeCloseTo(270, 6)
  })

  it('reports no distance between a point and itself', () => {
    expect(greatCircle([-2, 53], [-2, 53]).distanceNm).toBe(0)
  })
})

describe('rulerData', () => {
  it('draws the endpoints on their own until the line is complete', () => {
    expect(rulerData([]).features).toHaveLength(0)
    expect(rulerData([[-2, 53]]).features.map((feature) => feature.geometry.type)).toEqual(['Point'])
    expect(rulerData([[-2, 53], [-1, 54]]).features.map((feature) => feature.geometry.type)).toEqual([
      'Point',
      'Point',
      'LineString',
    ])
  })
})

describe('altitude legend labels', () => {
  const band = (key: string) => altitudeBands().find((item) => item.key === key)!

  it('labels each segment with the floor of its band', () => {
    expect(bandLabel(band('ground'), aviationUnits)).toBe('GND')
    expect(bandLabel(band('low'), aviationUnits)).toBe('0')
    expect(bandLabel(band('middle'), aviationUnits)).toBe('10k')
    expect(bandLabel(band('extreme'), aviationUnits)).toBe('40k+')
  })

  it('follows the unit preference into metres', () => {
    expect(bandLabel(band('middle'), metricUnits)).toBe('3.0k')
  })

  it('describes what isolating a band would show', () => {
    expect(bandDescription(band('ground'), aviationUnits)).toBe('on the ground')
    expect(bandDescription(band('high'), aviationUnits)).toBe('from 20,000 ft to 30,000 ft')
    expect(bandDescription(band('extreme'), aviationUnits)).toBe('above 40,000 ft')
  })
})

describe('applyBasemapContrast', () => {
  const style = {
    layers: [
      { id: 'highway-motorway', type: 'line', 'source-layer': 'transportation' },
      { id: 'highway-motorway-casing', type: 'line', 'source-layer': 'transportation' },
      { id: 'highway-name-major', type: 'symbol', 'source-layer': 'transportation_name' },
      { id: 'place-city', type: 'symbol', 'source-layer': 'place' },
      { id: 'water', type: 'fill', 'source-layer': 'water' },
      { id: 'landcover-grass', type: 'fill', 'source-layer': 'landcover' },
      { id: 'background', type: 'background' },
    ],
  }
  const stubMap = () => ({ getStyle: vi.fn(() => style), setPaintProperty: vi.fn() })

  it('lifts roads and their labels without touching widths', () => {
    const map = stubMap()
    applyBasemapContrast(map as never, 'dark')

    const properties = map.setPaintProperty.mock.calls.map(([, property]) => property)
    expect(properties).not.toContain('line-width')
    expect(properties).not.toContain('text-size')
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      'place-city',
      'text-color',
      expect.any(String),
    )
  })

  it('keeps the road hierarchy in one expression rather than flattening it', () => {
    const map = stubMap()
    applyBasemapContrast(map as never, 'dark')

    const fill = map.setPaintProperty.mock.calls.find(
      ([id, property]) => id === 'highway-motorway' && property === 'line-color',
    )
    expect(fill?.[2]).toEqual(expect.arrayContaining(['match', ['get', 'class']]))
  })

  /* Casings are wider than the fill they sit under, so lifting both would draw
     the road as a band of flat colour rather than a line with an edge. */
  it('holds road casings near the background', () => {
    const map = stubMap()
    applyBasemapContrast(map as never, 'dark')

    const casing = map.setPaintProperty.mock.calls.find(
      ([id, property]) => id === 'highway-motorway-casing' && property === 'line-color',
    )
    expect(typeof casing?.[2]).toBe('string')
  })

  it('leaves layers it does not recognise alone', () => {
    const map = stubMap()
    applyBasemapContrast(map as never, 'dark')

    const touched = map.setPaintProperty.mock.calls.map(([id]) => id)
    expect(touched).not.toContain('landcover-grass')
    expect(touched).not.toContain('background')
  })

  /* The bright style's road colouring is already the conventional one and
     already clears its pale background. */
  it('leaves the light basemap untouched', () => {
    const map = stubMap()
    applyBasemapContrast(map as never, 'light')

    expect(map.setPaintProperty).not.toHaveBeenCalled()
  })
})

/* The real style keeps railway hatching in a companion layer drawn over the
   line, so lifting it fills the hatch in and the railway reads as a road. */
describe('applyBasemapContrast decoration layers', () => {
  it('leaves railway dashlines at the colour the style chose', () => {
    const map = {
      getStyle: vi.fn(() => ({
        layers: [
          { id: 'railway', type: 'line', 'source-layer': 'transportation' },
          { id: 'railway_dashline', type: 'line', 'source-layer': 'transportation' },
        ],
      })),
      setPaintProperty: vi.fn(),
    }

    applyBasemapContrast(map as never, 'dark')

    const touched = map.setPaintProperty.mock.calls.map(([id]) => id)
    expect(touched).toContain('railway')
    expect(touched).not.toContain('railway_dashline')
  })
})
