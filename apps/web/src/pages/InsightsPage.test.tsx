import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { InsightCoverageResponse, InsightOverview } from '@flightmap/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InsightsPage, insightRangeForPreset } from './InsightsPage'
import { api } from '../lib/api'

vi.mock('../components/CoverageMap', () => ({
  CoverageMap: ({ cells }: { cells: unknown[] }) => <div data-testid="coverage-map">{cells.length} cells</div>,
}))

vi.mock('../lib/api', () => ({
  api: {
    insightsOverview: vi.fn(),
    insightsCoverage: vi.fn(),
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

describe('InsightsPage', () => {
  beforeEach(() => {
    vi.mocked(api.insightsOverview).mockResolvedValue(overview())
    vi.mocked(api.insightsCoverage).mockResolvedValue(coverage)
  })

  it('renders chart summaries, equivalent data tables, leaders, and coverage', async () => {
    render(<InsightsPage />)
    expect(await screen.findByText('1,250')).toBeInTheDocument()
    expect(screen.getByText(/Busiest hour:/)).toBeInTheDocument()
    expect(screen.getByText('View activity data table')).toBeInTheDocument()
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
    render(<InsightsPage />)
    expect(await screen.findByText('No receiver activity in this range')).toBeInTheDocument()
    expect(screen.getByText('Preparing historical insights')).toBeInTheDocument()
    expect(screen.getByText('No aggregated coverage yet')).toBeInTheDocument()
    expect(screen.getByText('Historical aggregates are still being backfilled.')).toBeInTheDocument()
  })

  it('keeps coverage usable when the activity request fails', async () => {
    vi.mocked(api.insightsOverview).mockRejectedValue(new Error('Overview unavailable'))
    render(<InsightsPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Overview unavailable')
    await waitFor(() => expect(screen.getByTestId('coverage-map')).toBeInTheDocument())
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
