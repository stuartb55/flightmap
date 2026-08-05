import { describe, expect, it } from 'vitest'
import type { Airport } from '@flightmap/shared'
import { airportData, labelSortKey, runwayData } from './airports'

function airport(overrides: Partial<Airport> = {}): Airport {
  return {
    icao: 'EGCC',
    iata: 'MAN',
    name: 'Manchester Airport',
    latitude: 53.349375,
    longitude: -2.279521,
    elevationFt: 257,
    rank: 3,
    runways: [
      {
        ident: '05L/23R',
        lengthFt: 10_000,
        lowLatitude: 53.3451,
        lowLongitude: -2.29274,
        highLatitude: 53.3624,
        highLongitude: -2.25714,
      },
    ],
    ...overrides,
  }
}

describe('airport features', () => {
  it('places an airport at its coordinates in longitude-latitude order', () => {
    const [feature] = airportData([airport()]).features
    expect(feature?.geometry.coordinates).toEqual([-2.279521, 53.349375])
    expect(feature?.properties).toMatchObject({
      icao: 'EGCC',
      iata: 'MAN',
      name: 'Manchester Airport',
      rank: 3,
    })
  })

  /*
   * IATA is what most people recognise an airport by and fits the space a label
   * has at this zoom; ICAO is the fallback because every airport in the set has
   * one and a blank label would be worse than a less familiar code.
   */
  it('labels with IATA where there is one and ICAO where there is not', () => {
    expect(airportData([airport()]).features[0]?.properties?.label).toBe('MAN')
    expect(
      airportData([airport({ iata: null, icao: 'EGNM' })]).features[0]?.properties?.label,
    ).toBe('EGNM')
  })

  /*
   * MapLibre places the lowest sort key first and whatever is placed first wins
   * a collision, so the key has to run opposite to rank. Getting this backwards
   * would silently hand every contested label to the smallest airfield.
   */
  it('sorts a larger airport ahead of a smaller one for label collisions', () => {
    expect(labelSortKey(3)).toBeLessThan(labelSortKey(2))
    expect(labelSortKey(2)).toBeLessThan(labelSortKey(1))
    expect(labelSortKey(3)).toBe(0)

    const features = airportData([
      airport({ icao: 'EGCC', rank: 3 }),
      airport({ icao: 'EGCB', rank: 1 }),
    ]).features
    expect(features[0]?.properties?.sortKey).toBeLessThan(
      features[1]?.properties?.sortKey as number,
    )
  })

  it('renders an empty dataset as an empty collection rather than failing', () => {
    expect(airportData([])).toEqual({ type: 'FeatureCollection', features: [] })
    expect(runwayData([])).toEqual({ type: 'FeatureCollection', features: [] })
  })
})

describe('runway features', () => {
  it('draws a centreline between the two thresholds', () => {
    const [feature] = runwayData([airport()]).features
    expect(feature?.geometry.coordinates).toEqual([
      [-2.29274, 53.3451],
      [-2.25714, 53.3624],
    ])
    expect(feature?.properties).toMatchObject({ icao: 'EGCC', ident: '05L/23R', lengthFt: 10_000 })
  })

  it('flattens every runway of every airport into one collection', () => {
    const features = runwayData([
      airport(),
      airport({
        icao: 'EGGP',
        runways: [
          {
            ident: '09/27',
            lengthFt: 7_500,
            lowLatitude: 53.33,
            lowLongitude: -2.86,
            highLatitude: 53.33,
            highLongitude: -2.84,
          },
        ],
      }),
    ]).features
    expect(features).toHaveLength(2)
    expect(features.map((feature) => feature.id)).toEqual(['EGCC-05L/23R', 'EGGP-09/27'])
  })

  it('contributes nothing for an airport with no published runways', () => {
    expect(runwayData([airport({ runways: [] })]).features).toEqual([])
  })
})
