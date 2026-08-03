import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemStatus } from '../types'

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  insightsOverview: vi.fn(),
}))

vi.mock('../lib/api', () => ({ api: apiMock }))

import { SystemPage } from './SystemPage'

function status(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    overall: 'ok',
    version: '0.1.0',
    receiver: {
      status: 'online',
      url: 'http://receiver.local/data',
      lastAircraftPollAt: '2026-08-01T12:00:00.000Z',
      lastStatsPollAt: '2026-08-01T11:59:00.000Z',
      latencyMs: 120,
      software: 'readsb 3.14',
    },
    collector: {
      status: 'running',
      pollIntervalMs: 1_000,
      snapshotRate: 1,
      aircraftRate: 250,
      rejectedRecords: 0,
      lastError: null,
    },
    database: {
      status: 'ok',
      sizeBytes: 3 * 1024 ** 3,
      capacityBytes: 20 * 1024 ** 3,
      usePercent: 15,
      oldestSampleAt: '2026-07-02T00:00:00.000Z',
      newestSampleAt: '2026-08-01T12:00:00.000Z',
      retainedDays: 30,
    },
    metadata: {
      status: 'ok',
      updatedAt: '2026-07-30T02:00:00.000Z',
      version: '2026-07-30',
      rowCount: 480_000,
      nextUpdateAt: '2026-08-06T02:00:00.000Z',
      lastError: null,
    },
    uptimeSeconds: 3 * 86_400 + 4 * 3_600,
    ...overrides,
  }
}

afterEach(cleanup)

describe('SystemPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.insightsOverview.mockResolvedValue({
      availability: { backfill: { status: 'complete', processedDays: 30, totalDays: 30 } },
    })
  })

  it('renders receiver, collector, database and metadata health', async () => {
    apiMock.status.mockResolvedValue(status())
    render(<SystemPage />)

    expect(await screen.findByText('All systems nominal')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'System' })).toBeInTheDocument()
    expect(screen.getByText('3d 4h')).toBeInTheDocument()
    expect(screen.getByText('3.0 GB')).toBeInTheDocument()
    expect(screen.getByText('readsb 3.14')).toBeInTheDocument()
  })

  it('surfaces a failing status endpoint and retries on demand', async () => {
    apiMock.status.mockRejectedValueOnce(new Error('Status endpoint is down'))
    render(<SystemPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Status endpoint is down')

    apiMock.status.mockResolvedValue(status({ overall: 'degraded' }))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
    expect(apiMock.status).toHaveBeenCalledTimes(2)
  })

  it('still renders when the insight overview is unavailable', async () => {
    apiMock.status.mockResolvedValue(status())
    apiMock.insightsOverview.mockRejectedValue(new Error('no insights'))
    render(<SystemPage />)

    expect(await screen.findByRole('heading', { name: 'System' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
