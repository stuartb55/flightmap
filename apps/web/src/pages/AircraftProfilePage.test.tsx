import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from '../lib/router'
import { aircraft } from '../test/fixtures'
import type { AircraftDetail } from '../types'

const apiMock = vi.hoisted(() => ({
  aircraft: vi.fn(),
  aircraftActivity: vi.fn(),
  addWatchlist: vi.fn(),
  removeWatchlist: vi.fn(),
}))

vi.mock('../lib/api', () => ({ api: apiMock }))

import { AircraftProfilePage } from './AircraftProfilePage'

function detail(overrides: Partial<AircraftDetail> = {}): AircraftDetail {
  return {
    aircraft: aircraft(),
    metadata: {
      registration: 'G-EZTH',
      typeCode: 'A320',
      description: 'Airbus A320',
      operator: 'easyJet',
      owner: 'easyJet Airline Company',
      country: 'United Kingdom',
    },
    recentSessions: [],
    alerts: [],
    summary: {
      firstSeenAt: '2025-01-01T10:00:00.000Z',
      lastSeenAt: '2026-08-01T12:00:00.000Z',
      observationCount: 4_210,
      sessionCount: 37,
      closestDistanceNm: 4.2,
    },
    ...overrides,
  }
}

const activity = {
  icao: '406b90',
  from: '2026-05-03T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  bucket: 'day' as const,
  totals: {
    observations: 4_210,
    positionedObservations: 4_000,
    sessions: 37,
    activeDays: 21,
    closestRangeNm: 4.2,
    maximumAltitudeFt: 38_000,
  },
  callsigns: ['EZY42KD', 'EZY18BQ'],
  series: [
    {
      bucketStart: '2026-07-31T00:00:00.000Z',
      bucketEnd: '2026-08-01T00:00:00.000Z',
      observations: 120,
      positionedObservations: 110,
      sessions: 2,
      closestRangeNm: 5.1,
      maximumAltitudeFt: 36_000,
    },
  ],
  detailedTrackFrom: '2026-07-02T00:00:00.000Z',
}

function renderProfile() {
  window.history.pushState({}, '', '/aircraft/406b90')
  return render(
    <Router>
      <AircraftProfilePage />
    </Router>,
  )
}

afterEach(cleanup)

describe('AircraftProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.aircraft.mockResolvedValue(detail())
    apiMock.aircraftActivity.mockResolvedValue(activity)
  })

  it('shows identity, lifetime statistics and observed callsigns', async () => {
    renderProfile()

    expect(await screen.findByRole('heading', { name: 'EZY42KD' })).toBeInTheDocument()
    expect(screen.getAllByText('4,210').length).toBeGreaterThan(0)
    expect(screen.getAllByText('4.2 nm').length).toBeGreaterThan(0)
    expect(screen.getByText('EZY18BQ')).toBeInTheDocument()
    expect(screen.getByText('38,000 ft')).toBeInTheDocument()
  })

  it('requests a different range when a preset is chosen', async () => {
    renderProfile()
    await screen.findByRole('heading', { name: 'EZY42KD' })

    await userEvent.click(screen.getByRole('button', { name: 'All time' }))
    await waitFor(() => {
      expect(apiMock.aircraftActivity).toHaveBeenLastCalledWith(
        '406b90',
        expect.objectContaining({ bucket: 'month' }),
        expect.anything(),
      )
    })
  })

  it('adds the aircraft to the watchlist and reloads it', async () => {
    renderProfile()
    await screen.findByRole('heading', { name: 'EZY42KD' })

    apiMock.addWatchlist.mockResolvedValue({ icao: '406b90' })
    apiMock.aircraft.mockResolvedValue(
      detail({ aircraft: aircraft({ watched: true }) }),
    )
    await userEvent.click(screen.getByRole('button', { name: /Add to watchlist/i }))

    expect(apiMock.addWatchlist).toHaveBeenCalledWith('406b90')
    expect(await screen.findByRole('button', { name: /On watchlist/i })).toBeInTheDocument()
  })

  it('explains when the aircraft is unknown', async () => {
    apiMock.aircraft.mockRejectedValue(new Error('Aircraft 406b90 was not found'))
    renderProfile()

    expect(await screen.findByRole('heading', { name: 'Aircraft not found' })).toBeInTheDocument()
    expect(screen.getByText('Aircraft 406b90 was not found')).toBeInTheDocument()
  })
})

