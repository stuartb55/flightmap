import { useState, type ReactNode } from 'react'
import { RotateCcw, Search, X } from 'lucide-react'
import { categoryOptionLabel } from '../lib/aircraft-category'
import {
  activeFilterCount,
  aircraftFilterErrors,
  defaultAircraftFilters,
  type AircraftFilters as AircraftFilterState,
} from '../lib/aircraft-filter'
import {
  altitudeToFeet,
  convertAltitude,
  convertDistance,
  convertSpeed,
  distanceToNauticalMiles,
  speedToKnots,
  unitLabels,
  useUnitPreferences,
} from '../lib/unit-preferences'

interface Props {
  filters: AircraftFilterState
  sources: string[]
  categories: string[]
  onChange: (filters: AircraftFilterState) => void
  onClose?: () => void
}

/**
 * Filter values are stored in canonical units — they are matched against
 * receiver data and travel in URLs and saved views — so the field converts on
 * the way in and out. The draft keeps what was typed while it still describes
 * the stored value, so "12" does not become "12.00" mid-keystroke, and a reset
 * or a unit change drops straight back to the converted value.
 */
function UnitField({
  label,
  value,
  unit,
  placeholder,
  error,
  step,
  toDisplay,
  toCanonical,
  onChange,
}: {
  label: string
  value: string
  unit: string
  placeholder: string
  error?: string
  step?: string
  toDisplay: (canonical: number) => number
  toCanonical: (display: number) => number
  onChange: (value: string) => void
}) {
  const [draft, setDraft] = useState<{ canonical: string; unit: string; text: string } | null>(null)
  const derived =
    value === '' || !Number.isFinite(Number(value))
      ? value
      : String(Math.round(toDisplay(Number(value)) * 100) / 100)
  const text = draft?.canonical === value && draft.unit === unit ? draft.text : derived

  const handle = (next: string) => {
    const canonical =
      next.trim() === '' || !Number.isFinite(Number(next))
        ? next
        : String(Math.round(toCanonical(Number(next)) * 1_000) / 1_000)
    setDraft({ canonical, unit, text: next })
    onChange(canonical)
  }

  return (
    <label className="field">
      <span>{label}</span>
      <span className="input-suffix">
        <input
          type="number"
          min="0"
          step={step}
          value={text}
          onChange={(event) => handle(event.target.value)}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
        />
        <small>{unit}</small>
      </span>
      {error ? <small className="field-error">{error}</small> : null}
    </label>
  )
}

export function AircraftFilters({ filters, sources, categories, onChange, onClose }: Props) {
  const units = useUnitPreferences()
  const update = <K extends keyof AircraftFilterState>(
    key: K,
    value: AircraftFilterState[K],
  ) => onChange({ ...filters, [key]: value })
  const active = activeFilterCount(filters)
  const errors = aircraftFilterErrors(filters)
  const altitudeField = (
    key: 'minimumAltitude' | 'maximumAltitude',
    label: string,
    placeholder: string,
  ): ReactNode => (
    <UnitField
      label={label}
      value={filters[key]}
      unit={unitLabels.altitude[units.altitude]}
      placeholder={placeholder}
      error={errors[key]}
      toDisplay={(feet) => convertAltitude(feet, units.altitude)}
      toCanonical={(display) => altitudeToFeet(display, units.altitude)}
      onChange={(next) => update(key, next)}
    />
  )

  return (
    <div className="filter-panel">
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">DISPLAY</span>
          <h2>Aircraft filters</h2>
        </div>
        {onClose ? (
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close filters">
            <X size={18} />
          </button>
        ) : null}
      </div>

      <label className="field search-field">
        <span>Identity</span>
        <span className="input-with-icon">
          <Search size={15} />
          <input
            value={filters.query}
            onChange={(event) => update('query', event.target.value)}
            placeholder="Callsign, registration or ICAO"
          />
        </span>
      </label>

      <div className="field-pair">
        <UnitField
          label="Minimum speed"
          value={filters.minimumSpeed}
          unit={unitLabels.speed[units.speed]}
          placeholder="0"
          error={errors.minimumSpeed}
          toDisplay={(knots) => convertSpeed(knots, units.speed)}
          toCanonical={(display) => speedToKnots(display, units.speed)}
          onChange={(next) => update('minimumSpeed', next)}
        />
        <UnitField
          label="Maximum range"
          value={filters.maximumDistance}
          unit={unitLabels.distance[units.distance]}
          placeholder={String(Math.round(convertDistance(100, units.distance)))}
          error={errors.maximumDistance}
          step="any"
          toDisplay={(nauticalMiles) => convertDistance(nauticalMiles, units.distance)}
          toCanonical={(display) => distanceToNauticalMiles(display, units.distance)}
          onChange={(next) => update('maximumDistance', next)}
        />
      </div>

      <div className="field-pair">
        {altitudeField('minimumAltitude', 'Minimum altitude', '0')}
        {altitudeField(
          'maximumAltitude',
          'Maximum altitude',
          String(Math.round(convertAltitude(50_000, units.altitude))),
        )}
      </div>

      <label className="field">
        <span>Aircraft category</span>
        <select value={filters.category} onChange={(event) => update('category', event.target.value)}>
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {categoryOptionLabel(category)}
            </option>
          ))}
        </select>
      </label>

      <div className="field-pair">
        <label className="field">
          <span>Position</span>
          <select
            value={filters.position}
            onChange={(event) =>
              update('position', event.target.value as AircraftFilterState['position'])
            }
          >
            <option value="all">All reports</option>
            <option value="positioned">On map</option>
            <option value="unpositioned">Without position</option>
          </select>
        </label>
        <label className="field">
          <span>Data source</span>
          <select value={filters.source} onChange={(event) => update('source', event.target.value)}>
            <option value="">All sources</option>
            {sources.map((source) => (
              <option key={source} value={source}>
                {source.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>Maximum report age</span>
        <select
          value={filters.maximumFreshness}
          onChange={(event) => update('maximumFreshness', event.target.value)}
        >
          <option value="">Any freshness</option>
          <option value="2">2 seconds</option>
          <option value="5">5 seconds</option>
          <option value="15">15 seconds</option>
          <option value="60">60 seconds</option>
        </select>
      </label>

      <div className="toggle-stack">
        <label className="toggle-row">
          <span>
            <strong>Watchlist only</strong>
            <small>Show tracked aircraft</small>
          </span>
          <input
            type="checkbox"
            checked={filters.watchedOnly}
            onChange={(event) => update('watchedOnly', event.target.checked)}
          />
        </label>
        <label className="toggle-row">
          <span>
            <strong>Active alerts only</strong>
            <small>Emergency and rule matches</small>
          </span>
          <input
            type="checkbox"
            checked={filters.alertsOnly}
            onChange={(event) => update('alertsOnly', event.target.checked)}
          />
        </label>
      </div>

      <button
        className="secondary-button full-width"
        type="button"
        disabled={!active && !filters.query}
        onClick={() => onChange(defaultAircraftFilters)}
      >
        <RotateCcw size={15} />
        Reset {active ? `${active} filter${active === 1 ? '' : 's'}` : 'filters'}
      </button>
    </div>
  )
}
