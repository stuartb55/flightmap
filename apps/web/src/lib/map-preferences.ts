import { useEffect, useState } from 'react'
import { mapDisplayPreferencesSchema, mapLayerPreferencesSchema, type CoverageCell, type MapDisplayPreferences, type MapLayerPreferences } from '@flightmap/shared'
import { api } from './api'

const STORAGE_KEY = 'flightmap.map-layers.v1'
const DISPLAY_STORAGE_KEY = 'flightmap.map-display.v1'

export const defaultMapDisplay: MapDisplayPreferences = { trailMinutes: 15, labelDensity: 'auto' }

export const defaultMapLayers: MapLayerPreferences = {
  coverage: false,
  rangeRings: true,
  aircraftLabels: true,
  trails: true,
  allTrails: false,
  // Off by default because most deployments have no airport data until an
  // operator runs `npm run airports:build`.
  airports: false,
  manchesterWaypoints: true,
}

export function readMapLayers(storage: Pick<Storage, 'getItem'> = localStorage): MapLayerPreferences {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    const result = mapLayerPreferencesSchema.safeParse(parsed)
    return result.success ? result.data : { ...defaultMapLayers }
  } catch {
    return { ...defaultMapLayers }
  }
}

export function useMapLayers() {
  const [layers, setLayers] = useState<MapLayerPreferences>(readMapLayers)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layers))
    } catch {
      // Map preferences are helpful but must never block map use.
    }
  }, [layers])
  return [layers, setLayers] as const
}

export function useMapDisplay() {
  const [display, setDisplay] = useState<MapDisplayPreferences>(() => {
    try {
      const result = mapDisplayPreferencesSchema.safeParse(JSON.parse(localStorage.getItem(DISPLAY_STORAGE_KEY) ?? 'null'))
      return result.success ? result.data : { ...defaultMapDisplay }
    } catch {
      return { ...defaultMapDisplay }
    }
  })
  useEffect(() => {
    try { localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(display)) } catch { /* optional preference */ }
  }, [display])
  return [display, setDisplay] as const
}

export function useCoverageCells(enabled: boolean) {
  const [cells, setCells] = useState<CoverageCell[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) {
      setError(null)
      return
    }
    const controller = new AbortController()
    const to = new Date()
    const from = new Date(to.getTime() - 30 * 86_400_000)
    void api
      .insightsCoverage({ from: from.toISOString(), to: to.toISOString() }, controller.signal)
      .then((response) => {
        setCells(response.cells)
        setError(null)
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Coverage layer unavailable')
        }
      })
    return () => controller.abort()
  }, [enabled])
  return { cells, error }
}
