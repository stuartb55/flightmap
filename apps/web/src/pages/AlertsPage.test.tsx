import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchlistEntry } from '../types'
import { api } from '../lib/api'
import { Router } from '../lib/router'
import { AlertsPage } from './AlertsPage'

const dispatch = vi.fn()

vi.mock('../lib/api', () => ({
  api: {
    alertsPage: vi.fn(),
    watchlist: vi.fn(),
    addWatchlist: vi.fn(),
    removeWatchlist: vi.fn(),
    dismissAlert: vi.fn(),
    dismissAlerts: vi.fn(),
  },
}))

vi.mock('../state/LiveContext', () => ({
  useLive: () => ({ alerts: [], aircraftList: [], dispatch }),
}))

const watched: WatchlistEntry = {
  icao: '40621f',
  label: 'Old label',
  notes: 'Original note',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

afterEach(cleanup)

describe('AlertsPage watchlist editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.alertsPage).mockResolvedValue({ items: [], nextCursor: null })
    vi.mocked(api.watchlist).mockResolvedValue([watched])
  })

  it('offers direct links and rolls an optimistic edit back after failure', async () => {
    let rejectUpdate: (reason: Error) => void = () => undefined
    vi.mocked(api.addWatchlist).mockReturnValue(
      new Promise((_, reject) => {
        rejectUpdate = reject
      }),
    )
    render(<Router><AlertsPage /></Router>)

    expect(await screen.findByText('Old label')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Live' })).toHaveAttribute('href', '/?aircraft=40621f')
    expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute('href', '/history?aircraft=40621f')
    fireEvent.click(screen.getByRole('button', { name: 'Edit Old label' }))
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Changed label' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add or update' }))
    expect(await screen.findByText('Changed label')).toBeInTheDocument()
    rejectUpdate(new Error('Receiver database unavailable'))

    await waitFor(() => expect(screen.getByText('Old label')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Receiver database unavailable')
    expect(dispatch).toHaveBeenCalledWith({ type: 'watch-state', icao: '40621f', watched: true })
  })
})
