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
  useLiveDispatch: () => dispatch,
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

  it('reads out the live figures beside the callsign it belongs to', async () => {
    render(
      <Router>
        <AircraftDetailPanel
          aircraft={aircraft({ altitudeBaro: 34875, groundSpeed: 412, track: 71, distanceNm: 12.4 })}
          onClose={vi.fn()}
        />
      </Router>,
    )

    // The collapsed bottom sheet shows the hero alone, so these have to be in it.
    const hero = document.querySelector('.detail-hero')
    expect(hero).not.toBeNull()
    expect(within(hero as HTMLElement).getByText('34,875 ft')).toBeInTheDocument()
    expect(within(hero as HTMLElement).getByText('412 kt')).toBeInTheDocument()
    expect(within(hero as HTMLElement).getByText('071°')).toBeInTheDocument()
    expect(
      within(hero as HTMLElement).getByRole('button', { name: 'Add to watchlist' }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Aircraft identity' })).toBeInTheDocument()
  })

  /*
   * The summary is authoritative and arrives a moment after the panel opens, so
   * the badge follows the same preference the "First seen" row does rather than
   * settling on whatever the live payload happened to carry first.
   */
  it('marks a first sighting in the hero, preferring the summary once it lands', async () => {
    const cutoff = Date.parse('2026-08-01T00:00:00.000Z')
    vi.mocked(api.aircraft).mockResolvedValue({
      aircraft: null,
      metadata: null,
      recentSessions: [],
      alerts: [],
      summary: {
        firstSeenAt: '2026-08-04T09:00:00.000Z',
        lastSeenAt: '2026-08-05T09:00:00.000Z',
        observationCount: 12,
        sessionCount: 1,
        closestDistanceNm: 4,
      },
    })
    render(
      <Router>
        <AircraftDetailPanel
          aircraft={aircraft({ firstSeenAt: '2019-01-02T09:00:00.000Z' })}
          newSince={cutoff}
          onClose={vi.fn()}
        />
      </Router>,
    )

    const badge = await screen.findByText('NEW')
    expect(badge.closest('.detail-hero')).not.toBeNull()
    expect(badge).toHaveTextContent('to this receiver')
  })

  it('leaves the hero unmarked with no summary row and no preference', async () => {
    render(
      <Router>
        <AircraftDetailPanel aircraft={aircraft({ firstSeenAt: null })} newSince={0} onClose={vi.fn()} />
      </Router>,
    )
    expect(await screen.findByRole('heading', { name: 'Aircraft identity' })).toBeInTheDocument()
    expect(screen.queryByText('NEW')).not.toBeInTheDocument()
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
