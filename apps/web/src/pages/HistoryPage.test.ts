import { describe, expect, it } from 'vitest'
import {
  historyUrl,
  restoredSort,
  restoredTrackState,
  shouldShowSummarySection,
} from './HistoryPage'

describe('history summary pagination visibility', () => {
  it('keeps load-more reachable when a page contains only filtered recent summaries', () => {
    expect(shouldShowSummarySection(0, 'older-summary-cursor')).toBe(true)
  })

  it('hides an exhausted empty summary section', () => {
    expect(shouldShowSummarySection(0, null)).toBe(false)
  })
})

describe('history URL restoration', () => {
  const firstSession = '11111111-1111-4111-8111-111111111111'
  const secondSession = '22222222-2222-4222-8222-222222222222'
  const filters = {
    query: 'G-TEST',
    icao: '',
    callsign: '',
    registration: '',
    type: '',
    operator: '',
    from: '2026-08-01T10:00',
    to: '2026-08-01T14:00',
    alert: 'watchlist',
  } as const

  it('round-trips selected sessions, replay position, resolution, and the profile axis', () => {
    const replayTime = Date.parse('2026-08-01T12:34:56.000Z')
    const url = historyUrl(
      filters,
      'started_desc',
      [firstSession, secondSession],
      replayTime,
      '15s',
      'aligned',
    )

    expect(restoredTrackState(url.split('?')[1] ?? '')).toEqual({
      selectedSessionIds: [firstSession, secondSession],
      replayTime,
      resolution: '15s',
      profileAxis: 'aligned',
    })
  })

  it('omits the default profile axis and falls back to it on an unknown one', () => {
    const defaulted = historyUrl(filters, 'started_desc', [], null, 'auto', 'absolute')
    expect(defaulted).not.toContain('profile=')
    expect(restoredTrackState(defaulted.split('?')[1] ?? '').profileAxis).toBe('absolute')
    expect(restoredTrackState('?profile=sideways').profileAxis).toBe('absolute')
  })

  it('round-trips a non-default ordering and omits the default one', () => {
    const sorted = historyUrl(filters, 'closest_asc', [], null, 'auto')
    expect(restoredSort(sorted.split('?')[1] ?? '')).toBe('closest_asc')

    const defaulted = historyUrl(filters, 'started_desc', [], null, 'auto')
    expect(defaulted).not.toContain('sort=')
    expect(restoredSort(defaulted.split('?')[1] ?? '')).toBe('started_desc')
  })

  it('falls back to the default ordering rather than failing on an unknown one', () => {
    expect(restoredSort('?sort=by_vibes')).toBe('started_desc')
    expect(restoredSort('')).toBe('started_desc')
  })

  it('deduplicates, validates, and bounds shared session identifiers', () => {
    const params = new URLSearchParams()
    params.append('session', firstSession)
    params.append('session', firstSession)
    params.append('session', 'not-a-session')
    for (let index = 0; index < 10; index += 1) {
      params.append('session', `${index}`.repeat(8) + '-0000-4000-8000-000000000000')
    }
    params.set('replay', 'invalid')
    params.set('resolution', '2s')

    const restored = restoredTrackState(`?${params.toString()}`)
    expect(restored.profileAxis).toBe('absolute')
    expect(restored.selectedSessionIds).toHaveLength(8)
    expect(restored.selectedSessionIds[0]).toBe(firstSession)
    expect(restored.replayTime).toBeNull()
    expect(restored.resolution).toBe('auto')
  })
})
