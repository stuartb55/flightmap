import { useEffect, useRef, useState } from 'react'
import type { MapLayerPreferences } from '@flightmap/shared'
import { Layers3, X } from 'lucide-react'

const options: Array<{ key: keyof MapLayerPreferences; label: string; hint: string }> = [
  { key: 'coverage', label: 'Coverage', hint: 'Last 30 days of aggregated positions' },
  { key: 'rangeRings', label: 'Range rings', hint: 'Receiver-relative nautical miles' },
  { key: 'aircraftLabels', label: 'Aircraft labels', hint: 'Identity and altitude on the map' },
  { key: 'trails', label: 'Trails', hint: 'Live and historical track lines' },
  { key: 'manchesterWaypoints', label: 'Manchester waypoints', hint: 'Arrival and departure fixes' },
]

export function MapLayerMenu({
  layers,
  onChange,
}: {
  layers: MapLayerPreferences
  onChange: (layers: MapLayerPreferences) => void
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="map-layer-control" ref={menuRef}>
      <button
        type="button"
        className="map-layer-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <Layers3 size={17} /> Layers
      </button>
      {open ? (
        <div className="map-layer-menu" role="dialog" aria-label="Map layers">
          <header>
            <div><span className="eyebrow">MAP</span><strong>Visible layers</strong></div>
            <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close map layers"><X size={16} /></button>
          </header>
          <div>
            {options.map((option) => (
              <label key={option.key}>
                <span><strong>{option.label}</strong><small>{option.hint}</small></span>
                <input
                  type="checkbox"
                  checked={layers[option.key]}
                  onChange={(event) => onChange({ ...layers, [option.key]: event.target.checked })}
                />
              </label>
            ))}
          </div>
          <p>Choices are stored in this browser. Named saved views can carry them to another device.</p>
        </div>
      ) : null}
    </div>
  )
}
