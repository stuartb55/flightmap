import { RotateCcw, Search, X } from 'lucide-react'
import { categoryOptionLabel } from '../lib/aircraft-category'
import {
  activeFilterCount,
  aircraftFilterErrors,
  defaultAircraftFilters,
  type AircraftFilters as AircraftFilterState,
} from '../lib/aircraft-filter'

interface Props {
  filters: AircraftFilterState
  sources: string[]
  categories: string[]
  onChange: (filters: AircraftFilterState) => void
  onClose?: () => void
}

export function AircraftFilters({ filters, sources, categories, onChange, onClose }: Props) {
  const update = <K extends keyof AircraftFilterState>(
    key: K,
    value: AircraftFilterState[K],
  ) => onChange({ ...filters, [key]: value })
  const active = activeFilterCount(filters)
  const errors = aircraftFilterErrors(filters)

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
        <label className="field">
          <span>Minimum speed</span>
          <span className="input-suffix">
            <input
              type="number"
              min="0"
              value={filters.minimumSpeed}
              onChange={(event) => update('minimumSpeed', event.target.value)}
              placeholder="0"
              aria-invalid={Boolean(errors.minimumSpeed)}
            />
            <small>kt</small>
          </span>
          {errors.minimumSpeed ? <small className="field-error">{errors.minimumSpeed}</small> : null}
        </label>
        <label className="field">
          <span>Maximum range</span>
          <span className="input-suffix">
            <input
              type="number"
              min="0"
              step="any"
              value={filters.maximumDistance}
              onChange={(event) => update('maximumDistance', event.target.value)}
              placeholder="100"
              aria-invalid={Boolean(errors.maximumDistance)}
            />
            <small>nm</small>
          </span>
          {errors.maximumDistance ? <small className="field-error">{errors.maximumDistance}</small> : null}
        </label>
      </div>

      <div className="field-pair">
        <label className="field">
          <span>Minimum altitude</span>
          <span className="input-suffix">
            <input
              type="number"
              min="0"
              value={filters.minimumAltitude}
              onChange={(event) => update('minimumAltitude', event.target.value)}
              placeholder="0"
              aria-invalid={Boolean(errors.minimumAltitude)}
            />
            <small>ft</small>
          </span>
          {errors.minimumAltitude ? <small className="field-error">{errors.minimumAltitude}</small> : null}
        </label>
        <label className="field">
          <span>Maximum altitude</span>
          <span className="input-suffix">
            <input
              type="number"
              min="0"
              value={filters.maximumAltitude}
              onChange={(event) => update('maximumAltitude', event.target.value)}
              placeholder="50000"
              aria-invalid={Boolean(errors.maximumAltitude)}
            />
            <small>ft</small>
          </span>
          {errors.maximumAltitude ? <small className="field-error">{errors.maximumAltitude}</small> : null}
        </label>
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
