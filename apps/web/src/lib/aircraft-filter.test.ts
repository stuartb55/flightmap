import { describe, expect, it } from 'vitest'
import {
  activeFilterCount,
  aircraftFilterErrors,
  defaultAircraftFilters,
  filterAircraft,
  nextSelectionIndex,
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

describe('remaining filter and sort branches', () => {
  const positioned = aircraft({ icao: '406b90', seenSeconds: 2, groundSpeed: 410 })
  const grounded = aircraft({
    icao: '4ca123',
    callsign: 'BAW11X',
    altitudeBaro: 'ground',
    groundSpeed: 0,
    seenSeconds: 45,
    hasActiveAlert: true,
    watched: true,
    source: 'mlat',
    category: 'A1',
  })
  const items = [positioned, grounded]

  it('treats ground as zero feet for altitude bounds', () => {
    expect(
      filterAircraft(items, { ...defaultAircraftFilters, maximumAltitude: '1000' }).map(
        (item) => item.icao,
      ),
    ).toEqual(['4ca123'])
    expect(
      filterAircraft(items, { ...defaultAircraftFilters, minimumAltitude: '1000' }).map(
        (item) => item.icao,
      ),
    ).toEqual(['406b90'])
  })

  it('filters on freshness, position, source, watchlist and alerts', () => {
    expect(
      filterAircraft(items, { ...defaultAircraftFilters, maximumFreshness: '15' }),
    ).toHaveLength(1)
    expect(
      filterAircraft(items, { ...defaultAircraftFilters, position: 'positioned' }),
    ).toHaveLength(2)
    expect(filterAircraft(items, { ...defaultAircraftFilters, source: 'mlat' })).toHaveLength(1)
    expect(filterAircraft(items, { ...defaultAircraftFilters, watchedOnly: true })).toHaveLength(1)
    expect(filterAircraft(items, { ...defaultAircraftFilters, alertsOnly: true })).toHaveLength(1)
    expect(filterAircraft(items, { ...defaultAircraftFilters, query: 'nothing' })).toHaveLength(0)
  })

  it('sorts by identity, altitude, speed and freshness', () => {
    expect(
      sortAircraft(items, { key: 'identity', direction: 'asc' }).map((item) => item.icao),
    ).toEqual(['4ca123', '406b90'])
    expect(
      sortAircraft(items, { key: 'altitude', direction: 'desc' }).map((item) => item.icao),
    ).toEqual(['406b90', '4ca123'])
    expect(
      sortAircraft(items, { key: 'speed', direction: 'asc' }).map((item) => item.icao),
    ).toEqual(['4ca123', '406b90'])
    expect(
      sortAircraft(items, { key: 'freshness', direction: 'asc' }).map((item) => item.icao),
    ).toEqual(['406b90', '4ca123'])
  })

  it('counts active filters but not the free-text query', () => {
    expect(activeFilterCount(defaultAircraftFilters)).toBe(0)
    expect(
      activeFilterCount({
        ...defaultAircraftFilters,
        query: 'ezy',
        watchedOnly: true,
        position: 'positioned',
        minimumAltitude: '5000',
      }),
    ).toBe(3)
  })

  it('accepts valid numeric bounds without reporting errors', () => {
    expect(
      aircraftFilterErrors({
        ...defaultAircraftFilters,
        minimumAltitude: '1000',
        maximumAltitude: '10000',
        maximumFreshness: '30',
      }),
    ).toEqual({})
    expect(
      aircraftFilterErrors({ ...defaultAircraftFilters, maximumDistance: '-5' }),
    ).toMatchObject({ maximumDistance: expect.any(String) })
  })
})

describe('nextSelectionIndex', () => {
  it('steps forwards and backwards through the visible list', () => {
    expect(nextSelectionIndex(0, 5, 1)).toBe(1)
    expect(nextSelectionIndex(3, 5, -1)).toBe(2)
  })

  it('stops at both ends instead of wrapping', () => {
    expect(nextSelectionIndex(4, 5, 1)).toBe(4)
    expect(nextSelectionIndex(0, 5, -1)).toBe(0)
  })

  it('starts from the appropriate end when nothing is selected', () => {
    expect(nextSelectionIndex(-1, 5, 1)).toBe(0)
    expect(nextSelectionIndex(-1, 5, -1)).toBe(4)
  })

  it('jumps to the first and last aircraft', () => {
    expect(nextSelectionIndex(2, 5, 'first')).toBe(0)
    expect(nextSelectionIndex(2, 5, 'last')).toBe(4)
  })

  it('has nowhere to move in an empty list', () => {
    expect(nextSelectionIndex(-1, 0, 1)).toBeNull()
    expect(nextSelectionIndex(-1, 0, 'first')).toBeNull()
  })
})
