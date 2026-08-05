import {
  Database,
  DownloadCloud,
  HardDrive,
  MapPinned,
  Plane,
  RadioTower,
  Save,
  Server,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { applyRuntimeConfig } from '../config'
import { api } from '../lib/api'
import { formatBytes, formatDateTime } from '../lib/format'
import {
  densities,
  densityLabels,
  setAppearance,
  themeChoices,
  themeLabels,
  useAppearance,
  type Density,
  type ThemeChoice,
} from '../lib/theme'
import {
  altitudeUnits,
  distanceUnits,
  presetUnits,
  setUnitPreferences,
  speedUnits,
  unitLabels,
  unitPreset,
  useUnitPreferences,
  verticalRateUnits,
  type UnitPreferences,
} from '../lib/unit-preferences'
import {
  setSightingThreshold,
  sightingThresholdLabels,
  sightingThresholds,
  useSightingThreshold,
  type SightingThreshold,
} from '../lib/sighting-preferences'
import type { AirportImportSummary } from '@flightmap/shared'
import type { AppSettings, AppSettingsResponse, SystemStatus } from '../types'

const MEBIBYTE = 1_048_576
const GIBIBYTE = 1_073_741_824

function requiredNumber(data: FormData, name: string): number {
  return Number(data.get(name))
}

function optionalNumber(data: FormData, name: string): number | null {
  const value = String(data.get(name) ?? '').trim()
  return value === '' ? null : Number(value)
}

function buildSettings(data: FormData): AppSettings {
  const capacityGiB = optionalNumber(data, 'databaseVolumeCapacityGiB')
  return {
    receiverBaseUrl: String(data.get('receiverBaseUrl') ?? ''),
    receiverName: String(data.get('receiverName') ?? ''),
    receiverLatitude: optionalNumber(data, 'receiverLatitude'),
    receiverLongitude: optionalNumber(data, 'receiverLongitude'),
    pollIntervalMs: requiredNumber(data, 'pollIntervalMs'),
    receiverTimeoutMs: requiredNumber(data, 'receiverTimeoutMs'),
    receiverInfoIntervalMs: requiredNumber(data, 'receiverInfoIntervalSeconds') * 1_000,
    receiverStatsIntervalMs: requiredNumber(data, 'receiverStatsIntervalSeconds') * 1_000,
    displayTimeZone: String(data.get('displayTimeZone') ?? ''),
    mapStyleUrl: String(data.get('mapStyleUrl') ?? ''),
    mapStyleUrlLight: String(data.get('mapStyleUrlLight') ?? ''),
    rangeRingsNm: String(data.get('rangeRingsNm') ?? '')
      .split(',')
      .map((value) => Number(value.trim())),
    historyRetentionDays: requiredNumber(data, 'historyRetentionDays'),
    sessionGapSeconds: requiredNumber(data, 'sessionGapSeconds'),
    currentAircraftTtlSeconds: requiredNumber(data, 'currentAircraftTtlSeconds'),
    airportDataUrl: String(data.get('airportDataUrl') ?? ''),
    airportRunwayDataUrl: String(data.get('airportRunwayDataUrl') ?? ''),
    airportRadiusNm: requiredNumber(data, 'airportRadiusNm'),
    airportMinimumRunwayFt: requiredNumber(data, 'airportMinimumRunwayFt'),
    metadataUrl: String(data.get('metadataUrl') ?? ''),
    metadataCheckIntervalMs: Math.round(
      requiredNumber(data, 'metadataCheckIntervalHours') * 3_600_000,
    ),
    metadataTimeoutMs: requiredNumber(data, 'metadataTimeoutSeconds') * 1_000,
    metadataMinRows: requiredNumber(data, 'metadataMinRows'),
    metadataMaxDownloadBytes: Math.round(requiredNumber(data, 'metadataMaxDownloadMiB') * MEBIBYTE),
    metadataMaxUncompressedBytes: Math.round(
      requiredNumber(data, 'metadataMaxUncompressedMiB') * MEBIBYTE,
    ),
    databaseVolumeCapacityBytes:
      capacityGiB === null ? null : Math.round(capacityGiB * GIBIBYTE),
    collectorEnabled: data.get('collectorEnabled') === 'on',
    maintenanceEnabled: data.get('maintenanceEnabled') === 'on',
    metadataUpdatesEnabled: data.get('metadataUpdatesEnabled') === 'on',
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="settings-field">
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </label>
  )
}

/**
 * Units are a browser preference, not a server setting: two people watching the
 * same receiver can want different ones. These controls therefore apply and
 * persist on change rather than waiting for the form's save button, and carry
 * no `name` so they stay out of the submitted settings.
 */
function UnitChoice<K extends keyof UnitPreferences>({
  units,
  field,
  label,
  options,
}: {
  units: UnitPreferences
  field: K
  label: string
  options: readonly UnitPreferences[K][]
}) {
  return (
    <Field label={label}>
      <select
        value={units[field]}
        onChange={(event) =>
          setUnitPreferences({ ...units, [field]: event.target.value } as UnitPreferences)
        }
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {(unitLabels[field] as Record<string, string>)[option]}
          </option>
        ))}
      </select>
    </Field>
  )
}

