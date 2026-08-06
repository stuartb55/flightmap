import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import type { AppSettings } from '../types'

afterEach(() => {
  vi.unstubAllGlobals()
})

const validSettings: AppSettings = {
  receiverBaseUrl: 'http://receiver.local/data',
  receiverName: 'Home receiver',
  receiverLatitude: null,
  receiverLongitude: null,
  pollIntervalMs: 1_000,
  receiverTimeoutMs: 800,
  receiverInfoIntervalMs: 300_000,
  receiverStatsIntervalMs: 60_000,
  displayTimeZone: 'Europe/London',
  mapStyleUrl: 'https://tiles.example/dark',
  mapStyleUrlLight: 'https://tiles.example/light',
  rangeRingsNm: [5, 10],
  airportDataUrl: 'https://airports.example/airports.csv',
  airportRunwayDataUrl: 'https://airports.example/runways.csv',
  airportRadiusNm: 250,
  airportMinimumRunwayFt: 3_281,
  historyRetentionDays: 30,
  sessionGapSeconds: 300,
  currentAircraftTtlSeconds: 60,
  metadataUrl: 'https://metadata.example/aircraft.csv.gz',
  metadataCheckIntervalMs: 604_800_000,
  metadataTimeoutMs: 30_000,
  metadataMinRows: 100_000,
  metadataMaxDownloadBytes: 50_000_000,
  metadataMaxUncompressedBytes: 250_000_000,
  databaseVolumeCapacityBytes: null,
  collectorEnabled: true,
  maintenanceEnabled: true,
  metadataUpdatesEnabled: true,
}

describe('alerts API pagination', () => {
  it('propagates an opaque cursor and returns the server next cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [], nextCursor: 'next-page-token' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const page = await api.alertsPage(true, 'opaque+/=token')
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://flightmap.test')

    expect(requestUrl.pathname).toBe('/api/v1/alerts')
    expect(requestUrl.searchParams.get('cursor')).toBe('opaque+/=token')
    expect(requestUrl.searchParams.get('limit')).toBe('100')
    expect(requestUrl.searchParams.has('dismissed')).toBe(false)
    expect(page.nextCursor).toBe('next-page-token')
  })

  it('turns incompatible server payloads into a human-readable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: 'not-an-array', nextCursor: null }),
    }))

    await expect(api.alertsPage(true)).rejects.toEqual(
      expect.objectContaining({
        code: 'invalid_response',
        message: expect.stringContaining('server returned data'),
      }),
    )
  })
})

describe('settings responses', () => {
  /*
   * Settings used to be the one response nobody checked, so a server one
   * version out produced `Cannot read properties of undefined (reading 'join')`
   * on a blank page instead of the message that names the problem.
   */
  it('reports a version mismatch rather than failing later in render', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // Everything but `rangeRingsNm`, which the form calls `.join()` on.
      json: async () => ({ settings: { receiverName: 'Home receiver' }, updatedAt: null }),
    }))

    await expect(api.settings()).rejects.toEqual(
      expect.objectContaining({
        code: 'invalid_response',
        message: expect.stringContaining('server returned data'),
      }),
    )
  })

  it('accepts a key this build has never heard of', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        settings: { ...validSettings, somethingAddedLater: true },
        updatedAt: null,
      }),
    }))

    // A newer server is not a reason to refuse the whole page.
    await expect(api.settings()).resolves.toMatchObject({
      settings: { receiverName: 'Home receiver' },
    })
  })
})

describe('request timeouts', () => {
  it('aborts on either the caller signal or the timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()

    await api.airports(caller.signal)
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)

    // The caller's own cancellation still reaches the request.
    caller.abort()
    expect(signal.aborted).toBe(true)
  })
})
