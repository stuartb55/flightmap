import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { InsightCoverageResponse, InsightOverview } from '@flightmap/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InsightsPage, insightRangeForPreset } from './InsightsPage'
import { Router } from '../lib/router'
import { api } from '../lib/api'
import { resetSavedViews } from '../lib/saved-views'
import { defaultMapLayers } from '../lib/map-preferences'

vi.mock('../components/CoverageMap', () => ({
  CoverageMap: ({ cells }: { cells: unknown[] }) => <div data-testid="coverage-map">{cells.length} cells</div>,
}))

vi.mock('../lib/api', () => ({
  api: {
    insightsOverview: vi.fn(),
    insightsCoverage: vi.fn(),
    insightPatterns: vi.fn(),
    rangeProfile: vi.fn(),
    coverageCellDetail: vi.fn(),
    receiverRecords: vi.fn(),
    savedViews: vi.fn().mockResolvedValue([]),
    createSavedView: vi.fn(),
    updateSavedView: vi.fn(),
    deleteSavedView: vi.fn(),
  },
}))

const availability = {
  hourlyFrom: '2026-07-01T00:00:00.000Z',
  dailyFrom: '2026-01-01',
  coverageFrom: '2026-07-01',
  detailedTrackFrom: '2026-07-01T00:00:00.000Z',
  partial: false,
  notices: [],
  backfill: {
    status: 'complete' as const,
    processedDays: 30,
    totalDays: 30,
    nextDate: null,
    error: null,
  },
}

function overview(overrides: Partial<InsightOverview> = {}): InsightOverview {
  return {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-01T12:00:00.000Z',
    bucket: 'hour',
    metrics: {
      uniqueAircraft: 12,
      sessions: 15,
      reports: 1_250,
      positionedReports: 1_100,
      maximumRangeNm: 82.4,
      maximumAltitudeFt: 41_000,
    },
    series: [
      {
        bucketStart: '2026-08-01T10:00:00.000Z',
        bucketEnd: '2026-08-01T11:00:00.000Z',
        uniqueAircraft: 8,
        sessions: 9,
        reports: 1_250,
        positionedReports: 1_100,
        maximumRangeNm: 82.4,
        maximumAltitudeFt: 41_000,
        messageRatePerSecond: 125.5,
        receiverAvailabilityPercent: 98.5,
        rejectedRecords: 2,
        dataGapMinutes: 1,
      },
    ],
    leaders: {
      aircraft: [{ key: 'abc123', label: 'G-TEST', secondary: 'A320', reports: 500, positionedReports: 450, sessions: 3 }],
      types: [{ key: 'a320', label: 'A320', secondary: null, reports: 500, positionedReports: 450, sessions: 3 }],
      operators: [{ key: 'test air', label: 'Test Air', secondary: null, reports: 500, positionedReports: 450, sessions: 3 }],
    },
    availability,
    ...overrides,
  }
}

const coverage: InsightCoverageResponse = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-01T12:00:00.000Z',
  cells: [
    {
      latitude: 53.625,
      longitude: -2.275,
      south: 53.6,
      west: -2.3,
      north: 53.65,
      east: -2.25,
      reports: 900,
      uniqueAircraft: 10,
      maximumAltitudeFt: 40_000,
    },
  ],
  truncated: false,
  availability,
}

afterEach(cleanup)

function renderPage() {
  return render(
    <Router>
      <InsightsPage />
    </Router>,
  )
}

const records = {
  records: [
    {
      kind: 'farthest_contact' as const,
      value: 248.4,
      unit: 'distance_nm' as const,
      occurredOn: '2026-03-14',
      icao: 'abc123',
      label: 'G-FARR',
      secondary: 'B788 · Test Air',
      detailedTrackAvailable: false,
    },
    {
      kind: 'busiest_day' as const,
      value: 1_240_000,
      unit: 'count' as const,
      occurredOn: '2026-08-01',
      icao: null,
      label: null,
      secondary: null,
      detailedTrackAvailable: true,
    },
  ],
  availableFrom: '2026-01-01',
  detailedFrom: '2026-07-01',
}

