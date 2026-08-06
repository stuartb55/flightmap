import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from '../lib/router'
import type { SessionSummary, TrackResponse } from '../types'

const apiMock = vi.hoisted(() => ({
  sessions: vi.fn(),
  summaries: vi.fn(),
  track: vi.fn(),
  savedViews: vi.fn(),
  coverage: vi.fn(),
}))

vi.mock('../lib/api', () => ({ api: apiMock }))
vi.mock('../components/RadarMap', () => ({
  RadarMap: () => <div data-testid="radar-map" />,
}))
// Only the component is stood in for; the axis-mode helpers beside it are the
// page's own URL contract and have to stay real.
vi.mock('../components/FlightProfile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components/FlightProfile')>()),
  FlightProfile: () => <div data-testid="flight-profile" />,
}))

import { HistoryPage } from './HistoryPage'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

const session: SessionSummary = {
  id: SESSION_ID,
  icao: '406b90',
  callsigns: ['EZY42KD'],
  registration: 'G-EZTH',
  typeCode: 'A320',
  operator: 'easyJet',
  startedAt: '2026-08-01T10:00:00.000Z',
  endedAt: '2026-08-01T10:30:00.000Z',
  sampleCount: 1_800,
  minimumAltitudeFt: 2_000,
  maximumAltitudeFt: 38_000,
  maximumSpeedKt: 430,
  closestDistanceNm: 4.2,
  hasDetailedTrack: true,
  alertKinds: [],
}

// Long enough that a replay cannot reach the end during the test; the original
// debounce only settled once playback stopped.
const track: TrackResponse = {
  session,
  resolution: '1s',
  points: Array.from({ length: 200 }, (_, index) => ({
    recordedAt: new Date(Date.parse(session.startedAt) + index * 9_000).toISOString(),
    latitude: 53.4 + index * 0.001,
    longitude: -2.3 + index * 0.001,
    altitudeFt: 10_000 + index,
    groundSpeedKt: 400,
    trackDegrees: 90,
  })),
  events: [],
  truncated: false,
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('history URL while a replay is playing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/history')
    apiMock.sessions.mockResolvedValue({ sessions: [session], nextCursor: null })
    apiMock.summaries.mockResolvedValue({ summaries: [], nextCursor: null })
    apiMock.track.mockResolvedValue(track)
    apiMock.savedViews.mockResolvedValue([])
    apiMock.coverage.mockResolvedValue({ cells: [] })
  })

  it('records the selected session even while replay advances every frame', async () => {
    const user = userEvent.setup()
    render(
      <Router>
        <HistoryPage />
      </Router>,
    )

    const card = await screen.findByRole('button', { name: /EZY42KD/i }, { timeout: 5_000 })
    await user.click(card)
    await waitFor(() => expect(apiMock.track).toHaveBeenCalledWith(SESSION_ID, 'auto', expect.any(AbortSignal)))

    await user.click(await screen.findByRole('button', { name: 'Play replay' }))
    // Playback is still running: the URL must not wait for it to finish.
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBeInTheDocument()

    await waitFor(
      () => {
        const params = new URLSearchParams(window.location.search)
        expect(params.getAll('session')).toEqual([SESSION_ID])
        expect(params.has('replay')).toBe(true)
      },
      { timeout: 5_000 },
    )
  })
})
