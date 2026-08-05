import type {
  AppSettings,
  AppSettingsResponse,
  HistoryFilters,
  TrackResponse,
} from '../types'
import type {
  AircraftActivityResponse,
  CoverageCellDetailResponse,
  CustomAlertRule,
  CustomAlertRuleInput,
  CustomAlertRulePatch,
  InsightCoverageResponse,
  InsightOverview,
  InsightPatternsResponse,
  RangeProfileResponse,
  ReceiverRecordsResponse,
  SavedView,
  SavedViewInput,
  SavedViewPatch,
  SessionSort,
} from '@flightmap/shared'
import {
  aircraftActivityResponseSchema,
  aircraftDetailResponseSchema,
  alertEventSchema,
  alertsResponseSchema,
  coverageCellDetailResponseSchema,
  customAlertRulePreviewSchema,
  customAlertRuleSchema,
  customAlertRulesResponseSchema,
  dismissAlertsResponseSchema,
  liveAircraftResponseSchema,
  insightCoverageResponseSchema,
  insightOverviewSchema,
  insightPatternsResponseSchema,
  rangeProfileResponseSchema,
  receiverRecordsResponseSchema,
  savedViewSchema,
  savedViewsResponseSchema,
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
import { displayTimeZone } from '../config'

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
  if (!schema) return body as T
  try {
    return schema.parse(body)
  } catch {
    throw new ApiError(
      'The server returned data this version of Flightmap could not read. Retry after checking that the server and web app are the same version.',
      'invalid_response',
      502,
    )
  }
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

  aircraftActivity(
    icao: string,
    range: { from: string; to: string; bucket: 'day' | 'month' },
    signal?: AbortSignal,
  ) {
    return request<AircraftActivityResponse>(
      `/aircraft/${encodeURIComponent(icao)}/activity${queryString(range)}`,
      { signal },
      aircraftActivityResponseSchema,
    )
  },

  sessions(
    filters: HistoryFilters,
    sort: SessionSort,
    cursor?: string | null,
    signal?: AbortSignal,
  ) {
    return request<{ items: WireSession[]; nextCursor: string | null }>(
      `/sessions${queryString({
        sort,
        q: filters.query,
        icao: filters.icao,
        callsign: filters.callsign,
        registration: filters.registration,
        type: filters.type,
        operator: filters.operator,
        from: filters.from ? dateTimeInputToIso(filters.from) : '',
        to: filters.to ? dateTimeInputToIso(filters.to) : '',
        alert: filters.alert,
        // The weekday and hour were read off a grid drawn in the display zone,
        // so the server has to be told which zone to name them in.
        weekday: filters.weekday ?? '',
        hour: filters.hour ?? '',
        timeZone: filters.weekday == null ? '' : displayTimeZone(),
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
      events: TrackResponse['events']
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

  customAlertRules(signal?: AbortSignal) {
    return request<{ items: CustomAlertRule[] }>('/alerts/rules', { signal }, customAlertRulesResponseSchema).then((response) => response.items)
  },

  previewCustomAlertRule(input: CustomAlertRuleInput) {
    return request<{ matches: Array<{ icao: string; callsign: string | null; registration: string | null }> }>('/alerts/rules/preview', { method: 'POST', body: JSON.stringify(input) }, customAlertRulePreviewSchema)
  },

  createCustomAlertRule(input: CustomAlertRuleInput) {
    return request<CustomAlertRule>('/alerts/rules', { method: 'POST', body: JSON.stringify(input) }, customAlertRuleSchema)
  },

  updateCustomAlertRule(id: string, patch: CustomAlertRulePatch) {
    return request<CustomAlertRule>(`/alerts/rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, customAlertRuleSchema)
  },

  deleteCustomAlertRule(id: string) {
    return request<void>(`/alerts/rules/${encodeURIComponent(id)}`, { method: 'DELETE' })
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

  insightsOverview(
    range: { from: string; to: string; bucket: 'hour' | 'day'; compare?: boolean },
    signal?: AbortSignal,
  ) {
    return request<InsightOverview>(
      `/insights/overview${queryString({
        from: range.from,
        to: range.to,
        bucket: range.bucket,
        compare: range.compare ? 'true' : undefined,
      })}`,
      { signal },
      insightOverviewSchema,
    )
  },

  insightsCoverage(range: { from: string; to: string }, signal?: AbortSignal) {
    return request<InsightCoverageResponse>(
      `/insights/coverage${queryString(range)}`,
      { signal },
      insightCoverageResponseSchema,
    )
  },

  insightPatterns(
    range: { from: string; to: string; timeZone: string; compare?: boolean },
    signal?: AbortSignal,
  ) {
    return request<InsightPatternsResponse>(
      `/insights/patterns${queryString({ ...range, compare: range.compare ? 'true' : undefined })}`,
      { signal },
      insightPatternsResponseSchema,
    )
  },

  rangeProfile(
    range: { from: string; to: string; altitudeBand: 'all' | 'ground' | 'low' | 'medium' | 'high'; compare?: boolean },
    signal?: AbortSignal,
  ) {
    return request<RangeProfileResponse>(
      `/insights/range-profile${queryString({ ...range, compare: range.compare ? 'true' : undefined })}`,
      { signal },
      rangeProfileResponseSchema,
    )
  },

  /** All-time and range-independent, so it takes nothing but a signal. */
  receiverRecords(signal?: AbortSignal) {
    return request<ReceiverRecordsResponse>(
      '/insights/records',
      { signal },
      receiverRecordsResponseSchema,
    )
  },

  coverageCellDetail(
    range: { from: string; to: string; latitude: number; longitude: number },
    signal?: AbortSignal,
  ) {
    return request<CoverageCellDetailResponse>(
      `/insights/coverage-cell${queryString(range)}`,
      { signal },
      coverageCellDetailResponseSchema,
    )
  },

  savedViews(signal?: AbortSignal) {
    return request<{ items: SavedView[] }>('/saved-views', { signal }, savedViewsResponseSchema).then(
      (response) => response.items,
    )
  },

  createSavedView(input: SavedViewInput) {
    return request<SavedView>(
      '/saved-views',
      { method: 'POST', body: JSON.stringify(input) },
      savedViewSchema,
    )
  },

  updateSavedView(id: string, patch: SavedViewPatch) {
    return request<SavedView>(
      `/saved-views/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      savedViewSchema,
    )
  },

  deleteSavedView(id: string) {
    return request<void>(`/saved-views/${encodeURIComponent(id)}`, { method: 'DELETE' })
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
