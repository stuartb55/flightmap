import { useRef } from 'react'
import {
  orderAircraft,
  type AircraftFilters,
  type AircraftOrder,
  type AircraftSort,
} from './aircraft-filter'
import type { Aircraft } from '../types'

/**
 * The filtered, sorted live list, kept off the 1 Hz critical path.
 *
 * The cache lives in a ref rather than a `useMemo` because the recompute
 * decision depends on values derived from the input — the membership key and
 * the clock — which cannot be expressed as a dependency array. The result is
 * still a pure function of the arguments, so a discarded render costs nothing.
 */
export function useOrderedAircraft(
  aircraft: Aircraft[],
  filters: AircraftFilters,
  sort: AircraftSort,
): Aircraft[] {
  const cache = useRef<AircraftOrder | null>(null)
  cache.current = orderAircraft(aircraft, filters, sort, cache.current, Date.now())
  return cache.current.list
}
