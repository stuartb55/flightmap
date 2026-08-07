import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../types'
import { appearance, defaultAppearance, setAppearance } from '../lib/theme'

const apiMock = vi.hoisted(() => ({
  settings: vi.fn(),
  status: vi.fn(),
  updateSettings: vi.fn(),
  refreshAirports: vi.fn(),
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
  mapStyleUrlLight: 'https://tiles.openfreemap.org/styles/bright',
  rangeRingsNm: [5, 10, 25, 50, 100],
  mapAirports: [],
  mapAirportsUpdatedAt: null,
  airportDataUrl: 'https://airports.example/airports.csv',
  airportRunwayDataUrl: 'https://airports.example/runways.csv',
  airportRadiusNm: 250,
  airportMinimumRunwayFt: 3_281,
  historyRetentionDays: 30,
  sessionGapSeconds: 300,
  currentAircraftTtlSeconds: 60,
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
  routeLookupEnabled: false,
  routeLookupUrl: 'https://api.example.test/v0/callsign/{callsign}',
  routeLookupTimeoutMs: 4_000,
  routeLookupTtlHours: 336,
  routeLookupNegativeTtlHours: 72,
}

beforeEach(() => {
  apiMock.settings.mockReset()
  apiMock.status.mockReset()
  apiMock.status.mockResolvedValue({
    database: {
      status: 'ok',
      sizeBytes: 6 * 1_073_741_824,
      capacityBytes: null,
      usePercent: null,
      oldestSampleAt: null,
      newestSampleAt: null,
      retainedDays: 30,
    },
  })
  apiMock.updateSettings.mockReset()
})

afterEach(() => {
  cleanup()
  setAppearance(defaultAppearance)
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
    expect(await screen.findByText('6.0 GB')).toBeInTheDocument()
    expect(screen.getByText('Storage used')).toBeInTheDocument()
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

  it('applies theme and density on change, without waiting for the save button', async () => {
    apiMock.settings.mockResolvedValue({ settings: defaultSettings, updatedAt: null })
    const user = userEvent.setup()

    render(<SettingsPage />)

    const theme = await screen.findByRole('combobox', { name: /Theme/ })
    await user.selectOptions(theme, 'light')
    expect(appearance().theme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')

    await user.selectOptions(screen.getByRole('combobox', { name: /Density/ }), 'compact')
    expect(appearance()).toEqual({ theme: 'light', density: 'compact' })
    expect(document.documentElement.dataset.density).toBe('compact')

    // A browser preference must not travel to the server with the form.
    expect(apiMock.updateSettings).not.toHaveBeenCalled()
  })

  it('carries a separate map style for each theme', async () => {
    apiMock.settings.mockResolvedValue({ settings: defaultSettings, updatedAt: null })
    apiMock.updateSettings.mockImplementation(async (settings: AppSettings) => ({
      settings,
      updatedAt: '2026-07-29T15:00:00.000Z',
    }))

    render(<SettingsPage />)

    const light = await screen.findByRole('textbox', { name: /Light map style URL/ })
    expect(light).toHaveValue(defaultSettings.mapStyleUrlLight)
    fireEvent.submit(screen.getByRole('button', { name: 'Save settings' }).closest('form')!)

    await waitFor(() => expect(apiMock.updateSettings).toHaveBeenCalledOnce())
    expect(apiMock.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        mapStyleUrl: defaultSettings.mapStyleUrl,
        mapStyleUrlLight: defaultSettings.mapStyleUrlLight,
      }),
    )
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

/*
 * The airport dataset is built from this page rather than from a command line,
 * so the page has to answer three questions on its own: what is on the map now,
 * what happened when I pressed the button, and what to do when it failed.
 */
describe('the airport dataset card', () => {
  beforeEach(() => {
    apiMock.settings.mockResolvedValue({ settings: defaultSettings, updatedAt: null })
    apiMock.status.mockResolvedValue({ database: { sizeBytes: 1_000, status: 'healthy' } })
  })

  it('says when there is no airport data, and offers to fetch it', async () => {
    render(<SettingsPage />)
    expect(await screen.findByText('No airport data yet')).toBeInTheDocument()
    expect(
      screen.getByText('The map layer stays hidden until this is downloaded.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download now/ })).toBeEnabled()
  })

  const summary = (overrides: Record<string, unknown> = {}) => ({
    airports: 137,
    runways: 175,
    byRank: { large: 23, medium: 74, small: 40 },
    payloadBytes: 41_940,
    gzippedBytes: 9_278,
    centre: { latitude: 53.61, longitude: -2.31 },
    radiusNm: 250,
    minimumRunwayFt: 3_281,
    updatedAt: '2026-08-05T12:00:00.000Z',
    ...overrides,
  })

  it('reports what a download produced, from the summary rather than a re-read', async () => {
    apiMock.refreshAirports.mockResolvedValue(summary())
    render(<SettingsPage />)

    await userEvent.click(await screen.findByRole('button', { name: /Download now/ }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      /Downloaded 137 airports and 175 runways within 250 nm/,
    )
    // What is on the map now comes from the server's report of what it just
    // wrote. Re-reading settings to find out would change `updatedAt`, which is
    // the form's key, and remounting the form would lose any unsaved edits.
    expect(await screen.findByText('137 airports · 175 runways')).toBeInTheDocument()
    expect(screen.getByText(/Last downloaded/)).toBeInTheDocument()
    expect(apiMock.settings).toHaveBeenCalledTimes(1)
  })

  /*
   * The card says a changed radius can be tried without saving first, so it has
   * to be true: the download sends what is in the form, and the form survives.
   */
  it('downloads with what is in the form, not what was last saved', async () => {
    apiMock.refreshAirports.mockResolvedValue(summary({ radiusNm: 40 }))
    render(<SettingsPage />)

    const radius = await screen.findByLabelText(/Radius/)
    await userEvent.clear(radius)
    await userEvent.type(radius, '40')
    await userEvent.click(screen.getByRole('button', { name: /Download now/ }))

    await waitFor(() =>
      expect(apiMock.refreshAirports).toHaveBeenCalledWith(
        expect.objectContaining({
          airportRadiusNm: 40,
          airportMinimumRunwayFt: 3_281,
          airportDataUrl: defaultSettings.airportDataUrl,
          airportRunwayDataUrl: defaultSettings.airportRunwayDataUrl,
        }),
      ),
    )
  })

  it('keeps unsaved edits across a download', async () => {
    apiMock.refreshAirports.mockResolvedValue(summary())
    render(<SettingsPage />)

    const receiverName = await screen.findByLabelText('Receiver name')
    await userEvent.clear(receiverName)
    await userEvent.type(receiverName, 'Shed roof')
    await userEvent.click(screen.getByRole('button', { name: /Download now/ }))
    await screen.findByRole('status')

    // The form is uncontrolled, so a remount would silently reset this to the
    // stored value and the operator's next save would write the old name back.
    expect(screen.getByLabelText('Receiver name')).toHaveValue('Shed roof')
  })

  it('shows what is already configured, and when it was fetched', async () => {
    apiMock.settings.mockResolvedValue({
      settings: {
        ...defaultSettings,
        mapAirports: [
          {
            icao: 'EGCC',
            iata: 'MAN',
            name: 'Manchester Airport',
            latitude: 53.349375,
            longitude: -2.279521,
            elevationFt: 257,
            rank: 3,
            runways: [
              {
                ident: '05L/23R',
                lengthFt: 10_000,
                lowLatitude: 53.3451,
                lowLongitude: -2.29274,
                highLatitude: 53.3624,
                highLongitude: -2.25714,
              },
            ],
          },
        ],
        mapAirportsUpdatedAt: '2026-08-05T12:00:00.000Z',
      },
      updatedAt: null,
    })
    render(<SettingsPage />)

    expect(await screen.findByText('1 airport · 1 runway')).toBeInTheDocument()
    expect(screen.getByText(/Last downloaded/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download again/ })).toBeInTheDocument()
  })

  /*
   * A download can fail for reasons that have nothing to do with this form —
   * no internet, an unknown receiver position, a source that moved — so the
   * reason has to be readable and the rest of the page has to keep working.
   */
  it('surfaces a failure without disturbing the rest of the form', async () => {
    apiMock.refreshAirports.mockRejectedValue(
      new Error('The receiver position is not known yet, so there is no centre to measure from.'),
    )
    render(<SettingsPage />)

    await userEvent.click(await screen.findByRole('button', { name: /Download now/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/receiver position is not known/)
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Download now/ })).toBeEnabled()
  })

  it('saves the radius and runway threshold with the rest of the settings', async () => {
    apiMock.updateSettings.mockResolvedValue({ settings: defaultSettings, updatedAt: null })
    render(<SettingsPage />)

    const radius = await screen.findByLabelText(/Radius/)
    await userEvent.clear(radius)
    await userEvent.type(radius, '120')
    fireEvent.submit(screen.getByRole('button', { name: 'Save settings' }).closest('form')!)

    await waitFor(() =>
      expect(apiMock.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ airportRadiusNm: 120, airportMinimumRunwayFt: 3_281 }),
      ),
    )
  })
})
