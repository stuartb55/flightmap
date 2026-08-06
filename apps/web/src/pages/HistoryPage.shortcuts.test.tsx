import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const track: TrackResponse = {
  session,
  resolution: '1s',
  points: [
    {
      recordedAt: session.startedAt,
      latitude: 53.4,
      longitude: -2.3,
      altitudeFt: 10_000,
      groundSpeedKt: 400,
      trackDegrees: 90,
    },
    {
      recordedAt: session.endedAt as string,
      latitude: 53.5,
      longitude: -2.2,
      altitudeFt: 12_000,
      groundSpeedKt: 410,
      trackDegrees: 90,
    },
  ],
  events: [],
  truncated: false,
}

afterEach(cleanup)

/**
 * `c` clears the loaded tracks, which makes ⌘C — the chord a reader presses
 * after selecting a callsign in the session table — destructive as well as
 * useless. Copy is the common case; clearing is not.
 */
describe('history keyboard shortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/history')
    apiMock.sessions.mockResolvedValue({ sessions: [session], nextCursor: null })
    apiMock.summaries.mockResolvedValue({ items: [], nextCursor: null })
    apiMock.track.mockResolvedValue(track)
    apiMock.savedViews.mockResolvedValue([])
    apiMock.coverage.mockResolvedValue({ cells: [] })
  })

  const selectTrack = async () => {
    const user = userEvent.setup()
    render(
      <Router>
        <HistoryPage />
      </Router>,
    )
    await user.click(await screen.findByRole('button', { name: /EZY42KD/i }, { timeout: 5_000 }))
    await waitFor(() => expect(apiMock.track).toHaveBeenCalledWith(SESSION_ID, 'auto', expect.any(AbortSignal)))
    expect(await screen.findByTestId('flight-profile')).toBeInTheDocument()
  }

  it('keeps the loaded tracks when c arrives as a copy chord', async () => {
    await selectTrack()

    fireEvent.keyDown(document, { key: 'c', metaKey: true })
    fireEvent.keyDown(document, { key: 'c', ctrlKey: true })

    expect(screen.getByTestId('flight-profile')).toBeInTheDocument()
  })

  it('still clears the loaded tracks on a plain c', async () => {
    await selectTrack()

    fireEvent.keyDown(document, { key: 'c' })

    await waitFor(() => expect(screen.queryByTestId('flight-profile')).not.toBeInTheDocument())
  })
})
