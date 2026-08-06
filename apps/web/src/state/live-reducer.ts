import type {
  Aircraft,
  AlertEvent,
  Altitude,
  ConnectionState,
  LiveSnapshot,
  Receiver,
} from '../types'

/**
 * A position an aircraft has been seen at, accumulated from the deltas the
 * client already receives. This is display state only: the server remains the
 * source of truth for the selected aircraft's trail and for all history.
 */
export interface TrailPoint {
  latitude: number
  longitude: number
  altitudeBaro: Altitude
  recordedAt: number
}

/**
 * Bounds chosen so a thousand simultaneous aircraft stay well inside a few
 * megabytes. Four seconds between points is far finer than a trail needs to
 * look continuous at any usable zoom, and ninety points covers six minutes.
 */
export const TRAIL_MAX_POINTS = 90
export const TRAIL_MIN_INTERVAL_MS = 4_000

export interface LiveState {
  aircraft: Record<string, Aircraft>
  trails: Record<string, TrailPoint[]>
  alerts: AlertEvent[]
  receiver: Receiver | null
  sequence: number
  generatedAt: string | null
  connection: ConnectionState
  hasSnapshot: boolean
  error: string | null
}

export type LiveAction =
  | { type: 'loading' }
  | { type: 'snapshot'; snapshot: LiveSnapshot }
  | { type: 'connected' }
  | { type: 'reconnecting'; error?: string }
  | { type: 'offline'; error: string }
  | {
      type: 'delta'
      sequence: number
      generatedAt: string
      upserts: Aircraft[]
      removals: string[]
      receiver?: Receiver
      alerts: AlertEvent[]
    }
  | { type: 'hydrate-alerts'; alerts: AlertEvent[] }
  | { type: 'dismiss-alert'; id: string }
  | { type: 'watch-state'; icao: string; watched: boolean }

export const initialLiveState: LiveState = {
  aircraft: {},
  trails: {},
  alerts: [],
  receiver: null,
  sequence: 0,
  generatedAt: null,
  connection: 'connecting',
  hasSnapshot: false,
  error: null,
}

export function isSequenceGap(currentSequence: number, incomingSequence: number): boolean {
  return incomingSequence > currentSequence + 1
}

function byIcao(aircraft: Aircraft[]): Record<string, Aircraft> {
  return Object.fromEntries(aircraft.map((item) => [item.icao.toLowerCase(), item]))
}

/**
 * Extends one aircraft's trail, returning the original array when the point
 * adds nothing so React can skip the aircraft that have not moved.
 */
export function appendTrailPoint(
  existing: TrailPoint[] | undefined,
  aircraft: Aircraft,
  at: number,
): TrailPoint[] | undefined {
  if (aircraft.latitude == null || aircraft.longitude == null) return existing
  if (!Number.isFinite(at)) return existing
  const last = existing?.[existing.length - 1]
  if (last) {
    if (at - last.recordedAt < TRAIL_MIN_INTERVAL_MS) return existing
    // A stationary aircraft should not fill its buffer with the same position.
    if (last.latitude === aircraft.latitude && last.longitude === aircraft.longitude) {
      return existing
    }
  }
  const point: TrailPoint = {
    latitude: aircraft.latitude,
    longitude: aircraft.longitude,
    altitudeBaro: aircraft.altitudeBaro,
    recordedAt: at,
  }
  const next = existing ? [...existing, point] : [point]
  return next.length > TRAIL_MAX_POINTS ? next.slice(next.length - TRAIL_MAX_POINTS) : next
}

function seedTrails(aircraft: Aircraft[], at: number): Record<string, TrailPoint[]> {
  const trails: Record<string, TrailPoint[]> = {}
  for (const item of aircraft) {
    const seeded = appendTrailPoint(undefined, item, at)
    if (seeded) trails[item.icao.toLowerCase()] = seeded
  }
  return trails
}

/**
 * How many alerts the live state keeps.
 *
 * Nothing here evicts on its own: dismissing marks `dismissedAt` and keeps the
 * row, and a snapshot leaves the list alone. On the deployment this app is for
 * — a wall display left up for days — an uncapped list only grows, and every
 * delta carrying an alert rebuilds a Map over all of it, re-sorts, and through
 * the status context re-renders every consumer.
 *
 * Far more than the emergency banner or the Alerts page reads at once, and the
 * server stays the source of truth for anything older through GET /alerts.
 */
export const LIVE_ALERT_LIMIT = 200

function mergeAlerts(current: AlertEvent[], incoming: AlertEvent[]): AlertEvent[] {
  if (!incoming.length) return current
  const next = new Map(current.map((alert) => [alert.id, alert]))
  for (const alert of incoming) next.set(alert.id, alert)
  return [...next.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, LIVE_ALERT_LIMIT)
}

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'loading':
      return { ...state, connection: 'connecting', error: null }
    case 'snapshot':
      // A snapshot follows a gap or a reconnect, so any trail held from before
      // it would draw a straight line across whatever was missed.
      return {
        ...state,
        aircraft: byIcao(action.snapshot.aircraft),
        trails: seedTrails(
          action.snapshot.aircraft,
          Date.parse(action.snapshot.generatedAt),
        ),
        receiver: action.snapshot.receiver,
        sequence: action.snapshot.sequence,
        generatedAt: action.snapshot.generatedAt,
        hasSnapshot: true,
        error: null,
      }
    case 'connected':
      return { ...state, connection: 'live', error: null }
    case 'reconnecting':
      return {
        ...state,
        connection: state.hasSnapshot ? 'reconnecting' : 'connecting',
        error: action.error ?? state.error,
      }
    case 'offline':
      return { ...state, connection: 'offline', error: action.error }
    case 'delta': {
      if (action.sequence <= state.sequence) return state
      const aircraft = { ...state.aircraft }
      const trails = { ...state.trails }
      const at = Date.parse(action.generatedAt)
      for (const item of action.upserts) {
        const key = item.icao.toLowerCase()
        aircraft[key] = item
        const extended = appendTrailPoint(trails[key], item, at)
        if (extended) trails[key] = extended
      }
      for (const icao of action.removals) {
        const key = icao.toLowerCase()
        delete aircraft[key]
        delete trails[key]
      }
      return {
        ...state,
        aircraft,
        trails,
        receiver: action.receiver ?? state.receiver,
        alerts: mergeAlerts(state.alerts, action.alerts),
        sequence: action.sequence,
        generatedAt: action.generatedAt,
        connection: 'live',
        error: null,
      }
    }
    case 'hydrate-alerts':
      return { ...state, alerts: mergeAlerts(state.alerts, action.alerts) }
    case 'dismiss-alert':
      return {
        ...state,
        alerts: state.alerts.map((alert) =>
          alert.id === action.id ? { ...alert, dismissedAt: new Date().toISOString() } : alert,
        ),
      }
    case 'watch-state': {
      const key = action.icao.toLowerCase()
      const target = state.aircraft[key]
      if (!target) return state
      return {
        ...state,
        aircraft: { ...state.aircraft, [key]: { ...target, watched: action.watched } },
      }
    }
  }
}
