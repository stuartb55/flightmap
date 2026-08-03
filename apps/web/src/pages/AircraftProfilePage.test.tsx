import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
