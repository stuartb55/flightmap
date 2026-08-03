import {
  Database,
  HardDrive,
  MapPinned,
  RadioTower,
  Save,
  Server,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { applyRuntimeConfig } from '../config'
import { api } from '../lib/api'
import { formatBytes } from '../lib/format'
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
    rangeRingsNm: String(data.get('rangeRingsNm') ?? '')
      .split(',')
      .map((value) => Number(value.trim())),
    historyRetentionDays: requiredNumber(data, 'historyRetentionDays'),
    sessionGapSeconds: requiredNumber(data, 'sessionGapSeconds'),
    currentAircraftTtlSeconds: requiredNumber(data, 'currentAircraftTtlSeconds'),
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
            <Field label="Map style URL">
              <input name="mapStyleUrl" type="url" defaultValue={settings.mapStyleUrl} required />
            </Field>
            <Field label="Range rings" hint="Nautical miles, comma-separated">
              <input name="rangeRingsNm" defaultValue={settings.rangeRingsNm.join(', ')} required />
            </Field>
            <DisplayUnits />
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
