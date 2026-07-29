import type {
  Aircraft,
  AlertEvent,
  ConnectionState,
  LiveSnapshot,
  Receiver,
} from '../types'

export interface LiveState {
  aircraft: Record<string, Aircraft>
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

function mergeAlerts(current: AlertEvent[], incoming: AlertEvent[]): AlertEvent[] {
  if (!incoming.length) return current
  const next = new Map(current.map((alert) => [alert.id, alert]))
  for (const alert of incoming) next.set(alert.id, alert)
  return [...next.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'loading':
      return { ...state, connection: 'connecting', error: null }
    case 'snapshot':
      return {
        ...state,
        aircraft: byIcao(action.snapshot.aircraft),
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
      for (const item of action.upserts) aircraft[item.icao.toLowerCase()] = item
      for (const icao of action.removals) delete aircraft[icao.toLowerCase()]
      return {
        ...state,
        aircraft,
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
