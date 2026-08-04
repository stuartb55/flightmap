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
vi.mock('../components/FlightProfile', () => ({
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

describe('session ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/history')
    apiMock.sessions.mockResolvedValue({ sessions: [session], nextCursor: null })
    apiMock.summaries.mockResolvedValue({ items: [], nextCursor: null })
    apiMock.track.mockResolvedValue(track)
    apiMock.savedViews.mockResolvedValue([])
    apiMock.coverage.mockResolvedValue({ cells: [] })
  })

  it('starts from the ordering in the URL', async () => {
    window.history.replaceState(null, '', '/history?sort=closest_asc')
    render(
      <Router>
        <HistoryPage />
      </Router>,
    )

    await waitFor(() =>
      expect(apiMock.sessions).toHaveBeenCalledWith(
        expect.anything(),
        'closest_asc',
        null,
        expect.anything(),
      ),
    )
    expect(await screen.findByLabelText('Sort sessions')).toHaveValue('closest_asc')
  })

  it('re-orders without disturbing the tracks already on the map', async () => {
    const user = userEvent.setup()
    render(
      <Router>
        <HistoryPage />
      </Router>,
    )

    await user.click(await screen.findByRole('button', { name: /EZY42KD/i }, { timeout: 5_000 }))
    await waitFor(() => expect(apiMock.track).toHaveBeenCalledWith(SESSION_ID, 'auto'))
    const summaryCalls = apiMock.summaries.mock.calls.length

    await user.selectOptions(screen.getByLabelText('Sort sessions'), 'altitude_desc')

    await waitFor(() =>
      expect(apiMock.sessions).toHaveBeenLastCalledWith(
        expect.anything(),
        'altitude_desc',
        null,
        expect.anything(),
      ),
    )
    // The selection survives, and the retained summaries are not re-fetched:
    // neither depends on how the session list is ordered.
    expect(screen.getByTestId('flight-profile')).toBeInTheDocument()
    expect(apiMock.summaries).toHaveBeenCalledTimes(summaryCalls)

    await waitFor(
      () => expect(new URLSearchParams(window.location.search).get('sort')).toBe('altitude_desc'),
      { timeout: 5_000 },
    )
  })
})
