import { useEffect, useState } from 'react'
import type { Airport } from '@flightmap/shared'
import { api } from './api'

/**
 * The airport dataset, fetched once per page load and served from the runtime
 * cache declared in `vite.config.ts` after that. It is not page config: it goes
 * over its own endpoint precisely so it stays out of every page load.
 *
 * A deployment that has never run `npm run airports:build` gets an empty list,
 * which is a valid answer rather than a failure — the layer simply has nothing
 * to draw. A failed request is the same silence: an airport layer is not worth
 * an error banner over live traffic.
 */
const cache: { airports: readonly Airport[] | null } = { airports: null }

export function useAirports(): readonly Airport[] | null {
  const [airports, setAirports] = useState<readonly Airport[] | null>(cache.airports)
  useEffect(() => {
    if (cache.airports) return
    const controller = new AbortController()
    api
      .airports(controller.signal)
      .then((items) => {
        cache.airports = items
        if (!controller.signal.aborted) setAirports(items)
      })
      .catch(() => {
        if (!controller.signal.aborted) setAirports([])
      })
    return () => controller.abort()
  }, [])
  return airports
}
