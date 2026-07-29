import type {
  AppSettings,
  AppSettingsResponse,
  HistoryFilters,
  TrackResponse,
} from '../types'
import {
  aircraftDetailResponseSchema,
  alertEventSchema,
  alertsResponseSchema,
  dismissAlertsResponseSchema,
  liveAircraftResponseSchema,
  sessionsResponseSchema,
  statusResponseSchema,
  summariesResponseSchema,
  trackResponseSchema,
  watchlistEntrySchema,
  watchlistResponseSchema,
} from '@flightmap/shared'
import {
  adaptAircraftDetail,
  adaptAlert,
  adaptSession,
  adaptSnapshot,
  adaptStatus,
  adaptSummary,
  adaptTrack,
  adaptWatchlist,
} from './adapters'
import type {
  WireAircraft,
  WireAlert,
  WireDailySummary,
  WireMetadata,
  WireReceiver,
  WireSession,
  WireStatus,
  WireTrackPoint,
} from './wire'
import { dateTimeInputToIso } from './format'

const API_ROOT = '/api/v1'

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string }
}

type ResponseSchema<T> = { parse: (value: unknown) => T }

async function request<T>(
  path: string,
  init?: RequestInit,
  schema?: ResponseSchema<T>,
): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    let body: ApiErrorBody = {}
    try {
      body = (await response.json()) as ApiErrorBody
    } catch {
      // The HTTP status remains useful when a proxy returns a non-JSON error.
    }
    throw new ApiError(
      body.error?.message ?? `Request failed (${response.status})`,
      body.error?.code ?? 'request_failed',
      response.status,
    )
  }

  if (response.status === 204) return undefined as T
  const body: unknown = await response.json()
  return schema ? schema.parse(body) : (body as T)
}

function queryString(values: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== '' && value != null) params.set(key, String(value))
  }
  const result = params.toString()
  return result ? `?${result}` : ''
}

function alertPage(includeDismissed: boolean, cursor?: string | null, signal?: AbortSignal) {
  return request<{ items: WireAlert[]; nextCursor: string | null }>(
    `/alerts${queryString({
      dismissed: includeDismissed ? undefined : 'false',
      cursor,
      limit: 100,
    })}`,
    { signal },
    alertsResponseSchema,
  ).then((result) => ({
    items: result.items.map(adaptAlert),
    nextCursor: result.nextCursor,
  }))
}

export const api = {
  live(signal?: AbortSignal) {
    return request<{
      sequence: number
      generatedAt: string
      receiver: WireReceiver
      aircraft: WireAircraft[]
    }>('/aircraft/live', { signal }, liveAircraftResponseSchema).then(adaptSnapshot)
  },

  aircraft(icao: string, signal?: AbortSignal) {
    return request<{
      aircraft: WireAircraft | null
      metadata: WireMetadata | null
      summary: {
        firstSeenAt: string
        lastSeenAt: string
        totalObservations: number
        sessionCount: number
        closestRangeNm: number | null
      } | null
      recentSessions: WireSession[]
      alerts: WireAlert[]
    }>(
      `/aircraft/${encodeURIComponent(icao)}`,
      { signal },
      aircraftDetailResponseSchema,
    ).then(adaptAircraftDetail)
  },

  sessions(filters: HistoryFilters, cursor?: string | null, signal?: AbortSignal) {
    return request<{ items: WireSession[]; nextCursor: string | null }>(
      `/sessions${queryString({
        q: filters.query,
        from: filters.from ? dateTimeInputToIso(filters.from) : '',
        to: filters.to ? dateTimeInputToIso(filters.to) : '',
        alert: filters.alert,
        cursor,
        limit: 50,
      })}`,
      { signal },
      sessionsResponseSchema,
    ).then((page) => ({
      sessions: page.items.map(adaptSession),
      nextCursor: page.nextCursor,
    }))
  },

  summaries(filters: HistoryFilters, cursor?: string | null, signal?: AbortSignal) {
    return request<{ items: WireDailySummary[]; nextCursor: string | null }>(
      `/summaries${queryString({
        query: filters.query,
        from: filters.from ? dateTimeInputToIso(filters.from).slice(0, 10) : '',
        to: filters.to ? dateTimeInputToIso(filters.to).slice(0, 10) : '',
        cursor,
        limit: 50,
      })}`,
      { signal },
      summariesResponseSchema,
    ).then((page) => ({
      items: page.items.map(adaptSummary),
      nextCursor: page.nextCursor,
    }))
  },

  track(
    id: string,
    resolution: TrackResponse['resolution'] | 'auto' = 'auto',
    signal?: AbortSignal,
    options: { from?: string; tail?: boolean; limit?: number } = {},
  ) {
    return request<{
      session: WireSession
      resolution: TrackResponse['resolution']
      points: WireTrackPoint[]
      truncated: boolean
    }>(
      `/sessions/${encodeURIComponent(id)}/track${queryString({
        resolution,
        from: options.from,
        tail: options.tail ? 'true' : undefined,
        limit: options.limit,
      })}`,
      { signal },
      trackResponseSchema,
    ).then(adaptTrack)
  },

  alerts(includeDismissed = false, signal?: AbortSignal) {
    return alertPage(includeDismissed, null, signal).then((page) => page.items)
  },

  alertsPage(includeDismissed = false, cursor?: string | null, signal?: AbortSignal) {
    return alertPage(includeDismissed, cursor, signal)
  },

  dismissAlert(id: string) {
    return request<WireAlert>(
      `/alerts/${encodeURIComponent(id)}/dismiss`,
      { method: 'POST' },
      alertEventSchema,
    ).then(
      adaptAlert,
    )
  },

  dismissAlerts(ids: string[]) {
    return request<{ items: WireAlert[] }>(
      '/alerts/dismiss',
      {
        method: 'POST',
        body: JSON.stringify({ ids }),
      },
      dismissAlertsResponseSchema,
    ).then((result) => result.items.map(adaptAlert))
  },

  watchlist(signal?: AbortSignal) {
    return request<{
      items: { icao: string; label: string | null; notes: string | null; createdAt: string; updatedAt: string }[]
    }>('/watchlist', {
      signal,
    }, watchlistResponseSchema).then((result) => result.items.map(adaptWatchlist))
  },

  addWatchlist(icao: string, label?: string | null, notes?: string | null) {
    return request<{
      icao: string
      label: string | null
      notes: string | null
      createdAt: string
      updatedAt: string
    }>(`/watchlist/${encodeURIComponent(icao)}`, {
      method: 'PUT',
      body: JSON.stringify({ label: label || null, notes: notes || null }),
    }, watchlistEntrySchema).then(adaptWatchlist)
  },

  removeWatchlist(icao: string) {
    return request<void>(`/watchlist/${encodeURIComponent(icao)}`, { method: 'DELETE' })
  },

  status(signal?: AbortSignal) {
    return request<WireStatus>('/status', { signal }, statusResponseSchema).then(adaptStatus)
  },

  settings(signal?: AbortSignal) {
    return request<AppSettingsResponse>('/settings', { signal })
  },

  updateSettings(settings: AppSettings) {
    return request<AppSettingsResponse>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    })
  },
}

export function liveSocketUrl(sequence: number): string {
  const url = new URL('/api/v1/live', window.location.href)
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('since', String(sequence))
  return url.toString()
}
