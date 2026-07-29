import { describe, expect, it } from 'vitest'
import {
  aircraftFilterErrors,
  defaultAircraftFilters,
  filterAircraft,
  sortAircraft,
} from './aircraft-filter'
import { aircraft } from '../test/fixtures'

describe('aircraft filtering and sorting', () => {
  const items = [
    aircraft({ icao: '406b90', callsign: 'EZY42KD', distanceNm: 25, altitudeBaro: 18_000 }),
    aircraft({
      icao: '4ca123',
      callsign: null,
      registration: 'EI-DCL',
      latitude: null,
      longitude: null,
      distanceNm: null,
      altitudeBaro: 'ground',
      watched: true,
    }),
  ]

  it('matches callsign, registration, and ICAO case-insensitively', () => {
    expect(filterAircraft(items, { ...defaultAircraftFilters, query: '42kd' })).toHaveLength(1)
    expect(filterAircraft(items, { ...defaultAircraftFilters, query: 'ei-dcl' })[0]?.icao).toBe('4ca123')
    expect(filterAircraft(items, { ...defaultAircraftFilters, query: '406B90' })[0]?.callsign).toBe('EZY42KD')
  })

  it('keeps non-position reports available to a dedicated filter', () => {
    const result = filterAircraft(items, {
      ...defaultAircraftFilters,
      position: 'unpositioned',
    })
    expect(result.map((item) => item.icao)).toEqual(['4ca123'])
  })

  it('combines category, speed, and receiver-range filters', () => {
    const result = filterAircraft(items, {
      ...defaultAircraftFilters,
      category: 'A3',
      minimumSpeed: '300',
      maximumDistance: '30',
    })
    expect(result.map((item) => item.icao)).toEqual(['406b90'])
  })

  it('sorts null values after real distances', () => {
    const result = sortAircraft(items, { key: 'distance', direction: 'asc' })
    expect(result.map((item) => item.icao)).toEqual(['406b90', '4ca123'])
  })

  it('keeps null values last for descending sorts too', () => {
    const result = sortAircraft(items, { key: 'distance', direction: 'desc' })
    expect(result.map((item) => item.icao)).toEqual(['406b90', '4ca123'])
  })

  it('reports invalid numeric filter input and inverted altitude bounds', () => {
    expect(
      aircraftFilterErrors({
        ...defaultAircraftFilters,
        minimumSpeed: 'fast',
        minimumAltitude: '10000',
        maximumAltitude: '5000',
      }),
    ).toMatchObject({
      minimumSpeed: expect.any(String),
      maximumAltitude: expect.any(String),
    })
  })
})
