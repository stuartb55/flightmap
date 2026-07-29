import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../types'

const apiMock = vi.hoisted(() => ({
  settings: vi.fn(),
  updateSettings: vi.fn(),
}))

vi.mock('../lib/api', () => ({ api: apiMock }))

import { SettingsPage } from './SettingsPage'

const defaultSettings: AppSettings = {
  receiverBaseUrl: 'http://receiver.local/data',
  receiverName: 'Home receiver',
  receiverLatitude: null,
  receiverLongitude: null,
  pollIntervalMs: 1_000,
  receiverTimeoutMs: 800,
  receiverInfoIntervalMs: 300_000,
  receiverStatsIntervalMs: 60_000,
  displayTimeZone: 'Europe/London',
  mapStyleUrl: 'https://tiles.openfreemap.org/styles/dark',
  rangeRingsNm: [5, 10, 25, 50, 100],
  historyRetentionDays: 30,
  sessionGapSeconds: 300,
  currentAircraftTtlSeconds: 60,
  firstSeenAlertsEnabled: true,
  firstSeenAlertBaselineHours: 24,
  metadataUrl: 'https://metadata.example/aircraft.csv.gz',
  metadataCheckIntervalMs: 604_800_000,
  metadataTimeoutMs: 30_000,
  metadataMinRows: 100_000,
  metadataMaxDownloadBytes: 50_000_000,
  metadataMaxUncompressedBytes: 250_000_000,
  databaseVolumeCapacityBytes: null,
  collectorEnabled: true,
  maintenanceEnabled: true,
  metadataUpdatesEnabled: true,
}

beforeEach(() => {
  apiMock.settings.mockReset()
  apiMock.updateSettings.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('SettingsPage', () => {
  it('loads, converts, and saves application settings', async () => {
    apiMock.settings.mockResolvedValue({
      settings: defaultSettings,
      updatedAt: null,
    })
    apiMock.updateSettings.mockImplementation(async (settings: AppSettings) => ({
      settings,
      updatedAt: '2026-07-29T15:00:00.000Z',
    }))
    const user = userEvent.setup()

    render(<SettingsPage />)

    const receiverName = await screen.findByRole('textbox', {
      name: 'Receiver name',
    })
    await user.clear(receiverName)
    await user.type(receiverName, 'Roof receiver')
    await user.click(
      screen.getByRole('checkbox', { name: /Collect receiver data/ }),
    )
    const capacity = screen.getByRole('spinbutton', {
      name: /Database volume capacity/,
    })
    await user.type(capacity, '40.25')

    const saveButton = screen.getByRole('button', { name: 'Save settings' })
    const form = saveButton.closest('form')
    expect(form).not.toBeNull()
    const invalidFields = Array.from(form!.elements)
      .filter(
        (element): element is HTMLInputElement =>
          element instanceof HTMLInputElement && !element.checkValidity(),
      )
      .map((element) => element.name)
    expect(invalidFields).toEqual([])
    fireEvent.submit(form!)

    await waitFor(() => expect(apiMock.updateSettings).toHaveBeenCalledOnce())
    expect(apiMock.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverName: 'Roof receiver',
        collectorEnabled: false,
        receiverInfoIntervalMs: 300_000,
        metadataCheckIntervalMs: 604_800_000,
        metadataMaxDownloadBytes: 50_000_000,
        databaseVolumeCapacityBytes: 43_218_108_416,
      }),
    )
    expect(screen.getByText(/Settings saved and applied/)).toBeInTheDocument()
  })

  it('reports load and save failures', async () => {
    apiMock.settings.mockRejectedValueOnce(new Error('Database unavailable'))
    const { unmount } = render(<SettingsPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Database unavailable',
    )
    unmount()

    apiMock.settings.mockResolvedValue({
      settings: defaultSettings,
      updatedAt: null,
    })
    apiMock.updateSettings.mockRejectedValue(new Error('Save failed'))
    render(<SettingsPage />)

    await screen.findByRole('textbox', { name: 'Receiver name' })
    const saveButton = screen.getByRole('button', { name: 'Save settings' })
    const form = saveButton.closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form!)

    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed')
  })
})