describe('InsightsPage', () => {
  beforeEach(() => {
    resetSavedViews()
    vi.mocked(api.savedViews).mockResolvedValue([])
    window.history.replaceState(null, '', '/insights')
    vi.mocked(api.insightsOverview).mockResolvedValue(overview())
    vi.mocked(api.insightsCoverage).mockResolvedValue(coverage)
    vi.mocked(api.insightPatterns).mockResolvedValue({ from: coverage.from, to: coverage.to, timeZone: 'Europe/London', cells: [], busiest: null, availability })
    vi.mocked(api.rangeProfile).mockResolvedValue({ from: coverage.from, to: coverage.to, altitudeBand: 'all', sectors: [], availableFrom: null })
    vi.mocked(api.coverageCellDetail).mockResolvedValue({
      from: coverage.from,
      to: coverage.to,
      cell: coverage.cells[0]!,
      aircraft: [{ icao: 'abc123', registration: 'G-CVRG', typeCode: 'A320', operator: 'Test Air' }],
    })
    vi.mocked(api.receiverRecords).mockResolvedValue(records)
  })

  it('renders chart summaries, equivalent data tables, leaders, and coverage', async () => {
    renderPage()
    expect(await screen.findByText('1,250')).toBeInTheDocument()
    expect(screen.getByText(/Busiest hour:/)).toBeInTheDocument()
    expect(screen.getByText('View activity data table')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Receiver performance context' })).toHaveTextContent('98.5%')
    expect(screen.getByText('G-TEST')).toBeInTheDocument()
    expect(screen.getByTestId('coverage-map')).toHaveTextContent('1 cells')
    expect(screen.getByText('View busiest coverage cells')).toBeInTheDocument()
  })

  it('shows empty, partial, and active backfill states independently', async () => {
    vi.mocked(api.insightsOverview).mockResolvedValue(
      overview({
        metrics: { uniqueAircraft: 0, sessions: 0, reports: 0, positionedReports: 0, maximumRangeNm: null, maximumAltitudeFt: null },
        series: [],
        availability: {
          ...availability,
          partial: true,
          notices: ['Historical aggregates are still being backfilled.'],
          backfill: { ...availability.backfill, status: 'running', processedDays: 5, totalDays: 30, nextDate: '2026-07-07' },
        },
      }),
    )
    vi.mocked(api.insightsCoverage).mockResolvedValue({ ...coverage, cells: [] })
    renderPage()
    expect(await screen.findByText('No receiver activity in this range')).toBeInTheDocument()
    expect(screen.getByText('Preparing historical insights')).toBeInTheDocument()
    expect(screen.getByText('No aggregated coverage yet')).toBeInTheDocument()
    expect(screen.getByText('Historical aggregates are still being backfilled.')).toBeInTheDocument()
  })

  it('keeps coverage usable when the activity request fails', async () => {
    vi.mocked(api.insightsOverview).mockRejectedValue(new Error('Overview unavailable'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Overview unavailable')
    await waitFor(() => expect(screen.getByTestId('coverage-map')).toBeInTheDocument())
  })

  it('requests and renders the immediately preceding period comparison', async () => {
    vi.mocked(api.insightsOverview).mockResolvedValue(
      overview({
        comparison: {
          from: '2026-07-31T12:00:00.000Z',
          to: '2026-08-01T00:00:00.000Z',
          metrics: { uniqueAircraft: 10, sessions: 10, reports: 1000, positionedReports: 900, maximumRangeNm: 70, maximumAltitudeFt: 40000 },
          changes: {
            uniqueAircraft: { absolute: 2, percent: 20 },
            sessions: { absolute: 5, percent: 50 },
            reports: { absolute: 250, percent: 25 },
            positionedReports: { absolute: 200, percent: 22.2 },
            maximumRangeNm: { absolute: 12.4, percent: 17.7 },
            maximumAltitudeFt: { absolute: 1000, percent: 2.5 },
          },
        },
      }),
    )
    renderPage()
    await screen.findByText('1,250')
    fireEvent.click(screen.getByLabelText('Compare preceding period'))
    await waitFor(() => expect(api.insightsOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ compare: true }),
      expect.any(AbortSignal),
    ))
    expect(await screen.findByText('Compared with the preceding period')).toBeInTheDocument()
    expect(screen.getByText('+20% vs previous')).toBeInTheDocument()
  })

  it('drills through the activity chart with the router rather than a document load', async () => {
    renderPage()
    await screen.findByText('1,250')
    fireEvent.click(screen.getByRole('button', { name: /1,250 reports, 8 aircraft/ }))
    expect(window.location.pathname).toBe('/history')
    expect(new URLSearchParams(window.location.search).get('from')).toBe('2026-08-01T10:00:00.000Z')
    expect(new URLSearchParams(window.location.search).get('to')).toBe('2026-08-01T11:00:00.000Z')
  })

  it('routes the leader lists and coverage aircraft without leaving the document', async () => {
    renderPage()
    await screen.findByText('1,250')

    const aircraft = screen.getByRole('link', { name: /G-TEST/ })
    // fireEvent returns false when the handler called preventDefault, which is
    // what distinguishes a routed link from one the browser would follow.
    expect(fireEvent.click(aircraft)).toBe(false)
    expect(window.location.pathname).toBe('/aircraft/abc123')

    window.history.replaceState(null, '', '/insights')
    const operator = screen.getByRole('link', { name: /Test Air/ })
    expect(fireEvent.click(operator)).toBe(false)
    expect(window.location.pathname).toBe('/history')
    expect(new URLSearchParams(window.location.search).get('operator')).toBe('Test Air')

    window.history.replaceState(null, '', '/insights')
    fireEvent.click(screen.getByRole('button', { name: '53.625, -2.275' }))
    const coverageAircraft = await screen.findByRole('link', { name: /G-CVRG/ })
    expect(fireEvent.click(coverageAircraft)).toBe(false)
    expect(window.location.pathname).toBe('/aircraft/abc123')
  })

  // The whole point of a default is that the surface opens on it. Querying the
  // built-in range first and the default's range second would show the wrong
  // numbers before the right ones.
  it('queries the default view range first, without a request for the built-in range', async () => {
    vi.mocked(api.savedViews).mockResolvedValue([
      {
        id: '2b0b6b9c-2a49-4e6f-9d5a-9f8d1a44e0b2',
        name: 'Last 30 days',
        surface: 'insights',
        configuration: {
          surface: 'insights',
          from: '2026-07-02T00:00:00.000Z',
          to: '2026-08-01T00:00:00.000Z',
          bucket: 'day',
          preset: '30d',
          sort: 'reports_desc',
          compare: false,
          mapLayers: defaultMapLayers,
          viewport: null,
        },
        isDefault: true,
        pinnedAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ])
    vi.mocked(api.insightsOverview).mockClear()
    renderPage()
    await screen.findByText('1,250')
    expect(api.insightsOverview).toHaveBeenCalledTimes(1)
    expect(api.insightsOverview).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-07-02T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }),
      expect.any(AbortSignal),
    )
  })

  it('leaves modifier and middle clicks to the browser so links still open in a new tab', async () => {
    renderPage()
    await screen.findByText('1,250')
    const aircraft = screen.getByRole('link', { name: /G-TEST/ })
    expect(aircraft).toHaveAttribute('href', '/aircraft/abc123')

    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(fireEvent.click(aircraft, modifier)).toBe(true)
      expect(window.location.pathname).toBe('/insights')
    }
  })

  it('shows all-time records, says they ignore the range, and degrades expired links', async () => {
    // Call counts accumulate across this file's tests; this one counts them.
    vi.mocked(api.receiverRecords).mockClear()
    vi.mocked(api.insightsOverview).mockClear()
    renderPage()
    const panel = await screen.findByRole('region', { name: 'All-time receiver records' })
    // The panel is above the date controls and does not move with them, which
    // reads as a bug unless it is said out loud.
    expect(panel).toHaveTextContent(/do not change with the date range below/)
    expect(panel).toHaveTextContent('248 nm')
    expect(panel).toHaveTextContent('1.2M reports')

    // The record is kept for ever; the track that set it was not, so the link
    // degrades to the profile rather than landing on an empty search.
    expect(within(panel).getByRole('link', { name: 'Aircraft profile' })).toHaveAttribute(
      'href',
      '/aircraft/abc123',
    )
    expect(panel).toHaveTextContent('Detailed track expired')
    // The busiest day is still inside retention, so it drills through.
    expect(within(panel).getByRole('link', { name: 'History' })).toHaveAttribute(
      'href',
      '/history?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-01T23%3A59%3A59.999Z',
    )
    // All-time means all-time: changing the range must not refetch them.
    expect(api.receiverRecords).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '7 days' }))
    await waitFor(() => expect(api.insightsOverview).toHaveBeenCalledTimes(2))
    expect(api.receiverRecords).toHaveBeenCalledTimes(1)
  })

  it('explains an empty record set rather than showing a row of zeros', async () => {
    vi.mocked(api.receiverRecords).mockResolvedValue({
      records: [],
      availableFrom: null,
      detailedFrom: '2026-07-01',
    })
    renderPage()
    const panel = await screen.findByRole('region', { name: 'All-time receiver records' })
    expect(panel).toHaveTextContent(/No records yet/)
    expect(panel).not.toHaveTextContent('0 nm')
  })

  it('keeps the rest of Insights when records are unavailable', async () => {
    vi.mocked(api.receiverRecords).mockRejectedValue(new Error('Records unavailable'))
    renderPage()
    expect(await screen.findByText('1,250')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'All-time receiver records' })).toBeNull()
  })
})

describe('insight presets', () => {
  it('uses hourly buckets for 24 hours and daily buckets for 7 and 30 days', () => {
    const now = new Date('2026-08-01T12:00:00.000Z')
    expect(insightRangeForPreset('24h', now)).toMatchObject({
      from: '2026-07-31T12:00:00.000Z',
      bucket: 'hour',
    })
    expect(insightRangeForPreset('7d', now).bucket).toBe('day')
    expect(insightRangeForPreset('30d', now).bucket).toBe('day')
  })
})