describe('the aircraft photograph panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.aircraftActivity.mockResolvedValue(activity)
  })

  const photo = {
    available: true,
    credit: 'A Photographer',
    linkUrl: 'https://photos.example/photo/1',
    width: 640,
    height: 427,
  }

  const image = () => screen.queryByRole('img', { name: /G-EZTH/ })

  /*
   * The default. Item 26 ships photographs off, so the overwhelmingly common
   * profile is one with no photograph at all — and it has to look exactly as it
   * did before this existed.
   */
  it('renders no panel at all when photographs are switched off', async () => {
    apiMock.aircraft.mockResolvedValue(detail({ photo: null }))
    renderProfile()

    await screen.findByRole('heading', { name: 'EZY42KD' })
    expect(image()).not.toBeInTheDocument()
    expect(document.querySelector('.aircraft-photo-panel')).toBeNull()
  })

  /* A server older than the photograph cache sends no field at all. */
  it('renders no panel when the server does not send the field', async () => {
    apiMock.aircraft.mockResolvedValue(detail())
    renderProfile()

    await screen.findByRole('heading', { name: 'EZY42KD' })
    expect(document.querySelector('.aircraft-photo-panel')).toBeNull()
  })

  /* Not an empty frame, and not a spinner that never resolves: an airframe the
     source has no photograph of is the ordinary case. */
  it('renders no panel for an airframe with no photograph', async () => {
    apiMock.aircraft.mockResolvedValue(
      detail({ photo: { ...photo, available: false } }),
    )
    renderProfile()

    await screen.findByRole('heading', { name: 'EZY42KD' })
    expect(document.querySelector('.aircraft-photo-panel')).toBeNull()
  })

  it('shows the photograph served from this receiver', async () => {
    apiMock.aircraft.mockResolvedValue(detail({ photo }))
    renderProfile()

    const rendered = await screen.findByRole('img', { name: /G-EZTH/ })
    expect(rendered).toHaveAttribute('src', '/api/v1/aircraft/406b90/photo')
  })

  /*
   * The panel must not shift the page under someone already reading it, so the
   * box is reserved from the cached dimensions before any bytes arrive.
   */
  it('reserves the image box from the cached dimensions', async () => {
    apiMock.aircraft.mockResolvedValue(detail({ photo }))
    renderProfile()

    const rendered = await screen.findByRole('img', { name: /G-EZTH/ })
    expect(rendered).toHaveAttribute('width', '640')
    expect(rendered).toHaveAttribute('height', '427')
  })

  /*
   * What the airframe is, not what the element is. "Photo" would tell a
   * screen-reader user only that they are missing something.
   */
  it('describes the airframe rather than the element', async () => {
    apiMock.aircraft.mockResolvedValue(detail({ photo }))
    renderProfile()

    const rendered = await screen.findByRole('img', { name: /G-EZTH/ })
    expect(rendered).toHaveAttribute('alt', 'G-EZTH, Airbus A320')
  })

  it('falls back to the address when nothing identifies the airframe', async () => {
    apiMock.aircraft.mockResolvedValue(detail({ photo, metadata: null }))
    renderProfile()

    expect(await screen.findByRole('img', { name: 'Aircraft 406B90' })).toBeInTheDocument()
  })

  /* Most licences that permit redisplay require a visible credit, and a
     tooltip is not visible to a touch screen or to a reader. */
  it('credits the photographer and links back safely', async () => {
    apiMock.aircraft.mockResolvedValue(detail({ photo }))
    renderProfile()

    const link = await screen.findByRole('link', { name: 'A Photographer' })
    expect(link).toHaveAttribute('href', 'https://photos.example/photo/1')
    expect(link).toHaveAttribute('rel', 'noreferrer noopener')
  })

  it('still credits when the source gave a link and no photographer', async () => {
    apiMock.aircraft.mockResolvedValue(
      detail({ photo: { ...photo, credit: null } }),
    )
    renderProfile()

    expect(await screen.findByRole('link', { name: 'View the original' })).toBeInTheDocument()
  })

  /*
   * The one case the cache cannot rule out in advance: the row said `present`,
   * and maintenance evicted it between that answer and the request. Dropping
   * the panel is the same answer as never having had one.
   */
  it('drops the panel when the image turns out not to be there', async () => {
    apiMock.aircraft.mockResolvedValue(detail({ photo }))
    renderProfile()

    const rendered = await screen.findByRole('img', { name: /G-EZTH/ })
    fireEvent.error(rendered)

    await waitFor(() => expect(document.querySelector('.aircraft-photo-panel')).toBeNull())
  })
})
