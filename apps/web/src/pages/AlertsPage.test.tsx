import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomAlertRule } from '@flightmap/shared'
import type { WatchlistEntry } from '../types'
import { api } from '../lib/api'
import { Router } from '../lib/router'
import type { AlertEvent } from '../types'
import { formatDateTimeInput } from '../lib/format'
import { AlertsPage, alertHistorySearch, groupByDay } from './AlertsPage'

const dispatch = vi.fn()

vi.mock('../lib/api', () => ({
  api: {
    alertsPage: vi.fn(),
    watchlist: vi.fn(),
    addWatchlist: vi.fn(),
    removeWatchlist: vi.fn(),
    dismissAlert: vi.fn(),
    dismissAlerts: vi.fn(),
    customAlertRules: vi.fn(),
    previewCustomAlertRule: vi.fn(),
    createCustomAlertRule: vi.fn(),
    updateCustomAlertRule: vi.fn(),
    deleteCustomAlertRule: vi.fn(),
  },
}))

vi.mock('../state/LiveContext', () => ({
  useLiveStatus: () => ({ alerts: [] }),
  useLiveAircraft: () => ({ aircraftList: [] }),
  useLiveDispatch: () => dispatch,
}))

const watched: WatchlistEntry = {
  icao: '40621f',
  label: 'Old label',
  notes: 'Original note',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

const nearbyRule: CustomAlertRule = {
  id: '2f1c0f5a-0f0e-4d5e-9a2b-6c1d3f8e7a11',
  name: 'Nearby aircraft',
  enabled: true,
  severity: 'warning',
  callsignPrefix: null,
  icao: null,
  operator: null,
  typeCode: null,
  minimumAltitudeFt: null,
  maximumAltitudeFt: null,
  minimumDistanceNm: null,
  maximumDistanceNm: 100,
  cooldownMinutes: 0,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

afterEach(cleanup)

describe('AlertsPage watchlist editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.alertsPage).mockResolvedValue({ items: [], nextCursor: null })
    vi.mocked(api.watchlist).mockResolvedValue([watched])
    vi.mocked(api.customAlertRules).mockResolvedValue([])
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

  it('keeps routine first sightings out of the alert rules', async () => {
    render(<Router><AlertsPage /></Router>)

    expect(await screen.findByText('Events that may need attention: emergency reports and watchlist matches.')).toBeInTheDocument()
    expect(screen.getByText(/New aircraft are recorded in receiver history without creating an alert/)).toBeInTheDocument()
    expect(screen.queryByText('First sighting')).not.toBeInTheDocument()
  })

  it('toggles a custom rule optimistically and rolls back after failure', async () => {
    let rejectUpdate: (reason: Error) => void = () => undefined
    vi.mocked(api.customAlertRules).mockResolvedValue([nearbyRule])
    vi.mocked(api.updateCustomAlertRule).mockReturnValue(
      new Promise((_, reject) => {
        rejectUpdate = reject
      }),
    )
    render(<Router><AlertsPage /></Router>)

    const toggle = await screen.findByRole('checkbox', { name: 'Enabled' })
    fireEvent.click(toggle)
    expect(await screen.findByRole('checkbox', { name: 'Disabled' })).not.toBeChecked()
    expect(api.updateCustomAlertRule).toHaveBeenCalledWith(nearbyRule.id, { enabled: false })
    rejectUpdate(new Error('Receiver database unavailable'))

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeChecked())
    expect(screen.getByRole('alert')).toHaveTextContent('Receiver database unavailable')
  })
})

describe('groupByDay', () => {
  const event = (createdAt: string, id: string): AlertEvent => ({
    id,
    type: 'watchlist',
    createdAt,
    icao: '406b90',
    callsign: 'EZY42KD',
    title: 'Watchlist aircraft detected',
    message: 'Watchlisted aircraft is active',
    dismissedAt: null,
    severity: 'info',
  })

  /* The stream reads top to bottom in the order the list arrived in, so the
     headings have to appear in that order rather than in date order. */
  it('groups consecutive alerts under the day they happened on', () => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 86_400_000)
    const older = new Date(now.getTime() - 5 * 86_400_000)
    const groups = groupByDay([
      event(now.toISOString(), 'a'),
      event(now.toISOString(), 'b'),
      event(yesterday.toISOString(), 'c'),
      event(older.toISOString(), 'd'),
    ])

    expect(groups.map(([label]) => label).slice(0, 2)).toEqual(['Today', 'Yesterday'])
    expect(groups.map(([, entries]) => entries.length)).toEqual([2, 1, 1])
    expect(groups).toHaveLength(3)
  })

  it('returns nothing to caption when there are no alerts', () => {
    expect(groupByDay([])).toEqual([])
  })
})

describe('alertHistorySearch', () => {
  const alertAt = '2026-08-11T12:26:52.000Z'
  const now = new Date('2026-08-13T13:00:00.000Z')

  /* The bug this replaces: the link carried only the aircraft, so the history
     page applied its own six-hour default and an alert older than that opened
     on "no sessions found" for a track that was there all along. */
  it('brackets the alert rather than leaving the page on its own default', () => {
    const params = new URLSearchParams(alertHistorySearch('4070e6', alertAt, now).split('?')[1])
    expect(params.get('aircraft')).toBe('4070e6')
    expect(params.get('from')).toBe(formatDateTimeInput(new Date(Date.parse(alertAt) - 24 * 3_600_000)))
    expect(params.get('to')).toBe(formatDateTimeInput(new Date(Date.parse(alertAt) + 3_600_000)))
  })

  /* Sessions are matched on when they started, so the lead is what has to
     cover a session already running long before it raised the alert. The
     window's ends are minute-precise, so this is a floor rather than an
     equality: the alert's own seconds are not carried into the field. */
  it('leads the alert by a day, so a long-running session is still found', () => {
    const params = new URLSearchParams(alertHistorySearch('4070e6', alertAt, now).split('?')[1])
    const lead = Date.parse(alertAt) - new Date(params.get('from') ?? '').getTime()
    expect(lead).toBeGreaterThanOrEqual(24 * 3_600_000)
    expect(lead).toBeLessThan(24 * 3_600_000 + 60_000)
  })

  /* A "to" past the present reads as a range the receiver cannot have filled. */
  it('never runs the window past now', () => {
    const justNow = new Date(now.getTime() - 60_000).toISOString()
    const params = new URLSearchParams(alertHistorySearch('4070e6', justNow, now).split('?')[1])
    expect(params.get('to')).toBe(formatDateTimeInput(now))
  })

  it('falls back to the aircraft alone when the alert has no usable time', () => {
    expect(alertHistorySearch('4070e6', 'not-a-date', now)).toBe('/history?aircraft=4070e6')
  })
})
