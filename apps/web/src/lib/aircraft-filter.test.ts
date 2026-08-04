import { describe, expect, it } from 'vitest'
import {
  activeFilterCount,
  aircraftFilterErrors,
  defaultAircraftFilters,
  filterAircraft,
  filtersFromParams,
  membershipKey,
  nextSelectionIndex,
  orderAircraft,
  reorderIntervalMs,
  sortAircraft,
  writeFiltersToParams,
  type AircraftSort,
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

describe('orderAircraft', () => {
  const filters = { ...defaultAircraftFilters }
  const sort: AircraftSort = { key: 'distance', direction: 'asc' }
  const near = aircraft({ icao: '406b90', distanceNm: 10 })
  const far = aircraft({ icao: '4ca123', distanceNm: 40 })
  const snapshot = [far, near]

  it('filters and sorts on the first pass', () => {
    const order = orderAircraft(snapshot, filters, sort, null, 0)
    expect(order.list.map((item) => item.icao)).toEqual(['406b90', '4ca123'])
  })

  it('reapplies the order to fresh telemetry without re-sorting', () => {
    const first = orderAircraft(snapshot, filters, sort, null, 0)
    // The two have swapped places in reality, but a change of telemetry alone
    // must not reshuffle the list under the pointer.
    const moved = [aircraft({ icao: '4ca123', distanceNm: 5 }), aircraft({ icao: '406b90', distanceNm: 45 })]
    const second = orderAircraft(moved, filters, sort, first, 1_000)

    expect(second.list.map((item) => item.icao)).toEqual(['406b90', '4ca123'])
    expect(second.list[0]?.distanceNm).toBe(45)
    expect(second.orderedAt).toBe(first.orderedAt)
  })

  it('re-sorts once the order has been held longer than the ceiling', () => {
    const first = orderAircraft(snapshot, filters, sort, null, 0)
    const moved = [aircraft({ icao: '4ca123', distanceNm: 5 }), aircraft({ icao: '406b90', distanceNm: 45 })]
    const second = orderAircraft(moved, filters, sort, first, reorderIntervalMs)

    expect(second.list.map((item) => item.icao)).toEqual(['4ca123', '406b90'])
    expect(second.orderedAt).toBe(reorderIntervalMs)
  })

  it('re-sorts as soon as an aircraft joins or leaves', () => {
    const first = orderAircraft(snapshot, filters, sort, null, 0)
    const joined = [...snapshot, aircraft({ icao: '3c6444', distanceNm: 1 })]
    const second = orderAircraft(joined, filters, sort, first, 10)
    expect(second.list.map((item) => item.icao)).toEqual(['3c6444', '406b90', '4ca123'])

    const left = orderAircraft([near], filters, sort, second, 20)
    expect(left.list.map((item) => item.icao)).toEqual(['406b90'])
  })

  it('re-filters as soon as the filters or the sort change', () => {
    const first = orderAircraft(snapshot, filters, sort, null, 0)
    const narrowed = orderAircraft(
      snapshot,
      { ...defaultAircraftFilters, maximumDistance: '20' },
      sort,
      first,
      10,
    )
    expect(narrowed.list.map((item) => item.icao)).toEqual(['406b90'])

    const descending = orderAircraft(snapshot, filters, { key: 'distance', direction: 'desc' }, first, 20)
    expect(descending.list.map((item) => item.icao)).toEqual(['4ca123', '406b90'])
  })

  it('distinguishes a different live set of the same size', () => {
    expect(membershipKey(snapshot)).not.toBe(membershipKey([far, aircraft({ icao: '3c6444' })]))
  })
})

/*
 * Live filters normally live in this browser's storage. A shared link is the
 * one place they travel, so the two directions have to agree exactly — the
 * person opening the link is meant to see what the sender saw.
 */
describe('filters carried by a shared link', () => {
  it('writes only what differs from the defaults', () => {
    const params = new URLSearchParams()
    writeFiltersToParams(defaultAircraftFilters, params)
    expect(params.toString()).toBe('')

    writeFiltersToParams(
      { ...defaultAircraftFilters, minimumAltitude: '20000', watchedOnly: true, position: 'positioned' },
      params,
    )
    expect(params.get('alt-min')).toBe('20000')
    expect(params.get('watched')).toBe('1')
    expect(params.get('pos')).toBe('positioned')
    expect(params.has('alt-max')).toBe(false)
  })

  it('round-trips every filter it carries', () => {
    const filters = {
      ...defaultAircraftFilters,
      query: 'EZY',
      minimumAltitude: '10000',
      maximumAltitude: '38000',
      minimumSpeed: '200',
      maximumDistance: '80',
      maximumFreshness: '30',
      position: 'positioned' as const,
      source: 'adsb_icao',
      category: 'A3',
      watchedOnly: true,
      alertsOnly: true,
    }
    const params = new URLSearchParams()
    writeFiltersToParams(filters, params)
    expect(filtersFromParams(params)).toEqual(filters)
  })

  // A URL naming no filter at all leaves the browser's stored filters in place;
  // one naming any filter describes the whole set, so the rest are defaults.
  it('returns null for a URL that names no filter, and a full set otherwise', () => {
    expect(filtersFromParams(new URLSearchParams('?aircraft=abc123'))).toBeNull()
    expect(filtersFromParams(new URLSearchParams('?alt-min=20000'))).toEqual({
      ...defaultAircraftFilters,
      minimumAltitude: '20000',
    })
  })

  it('ignores a position it does not recognise', () => {
    expect(filtersFromParams(new URLSearchParams('?pos=sideways'))?.position).toBe('all')
  })
})
