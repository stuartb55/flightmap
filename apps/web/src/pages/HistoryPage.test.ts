import { describe, expect, it } from 'vitest'
import { historyUrl, restoredTrackState, shouldShowSummarySection } from './HistoryPage'

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

  it('round-trips selected sessions, replay position, and resolution', () => {
    const replayTime = Date.parse('2026-08-01T12:34:56.000Z')
    const url = historyUrl(
      {
        query: 'G-TEST',
        icao: '',
        callsign: '',
        registration: '',
        type: '',
        operator: '',
        from: '2026-08-01T10:00',
        to: '2026-08-01T14:00',
        alert: 'watchlist',
      },
      [firstSession, secondSession],
      replayTime,
      '15s',
    )

    expect(restoredTrackState(url.split('?')[1] ?? '')).toEqual({
      selectedSessionIds: [firstSession, secondSession],
      replayTime,
      resolution: '15s',
    })
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
    expect(restored.selectedSessionIds).toHaveLength(8)
    expect(restored.selectedSessionIds[0]).toBe(firstSession)
    expect(restored.replayTime).toBeNull()
    expect(restored.resolution).toBe('auto')
  })
})
