import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from '../lib/router'
import { resetSavedViews } from '../lib/saved-views'

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

import { HistoryPage, patternWindowLabel } from './HistoryPage'

function renderPage() {
  return render(
    <Router>
      <HistoryPage />
    </Router>,
  )
}

afterEach(cleanup)

/**
 * The weekday-hour window arrives from the Insights pattern grid, and no field
 * in the search form shows it. It has to announce itself, say what it narrowed
 * to, and offer a way out — otherwise the results look arbitrarily short.
 */
describe('history pattern window', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSavedViews()
    apiMock.sessions.mockResolvedValue({ sessions: [], nextCursor: null })
    apiMock.summaries.mockResolvedValue({ items: [], nextCursor: null })
    apiMock.coverage.mockResolvedValue({ cells: [] })
    apiMock.savedViews.mockResolvedValue([])
    window.history.replaceState(null, '', '/history?weekday=1&hour=14')
  })

  it('carries the window into the search and says which sessions it holds', async () => {
    renderPage()

    await waitFor(() =>
      expect(apiMock.sessions).toHaveBeenCalledWith(
        expect.objectContaining({ weekday: 1, hour: 14 }),
        'started_desc',
        null,
        expect.anything(),
      ),
    )
    const chip = await screen.findByRole('status')
    expect(chip).toHaveTextContent('Tuesday 14:00–15:00')
    // The grid counts sessions heard in the window; this list holds the ones
    // that started in it, and the difference is stated rather than implied.
    expect(chip).toHaveTextContent(/started in this hour/)
  })

  it('clears the window back to an unfiltered search', async () => {
    renderPage()
    await waitFor(() => expect(apiMock.sessions).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    await waitFor(() =>
      expect(apiMock.sessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ weekday: null, hour: null }),
        'started_desc',
        null,
        expect.anything(),
      ),
    )
    expect(window.location.search).not.toContain('weekday=')
    expect(screen.queryByText(/Tuesday 14:00/)).toBeNull()
  })

  it('ignores half a window rather than filtering on a weekday alone', async () => {
    window.history.replaceState(null, '', '/history?weekday=1')
    renderPage()

    await waitFor(() =>
      expect(apiMock.sessions).toHaveBeenCalledWith(
        expect.objectContaining({ weekday: null, hour: null }),
        'started_desc',
        null,
        expect.anything(),
      ),
    )
    expect(screen.queryByText(/Tuesday/)).toBeNull()
  })

  it('names the window as a whole hour, and wraps the last one onto midnight', () => {
    expect(patternWindowLabel(0, 9)).toBe('Monday 09:00–10:00')
    expect(patternWindowLabel(6, 23)).toBe('Sunday 23:00–00:00')
  })
})
