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

// The narrow layout shows either the results or the map, never both.
function useNarrowLayout(narrow: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: narrow && query === '(max-width: 800px)',
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList)
}

afterEach(cleanup)

describe('history results and map switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/history')
    apiMock.sessions.mockResolvedValue({ sessions: [session], nextCursor: null })
    apiMock.summaries.mockResolvedValue({ summaries: [], nextCursor: null })
    apiMock.track.mockResolvedValue(track)
    apiMock.savedViews.mockResolvedValue([])
    apiMock.coverage.mockResolvedValue({ cells: [] })
  })

  it('moves to the map when a track loads and back when results is pressed', async () => {
    useNarrowLayout(true)
    const user = userEvent.setup()
    const { container } = render(
      <Router>
        <HistoryPage />
      </Router>,
    )

    const page = container.querySelector('.history-page')
    expect(page).toHaveClass('show-results')

    await user.click(await screen.findByRole('button', { name: /EZY42KD/i }, { timeout: 5_000 }))
    await waitFor(() => expect(page).toHaveClass('show-map'))
    // The profile panel would leave the map shorter than the replay controls.
    expect(screen.queryByTestId('flight-profile')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Results/ }))
    expect(page).toHaveClass('show-results')
  })

  it('opens the profile with the track on a wide layout', async () => {
    useNarrowLayout(false)
    const user = userEvent.setup()
    render(
      <Router>
        <HistoryPage />
      </Router>,
    )

    await user.click(await screen.findByRole('button', { name: /EZY42KD/i }, { timeout: 5_000 }))
    expect(await screen.findByTestId('flight-profile')).toBeInTheDocument()
  })
})