/**
 * Theme and density travel with the units: a browser preference rather than a
 * server setting, applied on change so the reader can see what they picked.
 */
function DisplayAppearance() {
  const { theme, density } = useAppearance()
  return (
    <div className="settings-field-pair">
      <Field label="Theme" hint="Applies immediately and is stored in this browser">
        <select
          value={theme}
          onChange={(event) =>
            setAppearance({ theme: event.target.value as ThemeChoice, density })
          }
        >
          {themeChoices.map((choice) => (
            <option key={choice} value={choice}>
              {themeLabels[choice]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Density" hint="Compact tightens text and table rows">
        <select
          value={density}
          onChange={(event) => setAppearance({ theme, density: event.target.value as Density })}
        >
          {densities.map((choice) => (
            <option key={choice} value={choice}>
              {densityLabels[choice]}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

function DisplayUnits() {
  const units = useUnitPreferences()
  const preset = unitPreset(units)
  return (
    <>
      <Field label="Unit preset" hint="Applies immediately and is stored in this browser">
        <select
          value={preset}
          onChange={(event) => {
            const chosen = event.target.value
            if (chosen === 'aviation' || chosen === 'metric') {
              setUnitPreferences(presetUnits(chosen))
            }
          }}
        >
          <option value="aviation">Aviation — ft, kt, nm</option>
          <option value="metric">Metric — m, km/h, km</option>
          {preset === 'custom' ? <option value="custom">Custom</option> : null}
        </select>
      </Field>
      <div className="settings-field-grid">
        <UnitChoice units={units} field="altitude" label="Altitude" options={altitudeUnits} />
        <UnitChoice units={units} field="speed" label="Speed" options={speedUnits} />
        <UnitChoice units={units} field="distance" label="Distance" options={distanceUnits} />
        <UnitChoice
          units={units}
          field="verticalRate"
          label="Vertical rate"
          options={verticalRateUnits}
        />
      </div>
      <p className="settings-units-note">
        CSV and GeoJSON exports always use feet, knots and nautical miles, whatever is chosen here.
      </p>
    </>
  )
}

/**
 * Marking is passive by design. A first-seen *alert* existed once and was
 * removed as noise in migration `009_focused_alerts.sql`; this is the marker
 * you go looking for instead, so the copy says plainly that nothing is sent.
 */
function NewSightings() {
  const threshold = useSightingThreshold()
  return (
    <Field
      label="New sightings"
      hint="Marks airframes this receiver heard for the first time within the window"
    >
      <select
        value={threshold}
        onChange={(event) => setSightingThreshold(event.target.value as SightingThreshold)}
      >
        {sightingThresholds.map((choice) => (
          <option key={choice} value={choice}>
            {sightingThresholdLabels[choice]}
          </option>
        ))}
      </select>
    </Field>
  )
}


interface AirportImportState {
  running: boolean
  result: AirportImportSummary | null
  failure: string | null
}

/** "1 airport", "137 airports" — the count is data, so it should read like it. */
function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-GB')} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The airport dataset, built here rather than on a command line.
 *
 * The download is a separate action from saving the form: it can take a few
 * seconds, it can fail for reasons that have nothing to do with the settings,
 * and its result is worth reporting on its own. The source and shape of the
 * dataset are ordinary settings saved with everything else — but pressing
 * Download uses what is in the form, so a changed radius can be tried without
 * saving first.
 */
function AirportData({
  settings,
  state,
  onDownload,
}: {
  settings: AppSettings
  /*
   * Owned by the page rather than by this component. Re-reading the settings
   * after a download changes `updatedAt`, which is the form's key, so the whole
   * form — this card included — is deliberately remounted to pick up the new
   * values. State held here would not survive that; the outcome of the download
   * has to outlive the remount it causes.
   */
  state: AirportImportState
  onDownload: () => void
}) {
  const { running, result, failure } = state
  const airports = settings.mapAirports ?? []
  const configured = airports.length
  const runways = airports.reduce((total, airport) => total + airport.runways.length, 0)

  return (
    <>
      <div className="settings-dataset-state" aria-live="polite">
        <Plane size={20} aria-hidden="true" />
        <span>
          <small>Currently on the map</small>
          <strong>
            {configured ? `${plural(configured, 'airport')} · ${plural(runways, 'runway')}` : 'No airport data yet'}
          </strong>
          <small>
            {settings.mapAirportsUpdatedAt
              ? `Last downloaded ${formatDateTime(settings.mapAirportsUpdatedAt)}`
              : 'The map layer stays hidden until this is downloaded.'}
          </small>
        </span>
        <button
          className="secondary-button"
          type="button"
          onClick={onDownload}
          disabled={running}
        >
          <DownloadCloud size={15} />
          {running ? 'Downloading…' : configured ? 'Download again' : 'Download now'}
        </button>
      </div>
      {result ? (
        <p className="settings-dataset-result" role="status">
          Downloaded {plural(result.airports, 'airport')} and {plural(result.runways, 'runway')}{' '}
          within {result.radiusNm} nm — {formatBytes(result.payloadBytes)}. The map is using them
          now.
        </p>
      ) : null}
      {failure ? (
        <p className="settings-dataset-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="settings-field-grid">
        <Field label="Radius" hint="Nautical miles from the receiver">
          <input
            name="airportRadiusNm"
            type="number"
            min={1}
            max={1_000}
            step="any"
            defaultValue={settings.airportRadiusNm}
            required
          />
        </Field>
        <Field label="Smallest runway to include" hint="Feet; 3281 ft is 1,000 m">
          <input
            name="airportMinimumRunwayFt"
            type="number"
            min={0}
            max={20_000}
            defaultValue={settings.airportMinimumRunwayFt}
            required
          />
        </Field>
      </div>
      <Field label="Airports file" hint="OurAirports airports.csv">
        <input name="airportDataUrl" type="url" defaultValue={settings.airportDataUrl} required />
      </Field>
      <Field label="Runways file" hint="OurAirports runways.csv">
        <input
          name="airportRunwayDataUrl"
          type="url"
          defaultValue={settings.airportRunwayDataUrl}
          required
        />
      </Field>
      <p className="settings-units-note">
        Large and medium airports are always included; a smaller airfield needs a runway at least
        as long as the figure above, which keeps grass strips off the map. Downloading needs
        internet access on the server and is dedicated to the public domain by OurAirports.
      </p>
    </>
  )
}

function SettingsCard({
  icon,
  eyebrow,
  title,
  description,
  children,
}: {
  icon: React.ReactNode
  eyebrow: string
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="settings-card">
      <header>
        <span className="settings-card-icon">{icon}</span>
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  )
}

export function SettingsPage() {
  const [response, setResponse] = useState<AppSettingsResponse | null>(null)
  const [databaseStatus, setDatabaseStatus] = useState<SystemStatus['database'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [storageLoading, setStorageLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [airportImport, setAirportImport] = useState<AirportImportState>({
    running: false,
    result: null,
    failure: null,
  })

  async function downloadAirports() {
    setAirportImport({ running: true, result: null, failure: null })
    try {
      const result = await api.refreshAirports()
      setAirportImport({ running: false, result, failure: null })
      // The server has already applied the new dataset to its own settings, so
      // re-reading them is what keeps this page honest about what is stored.
      setRetryKey((key) => key + 1)
    } catch (reason) {
      setAirportImport({
        running: false,
        result: null,
        failure:
          reason instanceof Error ? reason.message : 'The airport data could not be downloaded',
      })
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void api
      .settings(controller.signal)
      .then((result) => {
        setResponse(result)
        setError(null)
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Settings could not be loaded')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    void api
      .status(controller.signal)
      .then((result) => {
        setDatabaseStatus(result.database)
      })
      .catch(() => {
        // Settings remain usable if the read-only health check is unavailable.
      })
      .finally(() => {
        if (!controller.signal.aborted) setStorageLoading(false)
      })
    return () => controller.abort()
  }, [retryKey])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const result = await api.updateSettings(buildSettings(new FormData(event.currentTarget)))
      setResponse(result)
      // Map style, time zone, range rings and waypoints apply immediately
      // rather than waiting for the next page load.
      applyRuntimeConfig(result.settings)
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Settings could not be saved')
    } finally {
      setSaving(false)
    }
  }

  const settings = response?.settings
  const storageCapacityBytes = settings?.databaseVolumeCapacityBytes ?? null
  const storageUsePercent =
    databaseStatus?.sizeBytes != null && storageCapacityBytes != null
      ? Math.min(100, (databaseStatus.sizeBytes / storageCapacityBytes) * 100)
      : null

  return (
    <div className="standard-page settings-page">
      <header className="standard-page-header settings-header">
        <div className="page-heading">
          <span className="eyebrow">ADMINISTRATION</span>
          <h1>Settings</h1>
          <p>Configure this receiver and its data pipeline without recreating the containers.</p>
        </div>
        {response?.updatedAt ? (
          <small>Last saved {new Date(response.updatedAt).toLocaleString('en-GB')}</small>
        ) : null}
      </header>

      {loading ? (
        <div className="settings-form settings-skeletons" role="status" aria-label="Loading settings">
          {Array.from({ length: 4 }, (_, index) => <div className="settings-card skeleton-card" key={index} />)}
        </div>
      ) : settings ? (
        <form
          className="settings-form"
          key={response.updatedAt ?? 'defaults'}
          onSubmit={(event) => void submit(event)}
        >
          {error ? <div className="settings-message error" role="alert">{error}</div> : null}
          {saved ? (
            <div className="settings-message saved" role="status">
              Settings saved and applied. Reload open browser tabs to apply map and display changes.
            </div>
          ) : null}

          <SettingsCard
            icon={<RadioTower size={20} />}
            eyebrow="SOURCE"
            title="ADS-B receiver"
            description="Where Flightmap collects readsb or dump1090 JSON data."
          >
            <Field label="Receiver name">
              <input name="receiverName" defaultValue={settings.receiverName} required maxLength={100} />
            </Field>
            <Field label="Receiver data URL" hint="Directory containing aircraft.json, receiver.json, and stats.json">
              <input name="receiverBaseUrl" type="url" defaultValue={settings.receiverBaseUrl} required />
            </Field>
            <div className="settings-field-pair">
              <Field label="Latitude" hint="Leave both coordinates empty to discover them from receiver.json">
                <input name="receiverLatitude" type="number" step="any" min={-90} max={90} defaultValue={settings.receiverLatitude ?? ''} />
              </Field>
              <Field label="Longitude">
                <input name="receiverLongitude" type="number" step="any" min={-180} max={180} defaultValue={settings.receiverLongitude ?? ''} />
              </Field>
            </div>
            <details className="settings-advanced">
              <summary>Polling and timeout controls</summary>
              <div className="settings-field-grid">
                <Field label="Aircraft poll interval" hint="Milliseconds">
                  <input name="pollIntervalMs" type="number" min={200} max={60_000} step={100} defaultValue={settings.pollIntervalMs} required />
                </Field>
                <Field label="Request timeout" hint="Milliseconds">
                  <input name="receiverTimeoutMs" type="number" min={100} max={30_000} step={100} defaultValue={settings.receiverTimeoutMs} required />
                </Field>
                <Field label="Receiver info interval" hint="Seconds">
                  <input name="receiverInfoIntervalSeconds" type="number" min={10} max={86_400} defaultValue={settings.receiverInfoIntervalMs / 1_000} required />
                </Field>
                <Field label="Statistics interval" hint="Seconds">
                  <input name="receiverStatsIntervalSeconds" type="number" min={10} max={86_400} defaultValue={settings.receiverStatsIntervalMs / 1_000} required />
                </Field>
              </div>
            </details>
          </SettingsCard>

          <SettingsCard
            icon={<MapPinned size={20} />}
            eyebrow="INTERFACE"
            title="Map and display"
            description="These values are embedded when a browser loads Flightmap."
          >
            <Field label="Display time zone" hint="IANA name, for example Europe/London">
              <input name="displayTimeZone" defaultValue={settings.displayTimeZone} required />
            </Field>
            <Field label="Map style URL" hint="Used while the dark theme is in force">
              <input name="mapStyleUrl" type="url" defaultValue={settings.mapStyleUrl} required />
            </Field>
            <Field label="Light map style URL" hint="Used while the light theme is in force">
              <input
                name="mapStyleUrlLight"
                type="url"
                defaultValue={settings.mapStyleUrlLight}
                required
              />
            </Field>
            <Field label="Range rings" hint="Nautical miles, comma-separated">
              <input name="rangeRingsNm" defaultValue={settings.rangeRingsNm.join(', ')} required />
            </Field>
            <DisplayAppearance />
            <DisplayUnits />
            <NewSightings />
          </SettingsCard>

          <SettingsCard
            icon={<Database size={20} />}
            eyebrow="STORAGE"
            title="Collection and retention"
            description="Control detailed history, live expiry, and session boundaries."
          >
            <div className="settings-storage-usage" aria-live="polite">
              <HardDrive size={20} aria-hidden="true" />
              <span>
                <small>Storage used</small>
                <strong>
                  {storageLoading
                    ? 'Checking…'
                    : databaseStatus?.sizeBytes == null
                      ? 'Unavailable'
                      : formatBytes(databaseStatus.sizeBytes)}
                </strong>
                <small>
                  {storageUsePercent == null || storageCapacityBytes == null
                    ? 'Current PostgreSQL database size'
                    : `${storageUsePercent.toFixed(1)}% of ${formatBytes(storageCapacityBytes)} configured capacity`}
                </small>
              </span>
              {storageUsePercent != null ? (
                <span
                  className="settings-storage-meter"
                  role="progressbar"
                  aria-label="Database storage used"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={storageUsePercent}
                >
                  <span style={{ width: `${storageUsePercent}%` }} />
                </span>
              ) : null}
            </div>
            <div className="settings-toggle-stack">
              <label className="settings-toggle">
                <span>
                  <strong>Collect receiver data</strong>
                  <small>Poll and store live aircraft, receiver information, and statistics.</small>
                </span>
                <input
                  name="collectorEnabled"
                  type="checkbox"
                  defaultChecked={settings.collectorEnabled}
                />
              </label>
              <label className="settings-toggle">
                <span>
                  <strong>Automatic maintenance</strong>
                  <small>Create partitions and enforce detailed-history retention daily.</small>
                </span>
                <input
                  name="maintenanceEnabled"
                  type="checkbox"
                  defaultChecked={settings.maintenanceEnabled}
                />
              </label>
            </div>
            <div className="settings-field-grid">
              <Field label="Detailed history retention" hint="Days">
                <input name="historyRetentionDays" type="number" min={1} max={365} defaultValue={settings.historyRetentionDays} required />
              </Field>
              <Field label="Session gap" hint="Seconds">
                <input name="sessionGapSeconds" type="number" min={60} max={3_600} defaultValue={settings.sessionGapSeconds} required />
              </Field>
              <Field label="Live aircraft expiry" hint="Seconds">
                <input name="currentAircraftTtlSeconds" type="number" min={15} max={3_600} defaultValue={settings.currentAircraftTtlSeconds} required />
              </Field>
              <Field label="Database volume capacity" hint="GiB; optional, used only for health reporting">
                <input
                  name="databaseVolumeCapacityGiB"
                  type="number"
                  min={0.01}
                  step={0.01}
                  defaultValue={
                    settings.databaseVolumeCapacityBytes === null
                      ? ''
                      : settings.databaseVolumeCapacityBytes / GIBIBYTE
                  }
                />
              </Field>
            </div>
          </SettingsCard>

          <SettingsCard
            icon={<Plane size={20} />}
            eyebrow="MAP DATA"
            title="Airports"
            description="Airfields and runway centrelines drawn near the receiver."
          >
            <AirportData
              settings={settings}
              state={airportImport}
              onDownload={() => void downloadAirports()}
            />
          </SettingsCard>

          <SettingsCard
            icon={<Server size={20} />}
            eyebrow="LOOKUP DATA"
            title="Aircraft metadata"
            description="Source and validation limits for registration, type, and operator data."
          >
            <label className="settings-toggle">
              <span>
                <strong>Automatic metadata updates</strong>
                <small>Check the configured source on the schedule below.</small>
              </span>
              <input
                name="metadataUpdatesEnabled"
                type="checkbox"
                defaultChecked={settings.metadataUpdatesEnabled}
              />
            </label>
            <Field label="Metadata URL">
              <input name="metadataUrl" type="url" defaultValue={settings.metadataUrl} required />
            </Field>
            <div className="settings-field-grid">
              <Field label="Update check interval" hint="Hours">
                <input name="metadataCheckIntervalHours" type="number" min={1 / 60} max={720} step="any" defaultValue={settings.metadataCheckIntervalMs / 3_600_000} required />
              </Field>
              <Field label="Request timeout" hint="Seconds">
                <input name="metadataTimeoutSeconds" type="number" min={1} max={300} defaultValue={settings.metadataTimeoutMs / 1_000} required />
              </Field>
              <Field label="Minimum valid rows">
                <input name="metadataMinRows" type="number" min={1} max={10_000_000} defaultValue={settings.metadataMinRows} required />
              </Field>
              <Field label="Maximum download" hint="MiB">
                <input name="metadataMaxDownloadMiB" type="number" min={1_000_000 / MEBIBYTE} max={500_000_000 / MEBIBYTE} step="any" defaultValue={settings.metadataMaxDownloadBytes / MEBIBYTE} required />
              </Field>
              <Field label="Maximum uncompressed data" hint="MiB">
                <input name="metadataMaxUncompressedMiB" type="number" min={5_000_000 / MEBIBYTE} max={1_000_000_000 / MEBIBYTE} step="any" defaultValue={settings.metadataMaxUncompressedBytes / MEBIBYTE} required />
              </Field>
            </div>
          </SettingsCard>

          <div className="settings-save-bar">
            <span>Container and security settings remain in <code>.env</code>.</span>
            <button className="primary-button" type="submit" disabled={saving}>
              <Save size={16} />
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
      ) : (
        <div className="settings-loading error" role="alert">
          <span>{error ?? 'Settings could not be loaded'}</span>
          <button type="button" className="secondary-button small" onClick={() => setRetryKey((key) => key + 1)}>Retry</button>
        </div>
      )}
    </div>
  )
}
