import type { Aircraft } from '../types'

export type AircraftSortKey =
  | 'identity'
  | 'altitude'
  | 'distance'
  | 'speed'
  | 'freshness'
  | 'verticalRate'
  | 'track'
  | 'squawk'
  | 'operator'
  | 'typeCode'
export type PositionFilter = 'all' | 'positioned' | 'unpositioned'

export interface AircraftFilters {
  query: string
  minimumAltitude: string
  maximumAltitude: string
  minimumSpeed: string
  maximumDistance: string
  maximumFreshness: string
  position: PositionFilter
  source: string
  category: string
  watchedOnly: boolean
  alertsOnly: boolean
}

export interface AircraftSort {
  key: AircraftSortKey
  direction: 'asc' | 'desc'
}

export const defaultAircraftFilters: AircraftFilters = {
  query: '',
  minimumAltitude: '',
  maximumAltitude: '',
  minimumSpeed: '',
  maximumDistance: '',
  maximumFreshness: '',
  position: 'all',
  source: '',
  category: '',
  watchedOnly: false,
  alertsOnly: false,
}

function altitudeValue(aircraft: Aircraft): number | null {
  if (aircraft.altitudeBaro === 'ground') return 0
  return aircraft.altitudeBaro
}

export function filterAircraft(aircraft: Aircraft[], filters: AircraftFilters): Aircraft[] {
  const query = filters.query.trim().toLowerCase()
  const minimum = filters.minimumAltitude === '' ? null : Number(filters.minimumAltitude)
  const maximum = filters.maximumAltitude === '' ? null : Number(filters.maximumAltitude)
  const minimumSpeed = filters.minimumSpeed === '' ? null : Number(filters.minimumSpeed)
  const maximumDistance = filters.maximumDistance === '' ? null : Number(filters.maximumDistance)
  const freshness = filters.maximumFreshness === '' ? null : Number(filters.maximumFreshness)

  return aircraft.filter((item) => {
    if (
      query &&
      ![item.callsign, item.registration, item.icao, item.typeCode, item.operator]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query))
    ) {
      return false
    }
    const altitude = altitudeValue(item)
    if (minimum != null && (altitude == null || altitude < minimum)) return false
    if (maximum != null && (altitude == null || altitude > maximum)) return false
    if (minimumSpeed != null && (item.groundSpeed == null || item.groundSpeed < minimumSpeed)) return false
    if (maximumDistance != null && (item.distanceNm == null || item.distanceNm > maximumDistance)) return false
    if (freshness != null && (item.seenSeconds == null || item.seenSeconds > freshness)) return false
    const positioned = item.latitude != null && item.longitude != null
    if (filters.position === 'positioned' && !positioned) return false
    if (filters.position === 'unpositioned' && positioned) return false
    if (filters.source && item.source !== filters.source) return false
    if (filters.category && item.category !== filters.category) return false
    if (filters.watchedOnly && !item.watched) return false
    if (filters.alertsOnly && !item.hasActiveAlert) return false
    return true
  })
}

function compareNullable(left: number | string | null, right: number | string | null): number {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  return typeof left === 'string' && typeof right === 'string'
    ? left.localeCompare(right)
    : Number(left) - Number(right)
}

export function sortAircraft(aircraft: Aircraft[], sort: AircraftSort): Aircraft[] {
  const direction = sort.direction === 'asc' ? 1 : -1
  return [...aircraft].sort((left, right) => {
    let leftValue: number | string | null
    let rightValue: number | string | null
    if (sort.key === 'identity') {
      leftValue = left.callsign || left.registration || left.icao
      rightValue = right.callsign || right.registration || right.icao
    } else if (sort.key === 'altitude') {
      leftValue = altitudeValue(left)
      rightValue = altitudeValue(right)
    } else if (sort.key === 'distance') {
      leftValue = left.distanceNm
      rightValue = right.distanceNm
    } else if (sort.key === 'speed') {
      leftValue = left.groundSpeed
      rightValue = right.groundSpeed
    } else if (sort.key === 'verticalRate') {
      leftValue = left.verticalRate
      rightValue = right.verticalRate
    } else if (sort.key === 'track') {
      leftValue = left.track ?? left.trueHeading
      rightValue = right.track ?? right.trueHeading
    } else if (sort.key === 'squawk') {
      leftValue = left.squawk
      rightValue = right.squawk
    } else if (sort.key === 'operator') {
      leftValue = left.operator
      rightValue = right.operator
    } else if (sort.key === 'typeCode') {
      leftValue = left.typeCode
      rightValue = right.typeCode
    } else {
      leftValue = left.seenSeconds
      rightValue = right.seenSeconds
    }
    if (leftValue == null && rightValue == null) return 0
    if (leftValue == null) return 1
    if (rightValue == null) return -1
    return compareNullable(leftValue, rightValue) * direction
  })
}

export function aircraftFilterErrors(filters: AircraftFilters): Partial<
  Record<keyof AircraftFilters, string>
> {
  const errors: Partial<Record<keyof AircraftFilters, string>> = {}
  const numbers: Array<{
    key:
      | 'minimumAltitude'
      | 'maximumAltitude'
      | 'minimumSpeed'
      | 'maximumDistance'
      | 'maximumFreshness'
    label: string
  }> = [
    { key: 'minimumAltitude', label: 'Minimum altitude' },
    { key: 'maximumAltitude', label: 'Maximum altitude' },
    { key: 'minimumSpeed', label: 'Minimum speed' },
    { key: 'maximumDistance', label: 'Maximum range' },
    { key: 'maximumFreshness', label: 'Maximum report age' },
  ]
  for (const { key, label } of numbers) {
    const value = filters[key]
    if (value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      errors[key] = `${label} must be zero or a positive number.`
    }
  }
  if (
    !errors.minimumAltitude &&
    !errors.maximumAltitude &&
    filters.minimumAltitude !== '' &&
    filters.maximumAltitude !== '' &&
    Number(filters.minimumAltitude) > Number(filters.maximumAltitude)
  ) {
    errors.maximumAltitude = 'Maximum altitude must be at least the minimum.'
  }
  return errors
}

export function activeFilterCount(filters: AircraftFilters): number {
  return Object.entries(filters).filter(([key, value]) => {
    if (key === 'query') return false
    return typeof value === 'boolean' ? value : value !== '' && value !== 'all'
  }).length
}
