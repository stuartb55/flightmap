import { useEffect, useState } from 'react'
import { mapLayerPreferencesSchema, type CoverageCell, type MapLayerPreferences } from '@flightmap/shared'
import { api } from './api'

const STORAGE_KEY = 'flightmap.map-layers.v1'

export const defaultMapLayers: MapLayerPreferences = {
  coverage: false,
  rangeRings: true,
  aircraftLabels: true,
  trails: true,
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
