import { cleanup, render, waitFor } from '@testing-library/react'
import type { SavedView } from '@flightmap/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from '../lib/router'
import { resetSavedViews } from '../lib/saved-views'
import { defaultMapLayers } from '../lib/map-preferences'

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

const defaultView: SavedView = {
  id: '5c0f0b21-3b0a-4a54-9e1a-7f4a0f1c2d33',
  name: 'easyJet last week',
  surface: 'history',
  configuration: {
    surface: 'history',
    filters: {
      query: '',
      icao: '',
      callsign: '',
      registration: '',
      type: '',
      operator: 'easyJet',
      from: '2026-07-25T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      alert: '',
    },
    sort: 'closest_asc',
    selectedSessionIds: [],
    replayTime: null,
    resolution: 'auto',
    mapLayers: defaultMapLayers,
    viewport: null,
  },
  isDefault: true,
  pinnedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

function renderPage() {
  return render(
    <Router>
      <HistoryPage />
    </Router>,
  )
}

afterEach(cleanup)

describe('history default saved view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSavedViews()
    window.history.replaceState(null, '', '/history')
    apiMock.sessions.mockResolvedValue({ sessions: [], nextCursor: null })
    apiMock.summaries.mockResolvedValue({ items: [], nextCursor: null })
    apiMock.coverage.mockResolvedValue({ cells: [] })
    apiMock.savedViews.mockResolvedValue([defaultView])
  })

  it('searches the default view once, and rewrites the URL to describe it', async () => {
    renderPage()

    await waitFor(() =>
      expect(apiMock.sessions).toHaveBeenCalledWith(
        expect.objectContaining({ operator: 'easyJet' }),
        'closest_asc',
        null,
        expect.anything(),
      ),
    )
    // One search: the built-in six-hour window must never reach the server, or
    // the page shows its results before the default's replace them.
    expect(apiMock.sessions).toHaveBeenCalledTimes(1)
    expect(new URLSearchParams(window.location.search).get('operator')).toBe('easyJet')
  })

  it('leaves a URL that carries its own parameters alone', async () => {
    window.history.replaceState(null, '', '/history?operator=Ryanair')
    renderPage()

    await waitFor(() =>
      expect(apiMock.sessions).toHaveBeenCalledWith(
        expect.objectContaining({ operator: 'Ryanair' }),
        'started_desc',
        null,
        expect.anything(),
      ),
    )
    expect(apiMock.sessions).toHaveBeenCalledTimes(1)
    expect(new URLSearchParams(window.location.search).get('operator')).toBe('Ryanair')
  })

  it('starts from the built-in range when no default is set', async () => {
    apiMock.savedViews.mockResolvedValue([{ ...defaultView, isDefault: false }])
    renderPage()

    await waitFor(() => expect(apiMock.sessions).toHaveBeenCalledTimes(1))
    expect(apiMock.sessions).toHaveBeenCalledWith(
      expect.objectContaining({ operator: '' }),
      'started_desc',
      null,
      expect.anything(),
    )
    expect(window.location.search).toBe('')
  })

  it('searches anyway when the saved views request fails', async () => {
    apiMock.savedViews.mockRejectedValue(new Error('Saved views unavailable'))
    renderPage()

    await waitFor(() => expect(apiMock.sessions).toHaveBeenCalledTimes(1))
  })
})
