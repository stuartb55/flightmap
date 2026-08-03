import { describe, expect, it } from 'vitest'
import { aircraft, snapshot } from '../test/fixtures'
import type { AlertEvent } from '../types'
import { initialLiveState, isSequenceGap, liveReducer } from './live-reducer'

describe('live state reducer', () => {
  it('replaces state with an authoritative snapshot', () => {
    const state = liveReducer(initialLiveState, { type: 'snapshot', snapshot: snapshot() })
    expect(state.sequence).toBe(10)
    expect(state.hasSnapshot).toBe(true)
    expect(Object.keys(state.aircraft)).toEqual(['406b90'])
  })

  it('atomically applies batched upserts and removals', () => {
    const start = liveReducer(initialLiveState, {
      type: 'snapshot',
      snapshot: snapshot([aircraft({ icao: '406b90' }), aircraft({ icao: '4ca123' })]),
    })
    const state = liveReducer(start, {
      type: 'delta',
      sequence: 11,
      generatedAt: '2026-07-29T12:00:01.000Z',
      upserts: [aircraft({ icao: '406b90', altitudeBaro: 18_100 })],
      removals: ['4ca123'],
      alerts: [],
    })

    expect(state.aircraft['406b90']?.altitudeBaro).toBe(18_100)
    expect(state.aircraft['4ca123']).toBeUndefined()
    expect(state.sequence).toBe(11)
  })

  it('ignores a replayed or out-of-order delta', () => {
    const start = liveReducer(initialLiveState, { type: 'snapshot', snapshot: snapshot() })
    const state = liveReducer(start, {
      type: 'delta',
      sequence: 9,
      generatedAt: '2026-07-29T11:59:59.000Z',
      upserts: [aircraft({ altitudeBaro: 2_000 })],
      removals: [],
      alerts: [],
    })
    expect(state).toBe(start)
  })

  it('detects a missing sequence so the client can resnapshot', () => {
    expect(isSequenceGap(41, 43)).toBe(true)
    expect(isSequenceGap(41, 42)).toBe(false)
    expect(isSequenceGap(41, 41)).toBe(false)
  })
})

describe('live connection and alert state', () => {
  it('tracks connection transitions without losing the snapshot', () => {
    const snapshotState = liveReducer(initialLiveState, {
      type: 'snapshot',
      snapshot: snapshot(),
    })
    expect(liveReducer(snapshotState, { type: 'connected' }).connection).toBe('live')
    const reconnecting = liveReducer(snapshotState, {
      type: 'reconnecting',
      error: 'Live updates interrupted',
    })
    expect(reconnecting.connection).toBe('reconnecting')
    expect(reconnecting.error).toBe('Live updates interrupted')
    expect(liveReducer(initialLiveState, { type: 'reconnecting' }).connection).toBe('connecting')
    const offline = liveReducer(snapshotState, { type: 'offline', error: 'Receiver is gone' })
    expect(offline.connection).toBe('offline')
    expect(liveReducer(offline, { type: 'loading' }).error).toBeNull()
  })

  it('merges alerts newest first and dismisses by id', () => {
    const alerts: AlertEvent[] = [
      {
        id: 'a1',
        icao: '406b90',
        type: 'emergency',
        title: 'Emergency squawk',
        message: 'Squawk 7700',
        callsign: 'EZY42KD',
        severity: 'critical',
        createdAt: '2026-07-29T12:00:00.000Z',
        dismissedAt: null,
      },
      {
        id: 'a2',
        icao: '4ca123',
        type: 'watchlist',
        title: 'Watched aircraft',
        message: 'Watched aircraft',
        callsign: null,
        severity: 'warning',
        createdAt: '2026-07-29T12:05:00.000Z',
        dismissedAt: null,
      },
    ]
    const hydrated = liveReducer(initialLiveState, { type: 'hydrate-alerts', alerts })
    expect(hydrated.alerts.map((alert) => alert.id)).toEqual(['a2', 'a1'])
    expect(liveReducer(hydrated, { type: 'hydrate-alerts', alerts: [] }).alerts).toBe(hydrated.alerts)

    const dismissed = liveReducer(hydrated, { type: 'dismiss-alert', id: 'a1' })
    expect(dismissed.alerts.find((alert) => alert.id === 'a1')?.dismissedAt).not.toBeNull()
    expect(dismissed.alerts.find((alert) => alert.id === 'a2')?.dismissedAt).toBeNull()
  })

  it('applies an optimistic watch state only to a known aircraft', () => {
    const start = liveReducer(initialLiveState, { type: 'snapshot', snapshot: snapshot() })
    const watched = liveReducer(start, {
      type: 'watch-state',
      icao: '406B90',
      watched: true,
    })
    expect(watched.aircraft['406b90']?.watched).toBe(true)
    expect(liveReducer(start, { type: 'watch-state', icao: 'ffffff', watched: true })).toBe(start)
  })

  it('keeps unchanged aircraft referentially equal so memoised rows can skip', () => {
    const start = liveReducer(initialLiveState, {
      type: 'snapshot',
      snapshot: snapshot([aircraft({ icao: '406b90' }), aircraft({ icao: '4ca123' })]),
    })
    const next = liveReducer(start, {
      type: 'delta',
      sequence: 11,
      generatedAt: '2026-07-29T12:00:01.000Z',
      upserts: [aircraft({ icao: '406b90', altitudeBaro: 18_100 })],
      removals: [],
      alerts: [],
    })
    expect(next.aircraft['4ca123']).toBe(start.aircraft['4ca123'])
    expect(next.aircraft['406b90']).not.toBe(start.aircraft['406b90'])
  })
})
