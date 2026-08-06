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
let cache: readonly Airport[] | null = null

/** Shared so two consumers mounting together make one request, not two. */
let inFlight: Promise<readonly Airport[]> | null = null

/**
 * Set by `invalidateAirports`, and the reason it exists: three caches sit
 * between this hook and the dataset — this module, the service worker's
 * stale-while-revalidate entry, and the browser's own HTTP cache. An operator
 * who has just downloaded airports on the Settings page has invalidated all
 * three, so the next read has to be allowed to go past them.
 */
let refetchFromNetwork = false

/**
 * Consumers currently mounted. Without these, discarding the cache reached only
 * the *next* mount: the effect below has no dependency that a module-level
 * variable can change, so a map already on screen kept the empty list it read
 * at startup and went on saying there was no airport data.
 */
const listeners = new Set<() => void>()

function read(): Promise<readonly Airport[]> {
  const fresh = refetchFromNetwork
  refetchFromNetwork = false
  inFlight ??= api
    .airports(undefined, { fresh })
    .then((items) => {
      cache = items
      return items
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * Discards every cached copy of the dataset after an operator rebuilds it, and
 * tells anything currently reading to read again.
 *
 * Without this the map keeps the empty list it read at startup and still says
 * there is no airport data, on a receiver that has just downloaded some.
 */
export async function invalidateAirports(): Promise<void> {
  cache = null
  inFlight = null
  refetchFromNetwork = true
  // The service worker answers this endpoint from its own cache first, so its
  // copy has to go as well; workbox recreates the cache on the next request.
  if (typeof caches !== 'undefined') {
    await caches.delete('flightmap-airports').catch(() => {
      // A browser that refuses the delete still refetches past it below.
    })
  }
  for (const listener of listeners) listener()
}

export function useAirports(): readonly Airport[] | null {
  const [airports, setAirports] = useState<readonly Airport[] | null>(cache)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const reread = () => setGeneration((value) => value + 1)
    listeners.add(reread)
    return () => {
      listeners.delete(reread)
    }
  }, [])

  useEffect(() => {
    if (cache) {
      setAirports(cache)
      return
    }
    let cancelled = false
    read()
      .then((items) => {
        if (!cancelled) setAirports(items)
      })
      .catch(() => {
        if (!cancelled) setAirports([])
      })
    return () => {
      cancelled = true
    }
  }, [generation])

  return airports
}
