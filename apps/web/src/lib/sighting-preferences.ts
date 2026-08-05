import { useSyncExternalStore } from 'react'
import { isNewSighting } from './aircraft-filter'

/**
 * How recently this receiver must have first heard an airframe for it to be
 * marked as a new sighting.
 *
 * This is a passive marker, never an alert: a first-seen alert existed once and
 * was removed as noise in migration `009_focused_alerts.sql`, and that
 * judgement stands. Nothing here writes an `alert_events` row, plays a sound,
 * or touches the alert feed.
 *
 * The threshold is a per-browser choice like units are, because "new to me"
 * depends on how long the person watching has been away, not on the receiver.
 */

export type SightingThreshold = 'off' | 'session' | 'day' | 'week'

export const sightingThresholds: readonly SightingThreshold[] = [
  'off',
  'session',
  'day',
  'week',
]

export const sightingThresholdLabels: Record<SightingThreshold, string> = {
  off: 'Off',
  session: 'Since this session started',
  day: 'Last 24 hours',
  week: 'Last 7 days',
}

export const defaultSightingThreshold: SightingThreshold = 'session'

const STORAGE_KEY = 'flightmap.sightings.v1'
const SESSION_KEY = 'flightmap.session-start.v1'

const DAY_MS = 24 * 60 * 60 * 1_000
const WEEK_MS = 7 * DAY_MS

/**
 * Rolling windows are floored to the minute so the cutoff is a stable value
 * between renders. `orderAircraft` reuses a previous order while its inputs are
 * unchanged, and a cutoff recomputed to the millisecond would defeat that on
 * every 1 Hz tick for no visible gain — a sighting crossing the 24-hour line
 * within a minute of when it truly does is not a distinction anyone can see.
 */
const CUTOFF_QUANTUM_MS = 60_000

/**
 * The anchor for "since this session started": written once per tab session, so
 * it survives a reload — which is how a page recovers from a crash without
 * everything it had already seen turning new again — but a genuinely new tab
 * starts a fresh session.
 *
 * Falls back to the moment this module loaded when storage is unavailable or
 * holds nonsense, which is the same answer for a first visit.
 */
let fallbackSessionStart: number | null = null

export function sessionStartedAt(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSessionStorage(),
  now = Date.now(),
): number {
  fallbackSessionStart ??= now
  if (!storage) return fallbackSessionStart
  try {
    const stored = Number(storage.getItem(SESSION_KEY))
    if (Number.isFinite(stored) && stored > 0) return stored
    storage.setItem(SESSION_KEY, String(now))
    return now
  } catch {
    return fallbackSessionStart
  }
}

function safeSessionStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return sessionStorage
  } catch {
    return null
  }
}

/** Corrupt or absent storage falls back to the default rather than throwing. */
export function readSightingThreshold(
  storage: Pick<Storage, 'getItem'> = localStorage,
): SightingThreshold {
  try {
    const stored = storage.getItem(STORAGE_KEY)
    return sightingThresholds.includes(stored as SightingThreshold)
      ? (stored as SightingThreshold)
      : defaultSightingThreshold
  } catch {
    return defaultSightingThreshold
  }
}

let current: SightingThreshold | null = null
const listeners = new Set<() => void>()

export function sightingThreshold(): SightingThreshold {
  current ??= readSightingThreshold()
  return current
}

export function setSightingThreshold(threshold: SightingThreshold): void {
  current = threshold
  try {
    localStorage.setItem(STORAGE_KEY, threshold)
  } catch {
    // A choice that cannot be stored still applies to this session.
  }
  for (const listener of listeners) listener()
}

export function subscribeSightingThreshold(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSightingThreshold(): SightingThreshold {
  return useSyncExternalStore(subscribeSightingThreshold, sightingThreshold, sightingThreshold)
}

/**
 * The epoch millisecond at or after which a first sighting counts as new, or
 * null when the marker is off. Null means nothing is ever marked, which is what
 * every surface checks first.
 */
export function newSightingCutoff(
  threshold: SightingThreshold,
  now = Date.now(),
  sessionStart = sessionStartedAt(),
): number | null {
  switch (threshold) {
    case 'off':
      return null
    case 'session':
      return sessionStart
    case 'day':
      return Math.floor((now - DAY_MS) / CUTOFF_QUANTUM_MS) * CUTOFF_QUANTUM_MS
    case 'week':
      return Math.floor((now - WEEK_MS) / CUTOFF_QUANTUM_MS) * CUTOFF_QUANTUM_MS
  }
}

/**
 * Re-exported so the preference and the predicate that reads it are one import
 * for every surface that marks a sighting. It is defined in `aircraft-filter`
 * only because that module must stay loadable by bare Node; see the note there.
 */
export { isNewSighting }

/**
 * The cutoff for the current preference, recomputed on render. Stable between
 * renders within the same minute, so passing it to a memoised list does not
 * force that list to recompute at 1 Hz.
 */
export function useNewSightingCutoff(): number | null {
  return newSightingCutoff(useSightingThreshold())
}
