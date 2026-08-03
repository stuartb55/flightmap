import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { FeatureCollection, Point } from 'geojson'
import type { CoverageCell, MapViewport } from '@flightmap/shared'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { runtimeConfig } from '../config'

maplibregl.setWorkerUrl(maplibreWorkerUrl)

const SOURCE = 'insight-coverage'

export interface CoverageMapHandle {
  getViewport: () => MapViewport | null
  applyViewport: (viewport: MapViewport) => void
}

function coverageData(cells: CoverageCell[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: cells.map((cell, index) => ({
      type: 'Feature',
      id: index,
      properties: {
        reports: cell.reports,
        intensity: Math.max(1, Math.log10(cell.reports + 1)),
        aircraft: cell.uniqueAircraft,
      },
      geometry: { type: 'Point', coordinates: [cell.longitude, cell.latitude] },
    })),
  }
}

function fitCoverage(map: MapLibreMap, cells: CoverageCell[]) {
  if (!cells.length) return
  const bounds = new maplibregl.LngLatBounds()
  for (const cell of cells) bounds.extend([cell.longitude, cell.latitude])
  map.fitBounds(bounds, { padding: 42, maxZoom: 9, duration: 0 })
}

export const CoverageMap = forwardRef<CoverageMapHandle, { cells: CoverageCell[]; onSelectCell?: (cell: CoverageCell) => void }>(function CoverageMap(
  { cells, onSelectCell },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const cellsRef = useRef(cells)
  const onSelectCellRef = useRef(onSelectCell)
  const [mapError, setMapError] = useState(false)

  useImperativeHandle(forwardedRef, () => ({
    getViewport: () => {
      const map = mapRef.current
      if (!map) return null
      const center = map.getCenter()
      return {
        longitude: center.lng,
        latitude: center.lat,
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      }
    },
    applyViewport: (viewport) => {
      mapRef.current?.jumpTo({
        center: [viewport.longitude, viewport.latitude],
        zoom: viewport.zoom,
        bearing: viewport.bearing,
        pitch: viewport.pitch,
      })
    },
  }))
  onSelectCellRef.current = onSelectCell

  useEffect(() => {
    cellsRef.current = cells
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    const source = map.getSource(SOURCE) as GeoJSONSource | undefined
    source?.setData(coverageData(cells))
    fitCoverage(map, cells)
  }, [cells])

  useEffect(() => {
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: runtimeConfig().mapStyleUrl,
      center: [runtimeConfig().receiver.longitude, runtimeConfig().receiver.latitude],
      zoom: 6,
      attributionControl: false,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    map.on('load', () => {
      map.addSource(SOURCE, { type: 'geojson', data: coverageData(cellsRef.current) })
      map.addLayer({
        id: 'insight-coverage-heat',
        type: 'heatmap',
        source: SOURCE,
        maxzoom: 11,
        paint: {
          'heatmap-weight': [
            'interpolate',
            ['linear'],
            ['get', 'intensity'],
            1,
            0.08,
            5,
            1,
          ],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 0.7, 10, 2.1],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 8, 10, 22],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.82, 11, 0.35],
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0,
            'rgba(49,76,95,0)',
            0.18,
            '#285d76',
            0.42,
            '#277e86',
            0.68,
            '#42b99c',
            0.86,
            '#e4ba5f',
            1,
            '#ff6b73',
          ],
        },
      })
      map.addLayer({
        id: 'insight-coverage-cells',
        type: 'circle',
        source: SOURCE,
        minzoom: 9,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'intensity'], 1, 2, 5, 7],
          'circle-color': '#58d5b1',
          'circle-opacity': 0.45,
          'circle-stroke-color': '#dffbf3',
          'circle-stroke-opacity': 0.35,
          'circle-stroke-width': 1,
        },
      })
      map.on('mouseenter', 'insight-coverage-cells', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'insight-coverage-cells', () => { map.getCanvas().style.cursor = '' })
      map.on('click', 'insight-coverage-cells', (event) => {
        const id = event.features?.[0]?.id
        const cell = typeof id === 'number' ? cellsRef.current[id] : undefined
        if (cell) onSelectCellRef.current?.(cell)
      })
      fitCoverage(map, cellsRef.current)
    })
    map.on('error', () => setMapError(true))
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  return (
    <div className="coverage-map-wrap">
      <div
        ref={containerRef}
        className="coverage-map"
        role="region"
        aria-label={`Coverage heatmap containing ${cells.length.toLocaleString('en-GB')} aggregated cells`}
      />
      {mapError ? (
        <p className="coverage-map-error" role="status">
          The basemap could not be loaded. Coverage totals remain available below.
        </p>
      ) : null}
    </div>
  )
})
