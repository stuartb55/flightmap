import { describe, expect, it } from 'vitest'
import { aircraft, snapshot } from '../test/fixtures'
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
