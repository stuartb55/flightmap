import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Airport } from '@flightmap/shared'
import { api } from './api'
import { invalidateAirports, useAirports } from './use-airports'

function airport(icao: string): Airport {
  return {
    icao,
    iata: null,
    name: `${icao} Airport`,
    latitude: 53.35,
    longitude: -2.28,
    elevationFt: 257,
    rank: 3,
    runways: [],
  }
}

/*
 * The dataset cache is module state by design, so it outlives a test. Emptying
 * it the way the application does is what gives each test a mount that has to
 * go and read the dataset rather than one served from the previous test's.
 */
beforeEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await invalidateAirports()
})

/*
 * The dataset is cached in this module, in the service worker, and in the
 * browser's HTTP cache. An operator who downloads airports on the Settings
 * page has just made all three wrong, and the symptom is specific: the map
 * goes on saying there is no airport data on a receiver that now has some.
 */
describe('the airport dataset cache', () => {
  it('reads the dataset once and serves later mounts from memory', async () => {
    const fetchAirports = vi.spyOn(api, 'airports').mockResolvedValue([airport('EGCC')])

    const first = renderHook(() => useAirports())
    await waitFor(() => expect(first.result.current).toHaveLength(1))
    const second = renderHook(() => useAirports())

    expect(second.result.current).toHaveLength(1)
    expect(fetchAirports).toHaveBeenCalledTimes(1)
  })

  it('rereads the dataset after a download, past every cache holding the old one', async () => {
    const fetchAirports = vi.spyOn(api, 'airports').mockResolvedValue([])
    const first = renderHook(() => useAirports())
    await waitFor(() => expect(first.result.current).toEqual([]))

    fetchAirports.mockResolvedValue([airport('EGCC'), airport('EGGP')])
    await invalidateAirports()
    const second = renderHook(() => useAirports())

    await waitFor(() => expect(second.result.current).toHaveLength(2))
    // `fresh` is what takes the read past the service worker and the HTTP
    // cache; without it the reread is answered with the empty list again.
    expect(fetchAirports).toHaveBeenLastCalledWith(undefined, { fresh: true })
  })

  /*
   * The reread used to reach only the *next* mount, because the fetching effect
   * has no dependency a module-level variable can change. A map already on
   * screen kept the empty list it read at startup, and only worked at all
   * because navigating from Settings to Live happened to remount it.
   */
  it('rereads into a consumer that is already mounted', async () => {
    const fetchAirports = vi.spyOn(api, 'airports').mockResolvedValue([])
    const { result } = renderHook(() => useAirports())
    await waitFor(() => expect(result.current).toEqual([]))

    fetchAirports.mockResolvedValue([airport('EGCC')])
    await invalidateAirports()

    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(fetchAirports).toHaveBeenCalledTimes(2)
  })

  it('makes one request when two consumers mount together', async () => {
    const fetchAirports = vi
      .spyOn(api, 'airports')
      .mockResolvedValue([airport('EGCC')])

    const first = renderHook(() => useAirports())
    const second = renderHook(() => useAirports())

    await waitFor(() => expect(first.result.current).toHaveLength(1))
    await waitFor(() => expect(second.result.current).toHaveLength(1))
    expect(fetchAirports).toHaveBeenCalledTimes(1)
  })

  it('drops the service worker copy, which is served ahead of the network', async () => {
    const remove = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('caches', { delete: remove })

    await invalidateAirports()

    expect(remove).toHaveBeenCalledWith('flightmap-airports')
    vi.unstubAllGlobals()
  })

  it('still refetches when the browser refuses to drop the cache', async () => {
    vi.stubGlobal('caches', { delete: vi.fn().mockRejectedValue(new Error('denied')) })
    const fetchAirports = vi.spyOn(api, 'airports').mockResolvedValue([airport('EGCC')])

    await expect(invalidateAirports()).resolves.toBeUndefined()
    const { result } = renderHook(() => useAirports())

    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(fetchAirports).toHaveBeenLastCalledWith(undefined, { fresh: true })
    vi.unstubAllGlobals()
  })
})
