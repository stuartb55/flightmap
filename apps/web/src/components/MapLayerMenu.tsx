import { useEffect, useRef, useState } from 'react'
import type { MapDisplayPreferences, MapLayerPreferences } from '@flightmap/shared'
import { Layers3, X } from 'lucide-react'

const options: Array<{ key: keyof MapLayerPreferences; label: string; hint: string }> = [
  { key: 'coverage', label: 'Coverage', hint: 'Last 30 days of aggregated positions' },
  { key: 'rangeRings', label: 'Range rings', hint: 'Distance bands around the receiver' },
  { key: 'aircraftLabels', label: 'Aircraft labels', hint: 'Identity and altitude on the map' },
  { key: 'trails', label: 'Trails', hint: 'Live and historical track lines' },
  { key: 'allTrails', label: 'All trails', hint: 'Recent path of every aircraft on the map' },
  { key: 'airports', label: 'Airports', hint: 'Airfields and runway centrelines near the receiver' },
  { key: 'manchesterWaypoints', label: 'Route waypoints', hint: 'Configured arrival and departure fixes' },
]

export function MapLayerMenu({
  layers,
  onChange,
  display,
  onDisplayChange,
  unavailable,
}: {
  layers: MapLayerPreferences
  onChange: (layers: MapLayerPreferences) => void
  display?: MapDisplayPreferences
  onDisplayChange?: (display: MapDisplayPreferences) => void
  /**
   * Layers this deployment has no data for, with the reason. Disabled with the
   * explanation in place of the hint rather than hidden, so a toggle that is
   * missing reads as "not configured here" rather than as a bug.
   */
  unavailable?: Partial<Record<keyof MapLayerPreferences, string>>
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
        /* Stated rather than read off the label, which the layout drops where
           the button has to share its row with the search field. */
        aria-label="Layers"
        onClick={() => setOpen((current) => !current)}
      >
        {/* The label goes when the control has to share its row with the
            search field; the icon and the accessible name still say what it
            is. */}
        <Layers3 size={17} /> <span className="control-label">Layers</span>
      </button>
      {open ? (
        <div className="map-layer-menu" role="dialog" aria-label="Map layers">
          <header>
            <div><span className="eyebrow">MAP</span><strong>Visible layers</strong></div>
            <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close map layers"><X size={16} /></button>
          </header>
          <div>
            {options.map((option) => {
              const reason = unavailable?.[option.key]
              return (
                <label key={option.key} className={reason ? 'layer-unavailable' : undefined}>
                  <span><strong>{option.label}</strong><small>{reason ?? option.hint}</small></span>
                  <input
                    type="checkbox"
                    checked={layers[option.key]}
                    disabled={reason != null}
                    onChange={(event) => onChange({ ...layers, [option.key]: event.target.checked })}
                  />
                </label>
              )
            })}
          </div>
          {display && onDisplayChange ? (
            <div className="map-display-options">
              <label><span><strong>Trail length</strong><small>Selected live aircraft</small></span><select value={display.trailMinutes} onChange={(event) => onDisplayChange({ ...display, trailMinutes: Number(event.target.value) as MapDisplayPreferences['trailMinutes'] })}><option value={1}>1 minute</option><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option></select></label>
              <label><span><strong>Label density</strong><small>Emergency and selected labels remain visible</small></span><select value={display.labelDensity} onChange={(event) => onDisplayChange({ ...display, labelDensity: event.target.value as MapDisplayPreferences['labelDensity'] })}><option value="auto">Automatic</option><option value="reduced">Reduced</option><option value="full">Full</option></select></label>
            </div>
          ) : null}
          <p>Choices are stored in this browser. Named saved views can carry them to another device.</p>
        </div>
      ) : null}
    </div>
  )
}
