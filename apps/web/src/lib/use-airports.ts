import { useEffect, useState } from 'react'
import type { Airport } from '@flightmap/shared'
import { api } from './api'

/**
 * The airport dataset, fetched once per page load and served from the runtime
 * cache declared in `vite.config.ts` after that. It is not page config: it goes
 * over its own endpoint precisely so it stays out of every page load.
 *
 * A deployment that has never downloaded the dataset gets an empty list, which
 * is a valid answer rather than a failure — the layer simply has nothing to
 * draw. A failed request is the same silence: an airport layer is not worth an
 * error banner over live traffic.
 */
const cache: { airports: readonly Airport[] | null } = { airports: null }

/**
 * Set by `invalidateAirports`, and the reason it exists: three caches sit
 * between this hook and the dataset — this module, the service worker's
 * stale-while-revalidate entry, and the browser's own HTTP cache. An operator
 * who has just downloaded airports on the Settings page has invalidated all
 * three, so the next read has to be allowed to go past them.
 */
let refetchFromNetwork = false

/**
 * Discards every cached copy of the dataset after an operator rebuilds it.
 *
 * Without this the map keeps the empty list it read at startup and still says
 * there is no airport data, on a receiver that has just downloaded some.
 */
export async function invalidateAirports(): Promise<void> {
  cache.airports = null
  refetchFromNetwork = true
  // The service worker answers this endpoint from its own cache first, so its
  // copy has to go as well; workbox recreates the cache on the next request.
  if (typeof caches !== 'undefined') {
    await caches.delete('flightmap-airports').catch(() => {
      // A browser that refuses the delete still refetches past it below.
    })
  }
}

export function useAirports(): readonly Airport[] | null {
  const [airports, setAirports] = useState<readonly Airport[] | null>(cache.airports)
  useEffect(() => {
    if (cache.airports) return
    const controller = new AbortController()
    const fresh = refetchFromNetwork
    refetchFromNetwork = false
    api
      .airports(controller.signal, { fresh })
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
