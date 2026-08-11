import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { CoverageCell, MapDisplayPreferences, MapLayerPreferences, MapViewport } from '@flightmap/shared'
import * as maplibregl from 'maplibre-gl'
import type { DataDrivenPropertyValueSpecification, Map as MapLibreMap } from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Camera, Check, ChevronDown, Focus, Info, Link2, LocateFixed, Maximize2, Minus, MoreHorizontal, Plus, Ruler, X } from 'lucide-react'
import { defaultReceiver, useMapStyleUrl, useRuntimeConfig } from '../config'
import { useResolvedTheme } from '../lib/theme'
import { altitudeBands, type AltitudeBand } from '../lib/altitude-bands'
import {
  aircraftShapes,
  shapeLabels,
  shapePoints,
} from '../lib/aircraft-category'
import { aircraftLabel, formatAltitude, formatDistance, formatSpeed } from '../lib/format'
import { unitLabels, useUnitPreferences } from '../lib/unit-preferences'
import type { Airport } from '@flightmap/shared'
import type { Aircraft, Receiver, TrackPoint, TrackResponse } from '../types'
import type { TrailPoint } from '../state/live-reducer'
import { waypointData } from './waypoints'
import { airportData, runwayData } from './airports'
import { isTextEntryTarget } from './KeyboardShortcuts'
import { MapLayerMenu } from './MapLayerMenu'
import { defaultMapDisplay, defaultMapLayers } from '../lib/map-preferences'
import {
  composeSnapshot,
  copyToClipboard,
  downloadBlob,
  mapAttribution,
  snapshotFilename,
  type SnapshotCaption,
} from '../lib/map-snapshot'
import { trackColourModes, type TrackColourMode } from '../lib/track-colour'

maplibregl.setWorkerUrl(maplibreWorkerUrl)

// Stable identity so the default prop never re-triggers a dependent effect.
const emptyTrails: Record<string, TrailPoint[]> = {}

export interface RadarMapHandle {
  fitAircraft: () => void
  centerReceiver: () => void
  getViewport: () => MapViewport | null
  applyViewport: (viewport: MapViewport) => void
  /** The current frame with its caption strip, as a PNG. */
  captureImage: () => Promise<Blob | null>
}

interface Props {
  aircraft?: Aircraft[]
  receiver?: Receiver | null
  selectedIcao?: string | null
  onSelectAircraft?: (icao: string) => void
  /** Clicking empty map space, or pressing Escape over the map. */
  onClearSelection?: () => void
  /** The altitude band the surrounding page is filtered to, if any. */
  altitudeBand?: string | null
  /** Supplied only where an altitude filter exists to write through to. */
  onAltitudeBandChange?: (band: AltitudeBand) => void
  tracks?: TrackResponse[]
  replayTime?: number | null
  followReplay?: boolean
  className?: string
  mapLayers?: MapLayerPreferences
  onMapLayersChange?: (layers: MapLayerPreferences) => void
  mapDisplay?: MapDisplayPreferences
  onMapDisplayChange?: (display: MapDisplayPreferences) => void
  coverageCells?: CoverageCell[]
  /**
   * The airport dataset from `GET /api/v1/airports`, or null while it is in
   * flight. Empty means this deployment has never run `npm run airports:build`,
   * which is a valid state: no source, no layers, no attribution, no error.
   */
  airports?: readonly Airport[] | null
  trails?: Record<string, TrailPoint[]>
  /** What a history track's colour along its length means. Altitude by default. */
  trackColourMode?: TrackColourMode
  /**
   * Pixels along the bottom of the map hidden by an overlay the page draws over
   * it — the mobile detail sheet. The camera aims at the middle of what is left
   * rather than the middle of the canvas, so a selection cannot land behind it.
   */
  bottomInset?: number
  /**
   * Cutoff from the sighting preference; null when the marker is off. Aircraft
   * this receiver first heard at or after it get a halo, unless something more
   * urgent already claims one.
   */
  newSince?: number | null
  /**
   * Applied once, when the map is created — a viewport carried by the URL of a
   * shared link. Later changes are ignored: after that the user owns the view.
   */
  initialViewport?: MapViewport | null
  /**
   * Enables the copy-link and download-image controls. The page supplies what
   * only it knows: how its state is written into a URL, and what the picture
   * should say it is showing.
   */
  share?: {
    surface: string
    /** The page's own link, with the viewport it is asked for folded in. */
    linkFor: (viewport: MapViewport | null) => string
    caption: () => Omit<SnapshotCaption, 'attribution'>
  }
}

import {
  AIRCRAFT_COLOURS,
  AIRCRAFT_SOURCE,
  AIRPORT_SOURCE,
  ALL_TRAILS_SOURCE,
  COVERAGE_SOURCE,
  RECEIVER_SOURCE,
  REPLAY_SOURCE,
  RINGS_SOURCE,
  RULER_SOURCE,
  RUNWAY_SOURCE,
  TRACK_SOURCE,
  WAYPOINT_SOURCE,
  aircraftIconId,
  aircraftImage,
  allTrailsData,
  applyBasemapContrast,
  applyLayerVisibility,
  bandDescription,
  bandLabel,
  coverageData,
  greatCircle,
  hasHoverPointer,
  liveAircraftData,
  mapLabelColours,
  motionDuration,
  needsRecentre,
  receiverData,
  replayData,
  replayPointAtTime,
  resolveStyleImageAlias,
  ringData,
  rulerData,
  scaleUnit,
  setSourceData,
  trackData,
} from './radar-map-data'


