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
  newOnly: boolean
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
  newOnly: false,
}

function altitudeValue(aircraft: Aircraft): number | null {
  if (aircraft.altitudeBaro === 'ground') return 0
  return aircraft.altitudeBaro
}

/**
 * Whether this receiver first heard the airframe at or after `cutoff`, which
 * comes from the sighting preference in `sighting-preferences.ts` — the module
 * that owns the setting re-exports this, and is where every caller should
 * import it from.
 *
 * It is defined here rather than there because this module has to stay free of
 * runtime imports: the load smoke (`infra/scripts/load-smoke.mjs`) loads it
 * directly under Node's type stripping to measure the ordering pass, and Node
 * resolves neither extensionless specifiers nor React.
 *
 * An airframe with no `aircraft_summary` row has no first-seen time. That is
 * unknown, not new: marking it would assert something the receiver never
 * observed, which is the one thing this feature must not do.
 */
export function isNewSighting(
  firstSeenAt: string | null | undefined,
  cutoff: number | null,
): boolean {
  if (cutoff == null || firstSeenAt == null) return false
  const seen = Date.parse(firstSeenAt)
  return Number.isFinite(seen) && seen >= cutoff
}

/**
 * `newSince` is the cutoff from the sighting preference, threaded in rather
 * than read here so filtering stays a pure function of its arguments and the
 * order cache can tell when the answer could have changed.
 */
export function filterAircraft(
  aircraft: Aircraft[],
  filters: AircraftFilters,
  newSince: number | null = null,
): Aircraft[] {
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
    /*
     * Inert rather than exclusive when there is no cutoff. Switching marking
     * off in Settings while this filter is still ticked would otherwise empty
     * the list behind a control that is by then disabled, leaving no way back
     * except clearing storage. Unfiltered is the safe reading of "this filter
     * cannot apply right now".
     */
    if (filters.newOnly && newSince != null && !isNewSighting(item.firstSeenAt, newSince)) {
      return false
    }
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

/**
 * A filtered and sorted view of the live set, plus enough state to decide
 * whether the next snapshot can reuse it.
 */
export interface AircraftOrder {
  list: Aircraft[]
  /** The order itself, kept apart from the objects so it can be reapplied. */
  icaos: string[]
  filters: AircraftFilters
  sort: AircraftSort
  membership: string
  newSince: number | null
  orderedAt: number
}

/**
 * Identity of the live set, ignoring telemetry. ICAO addresses are fixed width,
 * so concatenation is unambiguous without a separator.
 */
export function membershipKey(aircraft: Aircraft[]): string {
  let key = ''
  for (const item of aircraft) key += item.icao
  return key
}

/**
 * Ceiling on how stale an order may become. Telemetry alone does not trigger a
 * re-sort — otherwise every row would change place each second — so this bounds
 * the drift between, say, the distance column and the distance ordering.
 */
export const reorderIntervalMs = 5_000

/**
 * Filter and sort only when the answer can have changed: a different filter set
 * or sort key, an aircraft joining or leaving, or the staleness ceiling above.
 * Otherwise the previous order is reapplied to the current objects, which keeps
 * the values on screen fresh at 1 Hz for the cost of one map lookup per row.
 */
export function orderAircraft(
  aircraft: Aircraft[],
  filters: AircraftFilters,
  sort: AircraftSort,
  previous: AircraftOrder | null,
  now: number,
  newSince: number | null = null,
): AircraftOrder {
  const membership = membershipKey(aircraft)
  const reusable =
    previous != null &&
    previous.filters === filters &&
    previous.sort === sort &&
    previous.membership === membership &&
    previous.newSince === newSince &&
    now - previous.orderedAt < reorderIntervalMs
  if (reusable) {
    const byIcao = new Map(aircraft.map((item) => [item.icao, item]))
    return {
      ...previous,
      list: previous.icaos
        .map((icao) => byIcao.get(icao))
        .filter((item): item is Aircraft => item != null),
    }
  }
  const list = sortAircraft(filterAircraft(aircraft, filters, newSince), sort)
  return {
    list,
    icaos: list.map((item) => item.icao),
    filters,
    sort,
    membership,
    newSince,
    orderedAt: now,
  }
}

export type SelectionMove = number | 'first' | 'last'

/**
 * Index the keyboard should move to within the visible list. Stops at both ends
 * rather than wrapping, so holding an arrow key settles somewhere predictable,
 * and starts from the appropriate end when nothing is selected yet.
 */
export function nextSelectionIndex(
  currentIndex: number,
  length: number,
  move: SelectionMove,
): number | null {
  if (length <= 0) return null
  if (move === 'first') return 0
  if (move === 'last') return length - 1
  if (currentIndex < 0) return move > 0 ? 0 : length - 1
  return Math.min(length - 1, Math.max(0, currentIndex + move))
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

/*
 * Live filters live in this browser's storage, because they are a working
 * preference rather than a place. A shared link is the exception: the point of
 * sending one is that the other person sees what the sender was looking at, so
 * a link carries whichever filters are not at their default. Anything left at
 * its default is omitted, keeping an unfiltered link as short as it was before.
 */
const FILTER_PARAMS: Record<keyof AircraftFilters, string> = {
  query: 'q',
  minimumAltitude: 'alt-min',
  maximumAltitude: 'alt-max',
  minimumSpeed: 'spd-min',
  maximumDistance: 'dist-max',
  maximumFreshness: 'fresh-max',
  position: 'pos',
  source: 'src',
  category: 'cat',
  watchedOnly: 'watched',
  alertsOnly: 'alerts',
  newOnly: 'new',
}

export function writeFiltersToParams(filters: AircraftFilters, params: URLSearchParams): void {
  for (const [key, name] of Object.entries(FILTER_PARAMS) as [keyof AircraftFilters, string][]) {
    const value = filters[key]
    const fallback = defaultAircraftFilters[key]
    if (value === fallback) continue
    params.set(name, typeof value === 'boolean' ? '1' : String(value))
  }
}

/** Null when the URL names no filter at all, so stored filters still apply. */
export function filtersFromParams(params: URLSearchParams): AircraftFilters | null {
  const entries = Object.entries(FILTER_PARAMS) as [keyof AircraftFilters, string][]
  if (!entries.some(([, name]) => params.has(name))) return null
  const filters = { ...defaultAircraftFilters }
  for (const [key, name] of entries) {
    const value = params.get(name)
    if (value === null) continue
    if (typeof defaultAircraftFilters[key] === 'boolean') {
      ;(filters[key] as boolean) = value !== '0' && value !== 'false'
    } else if (key === 'position') {
      if (['all', 'positioned', 'unpositioned'].includes(value)) filters.position = value as PositionFilter
    } else {
      ;(filters[key] as string) = value.slice(0, 128)
    }
  }
  return filters
}

export function activeFilterCount(filters: AircraftFilters): number {
  return Object.entries(filters).filter(([key, value]) => {
    if (key === 'query') return false
    return typeof value === 'boolean' ? value : value !== '' && value !== 'all'
  }).length
}
