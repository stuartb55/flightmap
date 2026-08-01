import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { Router } from '../lib/router'
import { aircraft } from '../test/fixtures'
import { AircraftDetailPanel } from './AircraftDetailPanel'

const dispatch = vi.fn()

vi.mock('../lib/api', () => ({
  api: {
    aircraft: vi.fn(),
    watchlist: vi.fn(),
    addWatchlist: vi.fn(),
    removeWatchlist: vi.fn(),
  },
}))

vi.mock('../state/LiveContext', () => ({
  useLive: () => ({ dispatch }),
}))

afterEach(cleanup)

describe('AircraftDetailPanel identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.aircraft).mockResolvedValue({
      aircraft: null,
      metadata: {
        registration: 'G-EZTH',
        typeCode: 'A320',
        description: 'Airbus A320',
        operator: 'Registry operator',
        owner: null,
        country: 'United Kingdom',
      },
      recentSessions: [],
      alerts: [],
      summary: null,
    })
  })

  it('shows the callsign and prefers its inferred operating airline', async () => {
    render(
      <Router>
        <AircraftDetailPanel aircraft={aircraft()} onClose={vi.fn()} />
      </Router>,
    )

    const heading = screen.getByRole('heading', { name: 'Aircraft identity' })
    const section = heading.closest('section')
    expect(section).not.toBeNull()
    expect(within(section!).getByText('EZY42KD')).toBeInTheDocument()
    expect(await within(section!).findByText('easyJet')).toBeInTheDocument()
    expect(within(section!).getByText('EZY callsign')).toBeInTheDocument()
  })

  it('keeps metadata as the fallback for an unknown callsign', async () => {
    render(
      <Router>
        <AircraftDetailPanel
          aircraft={aircraft({ callsign: 'XYZ123', operator: null })}
          onClose={vi.fn()}
        />
      </Router>,
    )

    expect(await screen.findByText('Registry operator')).toBeInTheDocument()
    expect(screen.queryByText('XYZ callsign')).not.toBeInTheDocument()
  })
})