export const RadarMap = forwardRef<RadarMapHandle, Props>(function RadarMap(
  {
    aircraft = [],
    receiver,
    selectedIcao,
    onSelectAircraft,
    onClearSelection,
    altitudeBand,
    onAltitudeBandChange,
    tracks = [],
    replayTime,
    followReplay,
    className,
    mapLayers = defaultMapLayers,
    onMapLayersChange,
    mapDisplay = defaultMapDisplay,
    onMapDisplayChange,
    coverageCells = [],
    airports = null,
    trails = emptyTrails,
    trackColourMode = 'altitude',
    bottomInset = 0,
    newSince = null,
    initialViewport = null,
    share,
  },
  forwardedRef,
) {
  const runtime = useRuntimeConfig()
  const mapStyleUrl = useMapStyleUrl()
  // The data ramps have a variant per theme, so a change must recolour them.
  const theme = useResolvedTheme()
  const runtimeRef = useRef(runtime)
  runtimeRef.current = runtime
  const units = useUnitPreferences()
  const unitsRef = useRef(units)
  unitsRef.current = units
  const scaleControlRef = useRef<maplibregl.ScaleControl | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const aircraftRef = useRef(aircraft)
  const receiverRef = useRef(receiver)
  const onSelectRef = useRef(onSelectAircraft)
  const onClearSelectionRef = useRef(onClearSelection)
  const tracksRef = useRef(tracks)
  const trackColourModeRef = useRef(trackColourMode)
  const themeRef = useRef(theme)
  const replayTimeRef = useRef(replayTime)
  const selectedIcaoRef = useRef(selectedIcao)
  const mapLayersRef = useRef(mapLayers)
  const coverageCellsRef = useRef(coverageCells)
  const trailsRef = useRef(trails)
  const lastFollowAtRef = useRef(0)
  const [mapReady, setMapReady] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const [followSelected, setFollowSelected] = useState(false)
  const [hoveredIcao, setHoveredIcao] = useState<string | null>(null)
  const [legendOpen, setLegendOpen] = useState(false)
  const [rulerActive, setRulerActive] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const toolsRef = useRef<HTMLDivElement>(null)
  const [rulerPoints, setRulerPoints] = useState<Array<[number, number]>>([])
  const rulerActiveRef = useRef(rulerActive)
  const hoverPointerRef = useRef(hasHoverPointer())
  const bottomInsetRef = useRef(bottomInset)
  const newSinceRef = useRef(newSince)
  newSinceRef.current = newSince
  const shareRef = useRef(share)
  shareRef.current = share
  const initialViewportRef = useRef(initialViewport)
  /*
   * Where the camera was when the map was last torn down. A style change —
   * which a theme change is — replaces every layer, so the map is rebuilt
   * rather than patched; without this the replacement would be constructed from
   * `initialViewportRef` and the reader would lose wherever they had panned to.
   * Null on the first mount, which is what leaves a shared link in charge.
   */
  const lastViewportRef = useRef<MapViewport | null>(null)
  // Only set when the view was restored from a link: see the recentre effect.
  const restoredSelectionRef = useRef(initialViewport ? selectedIcao ?? null : null)
  const [shareStatus, setShareStatus] = useState<string | null>(null)
  const [shareLink, setShareLink] = useState<string | null>(null)
  const shareLinkRef = useRef<HTMLInputElement>(null)
  const legendBodyId = useId()

  aircraftRef.current = aircraft
  receiverRef.current = receiver
  onSelectRef.current = onSelectAircraft
  onClearSelectionRef.current = onClearSelection
  rulerActiveRef.current = rulerActive
  bottomInsetRef.current = bottomInset
  tracksRef.current = tracks
  trackColourModeRef.current = trackColourMode
  themeRef.current = theme
  replayTimeRef.current = replayTime
  selectedIcaoRef.current = selectedIcao
  mapLayersRef.current = mapLayers
  coverageCellsRef.current = coverageCells
  trailsRef.current = trails

  const fitAircraft = () => {
    const positioned = aircraftRef.current.filter(
      (item) => item.latitude != null && item.longitude != null,
    )
    if (!positioned.length) {
      const currentReceiver = receiverRef.current
      mapRef.current?.easeTo({
        center: [
          currentReceiver?.longitude ?? defaultReceiver().longitude,
          currentReceiver?.latitude ?? defaultReceiver().latitude,
        ],
        offset: [0, -bottomInset / 2],
        zoom: 7.7,
        duration: motionDuration(500),
      })
      return
    }
    const bounds = positioned.reduce(
      (result, item) => result.extend([item.longitude!, item.latitude!]),
      new maplibregl.LngLatBounds(
        [positioned[0]!.longitude!, positioned[0]!.latitude!],
        [positioned[0]!.longitude!, positioned[0]!.latitude!],
      ),
    )
    mapRef.current?.fitBounds(bounds, {
      padding: { top: 70, right: 70, left: 70, bottom: 70 + bottomInset },
      maxZoom: 10,
      duration: motionDuration(700),
    })
  }

  const centerReceiver = () => {
    const currentReceiver = receiverRef.current
    mapRef.current?.easeTo({
      center: [
        currentReceiver?.longitude ?? defaultReceiver().longitude,
        currentReceiver?.latitude ?? defaultReceiver().latitude,
      ],
      offset: [0, -bottomInset / 2],
      zoom: 8.5,
      duration: motionDuration(600),
    })
  }

  const getViewport = (): MapViewport | null => {
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
  }

  const applyViewport = (viewport: MapViewport) => {
    mapRef.current?.jumpTo({
      center: [viewport.longitude, viewport.latitude],
      zoom: viewport.zoom,
      bearing: viewport.bearing,
      pitch: viewport.pitch,
    })
  }

  /*
   * The map is created without `preserveDrawingBuffer`, so its drawing buffer
   * is cleared as soon as the browser has composited a frame and reading it
   * afterwards returns a blank image. Rather than pay for that flag on every
   * frame of every session, a snapshot forces one repaint and copies the pixels
   * out inside the render handler, while the buffer still holds the frame.
   * The copy is synchronous for the same reason: awaiting anything here — even
   * a microtask — can land after the clear.
   */
  const captureMap = (): Promise<HTMLCanvasElement | null> =>
    new Promise((resolve) => {
      const map = mapRef.current
      if (!map) return resolve(null)
      map.once('render', () => {
        const source = map.getCanvas()
        const copy = document.createElement('canvas')
        copy.width = source.width
        copy.height = source.height
        const context = copy.getContext('2d')
        if (!context) return resolve(null)
        context.drawImage(source, 0, 0)
        resolve(copy)
      })
      map.triggerRepaint()
    })

  const captureImage = async (): Promise<Blob | null> => {
    const source = await captureMap()
    if (!source) return null
    const caption = shareRef.current?.caption() ?? { title: 'Flightmap', detail: '' }
    return composeSnapshot(source, {
      ...caption,
      // Read from the control the map itself renders, so the picture cannot
      // credit a provider the tiles did not come from.
      attribution:
        containerRef.current?.querySelector('.maplibregl-ctrl-attrib-inner')?.textContent?.trim() ||
        mapAttribution,
    })
  }

  /*
   * A message that reports an outcome clears itself; one carrying a link to be
   * copied by hand stays until it is dismissed, because it is still needed.
   */
  useEffect(() => {
    if (!shareStatus || shareLink) return
    const timer = window.setTimeout(() => setShareStatus(null), 6_000)
    return () => window.clearTimeout(timer)
  }, [shareStatus, shareLink])

  const copyLink = async () => {
    const link = shareRef.current?.linkFor(getViewport()) ?? window.location.href
    setShareLink(null)
    if (await copyToClipboard(link)) {
      setShareStatus('Link copied. It restores this view.')
      return
    }
    // http:// on a LAN has no clipboard API at all, which is the normal
    // deployment rather than an edge case: show the link to be copied by hand.
    setShareLink(link)
    setShareStatus('Copying is unavailable here. Select the link below to copy it.')
  }

  const downloadImage = async () => {
    setShareLink(null)
    setShareStatus('Preparing image…')
    try {
      const blob = await captureImage()
      if (!blob) {
        setShareStatus('The map image could not be captured.')
        return
      }
      downloadBlob(blob, snapshotFilename(shareRef.current?.surface ?? 'map'))
      setShareStatus('Image saved.')
    } catch (error) {
      setShareStatus(error instanceof Error ? error.message : 'The map image could not be saved.')
    }
  }

  useImperativeHandle(forwardedRef, () => ({
    fitAircraft,
    centerReceiver,
    getViewport,
    applyViewport,
    captureImage
  }))

  useEffect(() => {
    if (!containerRef.current) return
    const labels = mapLabelColours[theme]
    let map: MapLibreMap
    try {
      // A rebuild resumes where the previous map left off; only a first mount
      // falls back to the link's viewport, and only then to the receiver.
      const restored = lastViewportRef.current ?? initialViewportRef.current
      map = new maplibregl.Map({
        container: containerRef.current,
        style: mapStyleUrl,
        // A shared link's viewport is applied at construction rather than after
        // the first render, so the map never shows the receiver's default view
        // and then jumps to the one that was shared.
        center: restored
          ? [restored.longitude, restored.latitude]
          : [
              receiverRef.current?.longitude ?? defaultReceiver().longitude,
              receiverRef.current?.latitude ?? defaultReceiver().latitude,
            ],
        zoom: restored?.zoom ?? 7.7,
        bearing: restored?.bearing ?? 0,
        attributionControl: false,
        pitchWithRotate: false,
        dragRotate: false,
        maxPitch: 0,
      })
    } catch (error) {
      setMapError(error instanceof Error ? error.message : 'Map could not be initialised')
      return
    }
    mapRef.current = map
    map.setMissingStyleImageResolver((id) => resolveStyleImageAlias(map, id))
    // The style credits OpenFreeMap, OpenMapTiles and OpenStreetMap itself, so
    // a custom line repeated all three and doubled the height of the control.
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    const scale = new maplibregl.ScaleControl({ unit: scaleUnit(unitsRef.current.distance) })
    scaleControlRef.current = scale
    map.addControl(scale, 'bottom-left')

    map.on('error', (event) => {
      if (!map.isStyleLoaded()) setMapError(event.error?.message ?? 'Map tiles are unavailable')
    })
    map.on('style.load', () => {
      // Before any of our own layers are added, so a style that happens to name
      // a layer the way this one matches cannot be re-coloured by it.
      applyBasemapContrast(map, theme)

      for (const shape of aircraftShapes) {
        for (const [band, colour] of Object.entries(AIRCRAFT_COLOURS)) {
          const id = aircraftIconId(shape, band)
          if (!map.hasImage(id)) map.addImage(id, aircraftImage(shape, colour), { pixelRatio: 2 })
        }
      }

      map.addSource(COVERAGE_SOURCE, {
        type: 'geojson',
        data: coverageData(coverageCellsRef.current),
      })
      map.addLayer({
        id: 'map-coverage-heat',
        type: 'heatmap',
        source: COVERAGE_SOURCE,
        maxzoom: 11,
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'intensity'], 1, 0.08, 5, 1],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 10, 1.8],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 7, 10, 20],
          'heatmap-opacity': 0.7,
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(39,72,90,0)', 0.25, '#28697b', 0.55, '#39a594', 0.8, '#e1b85f', 1, '#ff6670',
          ],
        },
      })

      map.addSource(RINGS_SOURCE, {
        type: 'geojson',
        data: ringData(receiverRef.current, runtimeRef.current.rangeRingsNm, unitsRef.current)
      })
      map.addLayer({
        id: 'range-ring-fill',
        type: 'fill',
        source: RINGS_SOURCE,
        paint: { 'fill-color': '#36c9a3', 'fill-opacity': 0.008 },
      })
      map.addLayer({
        id: 'range-ring-line',
        type: 'line',
        source: RINGS_SOURCE,
        paint: {
          'line-color': '#67cfb1',
          'line-opacity': 0.22,
          'line-width': 1,
          'line-dasharray': [3, 4],
        },
      })

      map.addSource(WAYPOINT_SOURCE, {
        type: 'geojson',
        data: waypointData(runtimeRef.current.mapWaypoints),
      })
      map.addLayer({
        id: 'route-waypoint-markers',
        type: 'circle',
        source: WAYPOINT_SOURCE,
        minzoom: 6,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.2, 10, 4.5],
          'circle-color': [
            'match',
            ['get', 'kind'],
            'arrival',
            '#f2b85e',
            '#58d5b1',
          ],
          'circle-opacity': 0.16,
          'circle-stroke-color': [
            'match',
            ['get', 'kind'],
            'arrival',
            '#ffd287',
            '#7ce8c9',
          ],
          'circle-stroke-opacity': 0.9,
          'circle-stroke-width': 1.4,
        },
      })
      map.addLayer({
        id: 'route-waypoint-labels',
        type: 'symbol',
        source: WAYPOINT_SOURCE,
        minzoom: 6.4,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-letter-spacing': 0.08,
          'text-offset': [0.65, 0.55],
          'text-anchor': 'top-left',
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': [
            'match',
            ['get', 'kind'],
            'arrival',
            labels.arrival,
            labels.departure,
          ],
          'text-halo-color': labels.halo,
          'text-halo-width': 1.2,
          'text-opacity': 0.88,
        },
      })

      /*
       * `tolerance: 0` on both trail sources. The default drops any line whose
       * whole length falls under a tile's simplification tolerance rather than
       * coarsening it, and a trail is a few minutes of flight that can
       * legitimately be short — a holding aircraft leaves one metres long.
       *
       * On the history source it does something else, now that `trackData`
       * emits runs that are too long to be dropped: it keeps the shape of the
       * line at low zoom, where the default would thin a 69 nm track to about
       * four points. That is simplification working as intended, so this is a
       * deliberate trade of tile size for fidelity, and it is bounded — the
       * server caps a track at 20,000 samples.
       */
      map.addSource(ALL_TRAILS_SOURCE, {
        type: 'geojson',
        tolerance: 0,
        data: allTrailsData(trailsRef.current, themeRef.current),
      })
      map.addLayer({
        id: 'all-aircraft-trails',
        type: 'line',
        source: ALL_TRAILS_SOURCE,
        minzoom: 6,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'colour'],
          'line-width': 1.4,
          'line-opacity': 0.42,
        },
      })

      map.addSource(TRACK_SOURCE, {
        type: 'geojson',
        tolerance: 0,
        data: trackData(tracksRef.current, trackColourModeRef.current, themeRef.current),
      })
      map.addLayer({
        id: 'history-track-shadow',
        type: 'line',
        source: TRACK_SOURCE,
        paint: { 'line-color': labels.trackCasing, 'line-width': 5, 'line-opacity': 0.5 },
      })
      map.addLayer({
        id: 'history-track',
        type: 'line',
        source: TRACK_SOURCE,
        paint: {
          'line-color': ['get', 'colour'],
          'line-width': 2.4,
          'line-opacity': 0.9,
        },
      })

      map.addSource(RECEIVER_SOURCE, { type: 'geojson', data: receiverData(receiverRef.current) })
      map.addLayer({
        id: 'receiver-pulse',
        type: 'circle',
        source: RECEIVER_SOURCE,
        paint: {
          'circle-radius': 13,
          'circle-color': '#5ce0ba',
          'circle-opacity': 0.12,
          'circle-stroke-color': '#5ce0ba',
          'circle-stroke-opacity': 0.38,
          'circle-stroke-width': 1,
        },
      })
      map.addLayer({
        id: 'receiver-dot',
        type: 'circle',
        source: RECEIVER_SOURCE,
        paint: {
          'circle-radius': 4,
          'circle-color': '#d9fff4',
          'circle-stroke-color': '#2bb58d',
          'circle-stroke-width': 2,
        },
      })

      map.addSource(AIRCRAFT_SOURCE, {
        type: 'geojson',
        data: liveAircraftData(
          aircraftRef.current,
          unitsRef.current,
          selectedIcaoRef.current,
          newSinceRef.current,
        ),
      })
      // Below the watched halo: lowest precedence of the four emphases, and the
      // feature property above guarantees only one of them ever matches.
      map.addLayer({
        id: 'aircraft-new-halo',
        type: 'circle',
        source: AIRCRAFT_SOURCE,
        filter: ['==', ['get', 'newSighting'], 1],
        paint: {
          'circle-radius': 17,
          'circle-color': '#8f7ff0',
          'circle-opacity': 0.08,
          'circle-stroke-color': '#8f7ff0',
          'circle-stroke-opacity': 0.72,
          'circle-stroke-width': 1.5,
        },
      })
      map.addLayer({
        id: 'aircraft-watched-halo',
        type: 'circle',
        source: AIRCRAFT_SOURCE,
        filter: ['==', ['get', 'watched'], 1],
        paint: {
          'circle-radius': 19,
          'circle-color': '#f2b85e',
          'circle-opacity': 0.08,
          'circle-stroke-color': '#f2b85e',
          'circle-stroke-opacity': 0.78,
          'circle-stroke-width': 1.5,
        },
      })
      map.addLayer({
        id: 'aircraft-emergency-halo',
        type: 'circle',
        source: AIRCRAFT_SOURCE,
        filter: ['==', ['get', 'emergency'], 1],
        paint: {
          'circle-radius': 23,
          'circle-color': '#ff4d5f',
          'circle-opacity': 0.16,
          'circle-stroke-color': '#ff5e6e',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'aircraft-selected-halo',
        type: 'circle',
        source: AIRCRAFT_SOURCE,
        filter: ['==', ['get', 'selected'], 1],
        paint: {
          'circle-radius': 24,
          'circle-color': '#f5fcff',
          'circle-opacity': 0.12,
          'circle-stroke-color': '#eafcff',
          'circle-stroke-width': 2.5,
        },
      })
      map.addLayer({
        id: 'aircraft-icons',
        type: 'symbol',
        source: AIRCRAFT_SOURCE,
        layout: {
          'icon-image': ['get', 'icon'],
          /* A wider gap than the ring alone gave. The ring says which one is
             selected once you have found it; the size is what finds it. */
          'icon-size': ['case', ['==', ['get', 'selected'], 1], 1.9, 1.35],
          'icon-rotate': ['get', 'rotation'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': ['get', 'opacity'] },
      })
      map.addLayer({
        id: 'aircraft-labels',
        type: 'symbol',
        source: AIRCRAFT_SOURCE,
        minzoom: 7.2,
        layout: {
          /*
           * The altitude doubles the width of a label, and at the zoom where
           * the whole receiver range is on screen it is the callsign that is
           * being scanned for. It joins once there is room for it, which is
           * also the point where the labels stop being the widest thing on
           * the map.
           */
          'text-field': [
            'step',
            ['zoom'],
            ['get', 'label'],
            9,
            ['concat', ['get', 'label'], '  ', ['get', 'secondary']],
          ],
          'text-font': ['Noto Sans Regular'],
          'text-size': 13,
          /*
           * A fixed anchor below the aircraft put the label over its own trail
           * — the trail leaves from behind, so on anything heading north the
           * two were always on top of each other — and clipped it against the
           * viewport edge. Four candidates let the placement move to whichever
           * side is free instead.
           */
          'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
          'text-radial-offset': 1.25,
          'text-justify': 'auto',
          'text-padding': 4,
          'text-allow-overlap': false,
          'text-optional': true,
          /*
           * Collision drops whichever label it reaches second, which without an
           * order of its own is whichever happens to sort later. The aircraft
           * someone has picked out, or that is shouting, keeps its label and
           * the anonymous traffic around it gives one up.
           */
          'symbol-sort-key': [
            'case',
            ['==', ['get', 'selected'], 1],
            0,
            ['==', ['get', 'emergency'], 1],
            1,
            ['==', ['get', 'watched'], 1],
            2,
            3,
          ],
        },
        paint: {
          'text-color': labels.aircraft,
          'text-halo-color': labels.halo,
          'text-halo-width': 1.2,
          'text-opacity': ['get', 'opacity'],
        },
      })

      map.addSource(REPLAY_SOURCE, {
        type: 'geojson',
        data: replayData(tracksRef.current, replayTimeRef.current),
      })
      map.addLayer({
        id: 'replay-aircraft',
        type: 'symbol',
        source: REPLAY_SOURCE,
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': 1.25,
          'icon-rotate': ['get', 'rotation'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
        },
      })
      map.addLayer({
        id: 'replay-label',
        type: 'symbol',
        source: REPLAY_SOURCE,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 14,
          'text-offset': [0, 2.2],
          'text-anchor': 'top',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': labels.replay,
          'text-halo-color': labels.halo,
          'text-halo-width': 1.5,
        },
      })

      map.addSource(RULER_SOURCE, { type: 'geojson', data: rulerData([]) })
      map.addLayer({
        id: 'map-ruler-line',
        type: 'line',
        source: RULER_SOURCE,
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': '#f2e9a0',
          'line-width': 1.6,
          'line-dasharray': [2.5, 1.6],
        },
      })
      map.addLayer({
        id: 'map-ruler-points',
        type: 'circle',
        source: RULER_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 4.5,
          'circle-color': '#111a1f',
          'circle-stroke-color': '#f2e9a0',
          'circle-stroke-width': 1.6,
        },
      })

      const selectAircraft = (event: maplibregl.MapMouseEvent) => {
        // While measuring, a click is a ruler point and nothing else.
        if (rulerActiveRef.current) return
        const feature = map.queryRenderedFeatures(event.point, { layers: ['aircraft-icons'] })[0]
        const icao = feature?.properties?.icao
        if (typeof icao === 'string') onSelectRef.current?.(icao)
      }
      map.on('click', 'aircraft-icons', selectAircraft)
      map.on('click', (event) => {
        if (rulerActiveRef.current) {
          const point: [number, number] = [event.lngLat.lng, event.lngLat.lat]
          // A third click starts a fresh measurement rather than extending one.
          setRulerPoints((current) => (current.length >= 2 ? [point] : [...current, point]))
          return
        }
        // Clicking the map itself, rather than an aircraft on it, is the
        // ordinary way to say "never mind".
        if (!map.queryRenderedFeatures(event.point, { layers: ['aircraft-icons'] }).length) {
          onClearSelectionRef.current?.()
        }
      })
      map.on('mouseenter', 'aircraft-icons', () => {
        if (!rulerActiveRef.current) map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mousemove', 'aircraft-icons', (event) => {
        // A touch device synthesises one mousemove from a tap and then never a
        // mouseleave, so the card stuck over the layer buttons until the next
        // tap landed on another aircraft. Hover is a mouse affordance only.
        if (rulerActiveRef.current || !hoverPointerRef.current) return
        const icao = event.features?.[0]?.properties?.icao
        setHoveredIcao(typeof icao === 'string' ? icao : null)
      })
      map.on('mouseleave', 'aircraft-icons', () => {
        if (!rulerActiveRef.current) map.getCanvas().style.cursor = ''
        setHoveredIcao(null)
      })
      applyLayerVisibility(map, mapLayersRef.current)
      setMapError(null)
      setMapReady(true)
    })

    return () => {
      // Read before `remove`, which leaves the map unable to report its camera.
      lastViewportRef.current = getViewport() ?? lastViewportRef.current
      map.remove()
      mapRef.current = null
      setMapReady(false)
    }
    // A style change replaces every layer, so the map is rebuilt rather than
    // patched; every other runtime setting is applied by the effects below.
    // Switching theme changes the style and these colours, so it rebuilds
    // through the same path.
  }, [mapStyleUrl, theme])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(
      mapRef.current,
      AIRCRAFT_SOURCE,
      liveAircraftData(aircraft, units, selectedIcao, newSince),
    )
  }, [aircraft, selectedIcao, units, newSince, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, RECEIVER_SOURCE, receiverData(receiver))
    setSourceData(mapRef.current, RINGS_SOURCE, ringData(receiver, runtime.rangeRingsNm, units))
  }, [receiver, runtime.rangeRingsNm, units, mapReady])

  useEffect(() => {
    if (!mapReady) return
    scaleControlRef.current?.setUnit(scaleUnit(units.distance))
  }, [units.distance, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, WAYPOINT_SOURCE, waypointData(runtime.mapWaypoints))
  }, [runtime.mapWaypoints, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, TRACK_SOURCE, trackData(tracks, trackColourMode, theme))
  }, [tracks, trackColourMode, theme, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, COVERAGE_SOURCE, coverageData(coverageCells))
  }, [coverageCells, mapReady])

  // Rebuilding a thousand line features every second is wasted work for a trail
  // that only grows a point every four, so this runs on its own slower timer
  // and stops entirely while the layer is switched off.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !mapLayers.allTrails) return
    const publish = () => {
      if (mapRef.current) {
        setSourceData(mapRef.current, ALL_TRAILS_SOURCE, allTrailsData(trailsRef.current, themeRef.current))
      }
    }
    publish()
    const timer = window.setInterval(publish, 2_000)
    return () => window.clearInterval(timer)
  }, [mapLayers.allTrails, mapReady])

  /*
   * The airport layers are built here rather than with everything else at
   * style load, because the dataset arrives over its own endpoint and may land
   * after the map is ready. Building them only once there is something to draw
   * is also what keeps the promise that a deployment with no airport data gets
   * no layer and no credit: the OurAirports attribution is declared on the
   * source, so it reaches the attribution control — and through it the exported
   * snapshot, which reads that control — only when the source exists.
   *
   * A theme change rebuilds the map, so this runs again against the new style;
   * `getSource` is what makes the second run on an unchanged style a no-op.
   */
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    if (map.getSource(AIRPORT_SOURCE)) {
      /*
       * The layers exist, so this is a dataset that has changed under them — an
       * operator rebuilding it on the Settings page. Re-supplying the source is
       * all that is needed; the layers and their paint are unchanged.
       *
       * A dataset that has become empty takes its layers with it rather than
       * being drawn as nothing, because the OurAirports credit is declared on
       * the source and would otherwise outlive the data it credits.
       */
      if (airports?.length) {
        setSourceData(map, RUNWAY_SOURCE, runwayData(airports))
        setSourceData(map, AIRPORT_SOURCE, airportData(airports))
        return
      }
      for (const id of ['airport-labels', 'airport-markers', 'airport-runways']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [AIRPORT_SOURCE, RUNWAY_SOURCE]) {
        if (map.getSource(id)) map.removeSource(id)
      }
      return
    }
    if (!airports?.length) return
    const labels = mapLabelColours[theme]
    // Below the traffic, so an aircraft is never hidden behind ground context.
    const beforeId = ['range-ring-fill', 'route-waypoint-markers', 'aircraft-new-halo'].find(
      (id) => map.getLayer(id),
    )
    map.addSource(RUNWAY_SOURCE, {
      type: 'geojson',
      data: runwayData(airports),
    })
    map.addSource(AIRPORT_SOURCE, {
      type: 'geojson',
      data: airportData(airports),
      attribution:
        '<a href="https://ourairports.com/data/" target="_blank" rel="noreferrer">OurAirports</a>',
    })
    map.addLayer(
      {
        id: 'airport-runways',
        type: 'line',
        source: RUNWAY_SOURCE,
        // A centreline is meaningless as a hairline; below this the airport is
        // a symbol and nothing else.
        minzoom: 11,
        paint: {
          'line-color': labels.runway,
          'line-opacity': 0.75,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 15, 4],
        },
      },
      beforeId,
    )
    map.addLayer(
      {
        id: 'airport-markers',
        type: 'circle',
        source: AIRPORT_SOURCE,
        minzoom: 7,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.4, 12, 5],
          'circle-color': labels.airport,
          'circle-opacity': 0.22,
          'circle-stroke-color': labels.airport,
          'circle-stroke-opacity': 0.85,
          'circle-stroke-width': 1.2,
        },
      },
      beforeId,
    )
    map.addLayer(
      {
        id: 'airport-labels',
        type: 'symbol',
        source: AIRPORT_SOURCE,
        minzoom: 7.5,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 7.5, 10, 12, 12],
          'text-offset': [0.6, 0.5],
          'text-anchor': 'top-left',
          // Declutter: a label that would overlap one already placed is
          // dropped rather than drawn on top of it.
          'text-allow-overlap': false,
          'text-optional': true,
          // Lower sort key is placed first and so survives a collision. The key
          // is 3 - rank, so the major airport beats the nearby airfield rather
          // than whichever happened to come first in the source.
          'symbol-sort-key': ['get', 'sortKey'],
        },
        paint: {
          'text-color': labels.airport,
          'text-halo-color': labels.halo,
          'text-halo-width': 1.2,
        },
      },
      beforeId,
    )
    applyLayerVisibility(map, mapLayersRef.current)
  }, [airports, mapReady, theme])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    applyLayerVisibility(mapRef.current, mapLayers)
  }, [mapLayers, mapReady])

  /* Matches the layer menu on the opposite corner: a press outside closes it,
     and Escape does too, because it covers part of the map while it is open. */
  useEffect(() => {
    if (!toolsOpen) return
    const closeOnPress = (event: MouseEvent) => {
      if (!toolsRef.current?.contains(event.target as Node)) setToolsOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setToolsOpen(false)
    }
    document.addEventListener('mousedown', closeOnPress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnPress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [toolsOpen])

  /*
   * With something selected, the rest of the traffic steps back — but it stays
   * traffic. The selected aircraft is already found by size and by its ring, so
   * the neighbours only have to be quieter than it, not gone: the map's job is
   * still to show where everything else is while you read one of them.
   *
   * The step back is therefore floored. Aircraft carry an opacity of their own
   * that falls to 0.25 as their position goes stale, and multiplying that by a
   * flat factor drove the stale ones down to a tenth of full, which reads as
   * having disappeared rather than as receded. The floor holds every target at
   * a visible level, and the min() keeps it from ever brightening one past the
   * opacity its own staleness earned it.
   */
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map?.getLayer('aircraft-icons')) return
    const staleness: DataDrivenPropertyValueSpecification<number> = ['get', 'opacity']
    const stepBack = (
      factor: number,
      floor: number,
    ): DataDrivenPropertyValueSpecification<number> => [
      'case',
      ['==', ['get', 'selected'], 1],
      ['get', 'opacity'],
      ['min', ['get', 'opacity'], ['max', ['*', ['get', 'opacity'], factor], floor]],
    ]

    map.setPaintProperty(
      'aircraft-icons',
      'icon-opacity',
      selectedIcao ? stepBack(0.65, 0.45) : staleness,
    )
    if (map.getLayer('aircraft-labels')) {
      map.setPaintProperty(
        'aircraft-labels',
        'text-opacity',
        selectedIcao ? stepBack(0.6, 0.4) : staleness,
      )
    }
    // The selected aircraft's own track is drawn by its own layer, brightly, so
    // the shared trails only ever compete with it.
    if (map.getLayer('all-aircraft-trails')) {
      map.setPaintProperty('all-aircraft-trails', 'line-opacity', selectedIcao ? 0.28 : 0.42)
    }
  }, [selectedIcao, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map?.getLayer('aircraft-labels')) return
    map.setLayerZoomRange('aircraft-labels', mapDisplay.labelDensity === 'full' ? 0 : mapDisplay.labelDensity === 'reduced' ? 8.5 : 7.2, 24)
    map.setLayoutProperty('aircraft-labels', 'text-allow-overlap', mapDisplay.labelDensity === 'full')
    map.setFilter('aircraft-labels', mapDisplay.labelDensity === 'reduced'
      ? ['any', ['==', ['get', 'selected'], 1], ['==', ['get', 'emergency'], 1], ['==', ['get', 'watched'], 1]]
      : null)
  }, [mapDisplay.labelDensity, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, REPLAY_SOURCE, replayData(tracks, replayTime))
  }, [tracks, replayTime, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !selectedIcao) return
    /*
     * A shared link carries both a viewport and the aircraft that was selected
     * in it. The viewport is what the sender framed, so the selection arriving
     * with it must not pull the camera off it — only selections made afterwards
     * recentre.
     */
    if (restoredSelectionRef.current === selectedIcao) {
      restoredSelectionRef.current = null
      return
    }
    const selected = aircraftRef.current.find((item) => item.icao === selectedIcao)
    if (selected?.longitude == null || selected.latitude == null) return
    // Recentring on an aircraft that is already comfortably on screen throws
    // the whole view about for no gain, which made picking through the table
    // feel violent. Only move the camera when the aircraft is off screen or
    // crowding an edge — where the edge is the overlay's, not the canvas's, so
    // an aircraft behind the mobile detail sheet counts as off screen.
    const canvas = map.getCanvas()
    const visibleHeight = Math.max(0, canvas.clientHeight - bottomInset)
    if (
      !needsRecentre(
        map.project([selected.longitude, selected.latitude]),
        canvas.clientWidth,
        visibleHeight,
      )
    ) {
      return
    }
    map.easeTo({
      center: [selected.longitude, selected.latitude],
      // Lifts the target into the middle of the uncovered band.
      offset: [0, -bottomInset / 2],
      zoom: Math.max(map.getZoom(), 9),
      duration: motionDuration(450),
    })
  }, [bottomInset, selectedIcao, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, RULER_SOURCE, rulerData(rulerPoints))
  }, [rulerPoints, mapReady])

  // The ruler owns the pointer while it is armed: a crosshair, and no hover
  // card competing with the measurement readout for the same corner.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    map.getCanvas().style.cursor = rulerActive ? 'crosshair' : ''
    if (rulerActive) setHoveredIcao(null)
  }, [rulerActive, mapReady])

  // A tablet that gains or loses a mouse changes this mid-session, and a card
  // left behind by the old pointer would have nothing to dismiss it.
  useEffect(() => {
    const query = window.matchMedia?.('(hover: hover) and (pointer: fine)')
    if (!query) return
    const update = () => {
      hoverPointerRef.current = query.matches
      if (!query.matches) setHoveredIcao(null)
    }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  const rulerMeasurement =
    rulerPoints.length === 2 ? greatCircle(rulerPoints[0]!, rulerPoints[1]!) : null

  // One Escape handler for the map's own affordances, so their precedence is
  // written down: a measurement unwinds before the selection clears. Anything
  // with its own overlay semantics — a dialog, a text field — keeps its Escape.
  useEffect(() => {
    const canClearSelection = Boolean(selectedIcao) && Boolean(onClearSelection)
    if (!rulerActive && !canClearSelection) return
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (isTextEntryTarget(target) || target?.closest('[role="dialog"]')) return
      if (rulerActive) {
        if (rulerPoints.length) setRulerPoints([])
        else setRulerActive(false)
        return
      }
      onClearSelectionRef.current?.()
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [onClearSelection, selectedIcao, rulerActive, rulerPoints.length])

  useEffect(() => {
    if (!selectedIcao) setFollowSelected(false)
  }, [selectedIcao])

  useEffect(() => {
    if (!followSelected || !selectedIcao || !mapRef.current) return
    const selected = aircraft.find((item) => item.icao === selectedIcao)
    if (selected?.longitude != null && selected.latitude != null) {
      mapRef.current.easeTo({
        center: [selected.longitude, selected.latitude],
        offset: [0, -bottomInsetRef.current / 2],
        duration: motionDuration(250),
      })
    }
  }, [aircraft, followSelected, selectedIcao])

  useEffect(() => {
    if (!followReplay || replayTime == null || !mapRef.current || !tracks.length) return
    const positions = tracks
      .map((track) => replayPointAtTime(track.points, replayTime))
      .filter((point): point is TrackPoint => point != null)
    if (!positions.length) return
    const longitude = positions.reduce((total, point) => total + point.longitude, 0) / positions.length
    const latitude = positions.reduce((total, point) => total + point.latitude, 0) / positions.length
    const now = performance.now()
    if (now - lastFollowAtRef.current < 100) return
    lastFollowAtRef.current = now
    mapRef.current.jumpTo({ center: [longitude, latitude] })
  }, [followReplay, replayTime, tracks])

  return (
    <div className={`radar-map ${className ?? ''}`}>
      <div
        ref={containerRef}
        className="radar-map-canvas"
        role="region"
        aria-label="Interactive aircraft radar map with configured arrival and departure fixes. Use the adjacent controls to zoom and centre the view."
      />
      {/*
        Eight unlabelled icons held a permanent block down the side of the map,
        over the traffic, and half of them were unguessable from the glyph
        alone. What is left here is the four that move the camera — the ones
        worth a permanent place and the ones an icon can carry. The rest keep
        their names, one press away.
      */}
      <div className="map-tools" ref={toolsRef}>
        <div className="map-controls" aria-label="Map controls">
          <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
            <Plus size={20} />
          </button>
          <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
            <Minus size={20} />
          </button>
          <button type="button" title="Centre receiver" aria-label="Centre receiver" onClick={centerReceiver}>
            <LocateFixed size={20} />
          </button>
          <button type="button" title="Fit active aircraft" aria-label="Fit active aircraft" onClick={fitAircraft}>
            <Maximize2 size={20} />
          </button>
          {selectedIcao ? <button type="button" className={followSelected ? 'active' : ''} title="Follow selected aircraft" aria-label="Follow selected aircraft" aria-pressed={followSelected} onClick={() => setFollowSelected((value) => !value)}><Focus size={20} /></button> : null}
          <button
            type="button"
            className={`map-tools-more ${toolsOpen || rulerActive ? 'active' : ''}`}
            aria-expanded={toolsOpen}
            aria-haspopup="dialog"
            title="More map tools"
            aria-label="More map tools"
            onClick={() => setToolsOpen((value) => !value)}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
        {toolsOpen ? (
          <div className="map-tools-menu" role="dialog" aria-label="More map tools">
            {/* The map's click handlers are registered once its style has
                loaded, so arming the ruler before then gives a tool that
                silently drops the first point the user places. */}
            <button
              type="button"
              className={rulerActive ? 'active' : ''}
              aria-pressed={rulerActive}
              disabled={!mapReady}
              onClick={() => {
                setRulerPoints([])
                setRulerActive((value) => !value)
                setToolsOpen(false)
              }}
            >
              <Ruler size={17} aria-hidden="true" />
              {rulerActive ? 'Stop measuring' : 'Measure distance'}
            </button>
            {share ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    void copyLink()
                    setToolsOpen(false)
                  }}
                >
                  <Link2 size={17} aria-hidden="true" />
                  Copy link to this view
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void downloadImage()
                    setToolsOpen(false)
                  }}
                >
                  <Camera size={17} aria-hidden="true" />
                  Save this view as an image
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* Outcomes of a share are announced rather than shown silently: neither
          the clipboard nor a download changes anything on screen. */}
      <div className="map-share-status" role="status" aria-live="polite">
        {shareStatus ? (
          <div className="map-share-readout">
            <div className="map-share-line">
              {shareLink ? <Info size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
              <span>{shareStatus}</span>
              <button
                type="button"
                onClick={() => {
                  setShareStatus(null)
                  setShareLink(null)
                }}
                aria-label="Dismiss the share message"
              >
                <X size={14} />
              </button>
            </div>
            {shareLink ? (
              <input
                ref={shareLinkRef}
                type="text"
                readOnly
                value={shareLink}
                aria-label="Link to this view"
                onFocus={(event) => event.currentTarget.select()}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {rulerActive ? (
        <div className="map-ruler-readout" role="status">
          <Ruler size={14} aria-hidden="true" />
          {rulerMeasurement ? (
            <>
              <strong>{formatDistance(rulerMeasurement.distanceNm, units)}</strong>
              <span>{Math.round(rulerMeasurement.bearingDegrees).toString().padStart(3, '0')}°</span>
            </>
          ) : (
            <span>{rulerPoints.length ? 'Click the second point' : 'Click two points to measure'}</span>
          )}
          <button type="button" onClick={() => { setRulerPoints([]); setRulerActive(false) }} aria-label="Close the ruler">
            <X size={14} />
          </button>
        </div>
      ) : null}
      {onMapLayersChange ? (
        <MapLayerMenu
          layers={mapLayers}
          onChange={onMapLayersChange}
          display={onMapDisplayChange ? mapDisplay : undefined}
          onDisplayChange={onMapDisplayChange}
          /* Null while the dataset is in flight, which is not yet a reason to
             disable anything; an empty list means this deployment has none. */
          unavailable={
            airports?.length === 0
              ? { airports: 'No airport data — download it on the Settings page' }
              : undefined
          }
        />
      ) : null}
      {hoveredIcao && !rulerActive ? (() => {
        const hovered = aircraft.find((item) => item.icao === hoveredIcao)
        return hovered ? <div className="map-hover-card"><strong>{aircraftLabel(hovered)}</strong><span>{hovered.registration || hovered.icao.toUpperCase()}</span><small>{hovered.altitudeBaro === 'ground' ? 'Ground' : hovered.altitudeBaro == null ? 'Altitude —' : formatAltitude(hovered.altitudeBaro, units)} · {hovered.groundSpeed == null ? 'Speed —' : formatSpeed(hovered.groundSpeed, units)}</small></div> : null
      })() : null}
      {/* Only the colour scale earns permanent space over the map: it is what
          the colours on screen currently mean and, where the page has an
          altitude filter, the control for it. The shape and waypoint keys are
          read once and then known, so they sit behind the toggle — expanded,
          they covered a corner of the map and the track under it. The narrow
          layout collapses the scale away with them. */}
      <div className={`map-legend ${legendOpen ? 'open' : ''}`} aria-label="Map legend">
        {trackColourMode === 'altitude' ? (
          <div
            className="map-altitude-scale"
            aria-label={`Altitude colour scale in ${unitLabels.altitude[units.altitude]}`}
          >
            {altitudeBands(theme).map((band) => {
              const description = bandDescription(band, units)
              return onAltitudeBandChange ? (
                <button
                  key={band.key}
                  type="button"
                  data-band={band.key}
                  className={altitudeBand === band.key ? 'active' : ''}
                  style={{ '--band': band.colour } as CSSProperties}
                  aria-pressed={altitudeBand === band.key}
                  aria-label={
                    altitudeBand === band.key
                      ? `Show every altitude again instead of only aircraft ${description}`
                      : `Show only aircraft ${description}`
                  }
                  onClick={() => onAltitudeBandChange(band)}
                >
                  <i />
                  {bandLabel(band, units)}
                </button>
              ) : (
                <span key={band.key} style={{ '--band': band.colour } as CSSProperties} title={description}>
                  <i />
                  {bandLabel(band, units)}
                </span>
              )
            })}
          </div>
        ) : (() => {
          const ramp = trackColourModes(theme)[trackColourMode]
          return (
            <div
              className="map-altitude-scale"
              aria-label={`Track ${ramp.label.toLowerCase()} colour scale`}
            >
              {ramp.steps.map((step, index) => (
                <span
                  key={step.key}
                  style={{ '--band': step.colour } as CSSProperties}
                  title={ramp.description(step, ramp.steps[index + 1], units)}
                >
                  <i />
                  {ramp.tick(step, units)}
                </span>
              ))}
            </div>
          )
        })()}
        <button
          type="button"
          className="map-legend-toggle"
          aria-expanded={legendOpen}
          aria-controls={legendBodyId}
          onClick={() => setLegendOpen((value) => !value)}
        >
          <ChevronDown size={13} aria-hidden="true" />
          Map key
        </button>
        <div className="map-legend-body" id={legendBodyId} hidden={!legendOpen}>
          <ul className="map-shape-key">
            {aircraftShapes.map((shape) => (
              <li key={shape}>
                <svg viewBox="0 0 34 34" aria-hidden="true" focusable="false">
                  <polygon points={shapePoints(shape)} />
                </svg>
                {shapeLabels[shape]}
              </li>
            ))}
          </ul>
          <div className="map-waypoint-key">
            <span><i className="arrival" />Arrival fix</span>
            <span><i className="departure" />Departure fix</span>
            {/* Only while the marker is on, so the key never explains a colour
                that is not on the map. */}
            {newSince != null ? <span><i className="new-sighting" />New to this receiver</span> : null}
            {airports?.length && mapLayers.airports ? (
              <span><i className="airport" />Airport</span>
            ) : null}
          </div>
        </div>
      </div>
      {mapError ? (
        <div className="map-error" role="status">
          <strong>Base map unavailable</strong>
          <span>Live positions will return when map tiles reconnect.</span>
        </div>
      ) : null}
    </div>
  )
})
