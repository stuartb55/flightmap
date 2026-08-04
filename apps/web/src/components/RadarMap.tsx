import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson'
import type { CoverageCell, MapDisplayPreferences, MapLayerPreferences, MapViewport } from '@flightmap/shared'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { createPortal } from 'react-dom'
import { Camera, Check, Focus, Info, Link2, LocateFixed, Maximize2, Minus, Plus, Ruler, X } from 'lucide-react'
import { defaultReceiver, useMapStyleUrl, useRuntimeConfig } from '../config'
import { useResolvedTheme, type ResolvedTheme } from '../lib/theme'
import { altitudeBands, type AltitudeBand } from '../lib/altitude-bands'
import { Link } from '../lib/router'
import {
  aircraftShape,
  aircraftShapes,
  shapeLabels,
  shapeOutlines,
  shapePoints,
  type AircraftShape,
} from '../lib/aircraft-category'
import { aircraftLabel, altitudeColour, altitudeDisplayValue, formatAltitude, formatDistance, formatSpeed } from '../lib/format'
import { unitLabels, useUnitPreferences, type UnitPreferences } from '../lib/unit-preferences'
import type { Aircraft, Receiver, TrackPoint, TrackResponse } from '../types'
import type { TrailPoint } from '../state/live-reducer'
import { waypointData } from './waypoints'
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
import { trackColour, trackColourModes, type TrackColourMode } from '../lib/track-colour'

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
  /** Clicking empty map space, or dismissing the pinned popup. */
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

const AIRCRAFT_SOURCE = 'live-aircraft'
const RECEIVER_SOURCE = 'receiver'
const RINGS_SOURCE = 'range-rings'
const WAYPOINT_SOURCE = 'route-waypoints'
const TRACK_SOURCE = 'history-tracks'
const ALL_TRAILS_SOURCE = 'all-aircraft-trails'
const REPLAY_SOURCE = 'replay-aircraft'
const COVERAGE_SOURCE = 'map-coverage'
const RULER_SOURCE = 'map-ruler'

const layerIds = {
  coverage: ['map-coverage-heat'],
  rangeRings: ['range-ring-fill', 'range-ring-line'],
  aircraftLabels: ['aircraft-labels', 'replay-label'],
  trails: ['history-track-shadow', 'history-track'],
  allTrails: ['all-aircraft-trails'],
  manchesterWaypoints: ['route-waypoint-markers', 'route-waypoint-labels'],
} satisfies Record<keyof MapLayerPreferences, string[]>

/**
 * One line per aircraft, coloured by its current altitude. Per-segment colouring
 * would multiply the feature count by the buffer length for a difference nobody
 * can see on a trail this short.
 */
export function allTrailsData(
  trails: Record<string, TrailPoint[]>,
  theme?: ResolvedTheme,
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = []
  for (const [icao, points] of Object.entries(trails)) {
    if (points.length < 2) continue
    features.push({
      type: 'Feature',
      properties: {
        icao,
        colour: altitudeColour(points[points.length - 1]!.altitudeBaro, theme),
      },
      geometry: {
        type: 'LineString',
        coordinates: points.map((point) => [point.longitude, point.latitude]),
      },
    })
  }
  return { type: 'FeatureCollection', features }
}

function coverageData(cells: CoverageCell[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: cells.map((cell, index) => ({
      type: 'Feature',
      id: index,
      properties: { intensity: Math.max(1, Math.log10(cell.reports + 1)) },
      geometry: { type: 'Point', coordinates: [cell.longitude, cell.latitude] },
    })),
  }
}

function applyLayerVisibility(map: MapLibreMap, layers: MapLayerPreferences) {
  for (const [key, ids] of Object.entries(layerIds) as Array<[
    keyof MapLayerPreferences,
    string[],
  ]>) {
    for (const id of ids) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', layers[key] ? 'visible' : 'none')
    }
  }
}

const AIRCRAFT_COLOURS = {
  ground: '#aeb9c3',
  low: '#67dda9',
  lower: '#52d5df',
  middle: '#5a9ff5',
  high: '#a987f0',
  veryHigh: '#e57bd4',
  extreme: '#ff7684',
  unknown: '#8d9aa8',
} as const

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function motionDuration(milliseconds: number) {
  return prefersReducedMotion ? 0 : milliseconds
}

/**
 * Touch browsers synthesise a mouse event stream from a tap, so hover-only
 * affordances have to ask whether the pointer can actually hover rather than
 * whether a mouse event arrived.
 */
function hasHoverPointer() {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true
}

/**
 * Whether a selected aircraft sits far enough from the centre of the view to be
 * worth moving the camera for. The margin keeps an aircraft hard against an
 * edge from counting as visible, and is clamped so it can never exceed a third
 * of a small container - otherwise a narrow map would always recentre.
 */
export function needsRecentre(
  point: { x: number; y: number },
  width: number,
  height: number,
  marginPx = 90,
): boolean {
  if (width <= 0 || height <= 0) return true
  const margin = Math.min(marginPx, width / 3, height / 3)
  return (
    point.x < margin ||
    point.x > width - margin ||
    point.y < margin ||
    point.y > height - margin
  )
}

export function isEmergencyAircraft(
  aircraft: Pick<Aircraft, 'squawk' | 'emergency'>,
): boolean {
  const emergency = aircraft.emergency?.trim().toLowerCase()
  return (
    ['7500', '7600', '7700'].includes(aircraft.squawk ?? '') ||
    (emergency != null && !['none', 'no emergency', 'no_emergency'].includes(emergency))
  )
}

function altitudeBand(altitude: Aircraft['altitudeBaro'] | number | null) {
  if (altitude === 'ground') return 'ground'
  if (altitude == null) return 'unknown'
  if (altitude < 3_000) return 'low'
  if (altitude < 10_000) return 'lower'
  if (altitude < 20_000) return 'middle'
  if (altitude < 30_000) return 'high'
  if (altitude < 40_000) return 'veryHigh'
  return 'extreme'
}

function fillOutline(context: CanvasRenderingContext2D, shape: AircraftShape) {
  const points = shapeOutlines[shape]
  const start = points[0]
  if (!start) return
  context.beginPath()
  context.moveTo(start[0], start[1])
  for (const [x, y] of points.slice(1)) context.lineTo(x, y)
  context.closePath()
  context.fill()
}

/**
 * Decoration drawn on top of the shared body outline. Only the shapes that need
 * more than a silhouette to be recognisable have an entry.
 */
const shapeDecorations: Partial<Record<AircraftShape, (context: CanvasRenderingContext2D) => void>> = {
  // Four nacelles read as "heavy" faster than wingspan alone at low zoom.
  heavy: (context) => {
    for (const [x, y] of [[7.4, 21], [11.4, 18.6], [20.6, 18.6], [24.6, 21]]) {
      context.fillRect(x!, y!, 2.2, 3.4)
    }
  },
  // A faint rotor disc is what actually distinguishes a helicopter in traffic.
  rotorcraft: (context) => {
    const alpha = context.globalAlpha
    context.globalAlpha = alpha * 0.5
    context.beginPath()
    context.arc(17, 16, 12.5, 0, Math.PI * 2)
    context.lineWidth = 1.3
    context.strokeStyle = context.fillStyle
    context.stroke()
    context.globalAlpha = alpha
    context.fillRect(13.4, 29.6, 7.2, 1.6)
  },
}

/**
 * Colours for the layers MapLibre paints itself. These sit on the basemap
 * rather than on a panel, so they cannot read a CSS token — and a pale label
 * with a dark halo, which is right over a dark basemap, reads as a smudge over
 * a pale one.
 */
const mapLabelColours = {
  dark: {
    halo: '#091015',
    aircraft: '#d7e3eb',
    replay: '#ffffff',
    arrival: '#ffd287',
    departure: '#7ce8c9',
    trackCasing: '#020406',
  },
  light: {
    halo: '#ffffff',
    aircraft: '#16202a',
    replay: '#101820',
    arrival: '#814300',
    departure: '#006d4b',
    trackCasing: '#ffffff',
  },
} as const satisfies Record<ResolvedTheme, Record<string, string>>

function aircraftImage(shape: AircraftShape, colour: string): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = 34
  canvas.height = 34
  const context = canvas.getContext('2d')
  if (!context) return new ImageData(34, 34)
  context.fillStyle = colour
  context.shadowColor = 'rgba(0,0,0,.8)'
  context.shadowBlur = 3
  fillOutline(context, shape)
  shapeDecorations[shape]?.(context)
  return context.getImageData(0, 0, 34, 34)
}

/**
 * Surface vehicles never report a useful altitude, so they always take the
 * ground colour rather than the "unknown" grey.
 */
export function aircraftIconId(shape: AircraftShape, band: string): string {
  return `aircraft-${shape}-${shape === 'ground' ? 'ground' : band}`
}

type StyleImageMap = Pick<MapLibreMap, 'addImage' | 'getImage' | 'hasImage'>

const STYLE_IMAGE_ALIASES: Readonly<Record<string, string>> = {
  'circle-11': 'circle_11',
}

export function resolveStyleImageAlias(map: StyleImageMap, id: string): void {
  const sourceId = STYLE_IMAGE_ALIASES[id]
  if (!sourceId || map.hasImage(id) || !map.hasImage(sourceId)) return

  const source = map.getImage(sourceId)
  map.addImage(
    id,
    {
      width: source.data.width,
      height: source.data.height,
      data: source.data.data,
    },
    {
      pixelRatio: source.pixelRatio,
      sdf: source.sdf,
      stretchX: source.stretchX,
      stretchY: source.stretchY,
      content: source.content,
      textFitWidth: source.textFitWidth,
      textFitHeight: source.textFitHeight,
    },
  )
}

function destinationPoint(
  latitude: number,
  longitude: number,
  bearingDegrees: number,
  distanceNm: number,
): [number, number] {
  const radiusNm = 3_440.065
  const angularDistance = distanceNm / radiusNm
  const bearing = (bearingDegrees * Math.PI) / 180
  const lat1 = (latitude * Math.PI) / 180
  const lon1 = (longitude * Math.PI) / 180
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  )
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    )
  return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]
}

/**
 * Great-circle distance and initial bearing between two points, the inverse of
 * `destinationPoint` above and the same spherical model the server measures
 * ranges with (`domain/geo.ts`).
 */
export function greatCircle(
  from: [number, number],
  to: [number, number],
): { distanceNm: number; bearingDegrees: number } {
  const radiusNm = 3_440.065
  const toRadians = (value: number) => (value * Math.PI) / 180
  const lat1 = toRadians(from[1])
  const lat2 = toRadians(to[1])
  const deltaLat = lat2 - lat1
  const deltaLon = toRadians(to[0] - from[0])
  const haversine =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2
  const distanceNm = 2 * radiusNm * Math.asin(Math.min(1, Math.sqrt(haversine)))
  const bearing = Math.atan2(
    Math.sin(deltaLon) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon),
  )
  return { distanceNm, bearingDegrees: ((bearing * 180) / Math.PI + 360) % 360 }
}

/** The measured line and its endpoints, for the ruler layers. */
export function rulerData(points: Array<[number, number]>): FeatureCollection {
  const features: Feature[] = points.map((point, index) => ({
    type: 'Feature',
    properties: { index },
    geometry: { type: 'Point', coordinates: point },
  }))
  if (points.length === 2) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: points },
    })
  }
  return { type: 'FeatureCollection', features }
}

function ringData(
  receiver: Receiver | null | undefined,
  rings: readonly number[],
  units: UnitPreferences,
): FeatureCollection<Polygon> {
  const latitude = receiver?.latitude ?? defaultReceiver().latitude
  const longitude = receiver?.longitude ?? defaultReceiver().longitude
  return {
    type: 'FeatureCollection',
    features: rings.map((distance) => {
      const points = Array.from({ length: 97 }, (_, index) =>
        destinationPoint(latitude, longitude, (index / 96) * 360, distance),
      )
      return {
        type: 'Feature',
        // Rings are configured in nautical miles; only their label follows the
        // browser's distance unit.
        properties: { distance, label: formatDistance(distance, units) },
        geometry: { type: 'Polygon', coordinates: [points] },
      }
    }),
  }
}

function liveAircraftData(
  aircraft: Aircraft[],
  units: UnitPreferences,
  selectedIcao?: string | null,
): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: aircraft
      .filter(
        (item) =>
          item.latitude != null &&
          item.longitude != null &&
          Number.isFinite(item.latitude) &&
          Number.isFinite(item.longitude),
      )
      .map((item) => ({
        type: 'Feature',
        id: item.icao,
        properties: {
          icao: item.icao,
          label: aircraftLabel(item),
          secondary:
            item.altitudeBaro === 'ground'
              ? 'GND'
              : item.altitudeBaro == null
                ? ''
                : altitudeDisplayValue(item.altitudeBaro, units).toLocaleString('en-GB'),
          rotation: item.track ?? item.trueHeading ?? 0,
          icon: aircraftIconId(aircraftShape(item), altitudeBand(item.altitudeBaro)),
          selected: item.icao === selectedIcao ? 1 : 0,
          emergency: isEmergencyAircraft(item) ? 1 : 0,
          watched: item.watched ? 1 : 0,
          opacity: item.seenPositionSeconds == null ? 0.65 : Math.max(0.25, 1 - item.seenPositionSeconds / 60),
        },
        geometry: { type: 'Point', coordinates: [item.longitude!, item.latitude!] },
      })),
  }
}

function receiverData(receiver?: Receiver | null): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: receiver?.name ?? defaultReceiver().name },
        geometry: {
          type: 'Point',
          coordinates: [
            receiver?.longitude ?? defaultReceiver().longitude,
            receiver?.latitude ?? defaultReceiver().latitude,
          ],
        },
      },
    ],
  }
}

function trackData(
  tracks: TrackResponse[],
  colourMode: TrackColourMode,
  theme?: ResolvedTheme,
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = []
  for (const track of tracks) {
    for (let index = 1; index < track.points.length; index += 1) {
      const previous = track.points[index - 1]
      const point = track.points[index]
      if (!previous || !point) continue
      features.push({
        type: 'Feature',
        properties: {
          sessionId: track.session.id,
          icao: track.session.icao,
          colour: trackColour(colourMode, point, theme),
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [previous.longitude, previous.latitude],
            [point.longitude, point.latitude],
          ],
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

export function interpolateTrack(points: TrackPoint[], time: number): TrackPoint | null {
  if (!points.length) return null
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return null
  if (time <= new Date(first.recordedAt).getTime()) return first
  if (time >= new Date(last.recordedAt).getTime()) return last

  let low = 0
  let high = points.length - 1
  while (low < high - 1) {
    const middle = Math.floor((low + high) / 2)
    const middlePoint = points[middle]
    if (!middlePoint || new Date(middlePoint.recordedAt).getTime() > time) high = middle
    else low = middle
  }
  const from = points[low]
  const to = points[high]
  if (!from || !to) return from ?? to ?? null
  const fromTime = new Date(from.recordedAt).getTime()
  const toTime = new Date(to.recordedAt).getTime()
  const ratio = toTime === fromTime ? 0 : (time - fromTime) / (toTime - fromTime)
  const interpolate = (left: number | null, right: number | null) =>
    left == null || right == null ? (left ?? right) : left + (right - left) * ratio
  return {
    recordedAt: new Date(time).toISOString(),
    latitude: interpolate(from.latitude, to.latitude)!,
    longitude: interpolate(from.longitude, to.longitude)!,
    altitudeFt: interpolate(from.altitudeFt, to.altitudeFt),
    groundSpeedKt: interpolate(from.groundSpeedKt, to.groundSpeedKt),
    trackDegrees: interpolate(from.trackDegrees, to.trackDegrees),
  }
}

export function replayPointAtTime(points: TrackPoint[], time: number): TrackPoint | null {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return null
  const firstTime = new Date(first.recordedAt).getTime()
  const lastTime = new Date(last.recordedAt).getTime()
  if (
    !Number.isFinite(firstTime) ||
    !Number.isFinite(lastTime) ||
    time < firstTime ||
    time > lastTime
  ) {
    return null
  }
  return interpolateTrack(points, time)
}

function replayData(tracks: TrackResponse[], replayTime?: number | null): FeatureCollection<Point> {
  if (replayTime == null) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: tracks.flatMap((track) => {
      const point = replayPointAtTime(track.points, replayTime)
      if (!point) return []
      return [
        {
          type: 'Feature' as const,
          properties: {
            sessionId: track.session.id,
            icao: track.session.icao,
            label: track.session.callsigns[0] || track.session.icao.toUpperCase(),
            rotation: point.trackDegrees ?? 0,
            // Historical points carry no emitter category, so replay always
            // uses the neutral airliner glyph.
            icon: aircraftIconId('standard', altitudeBand(point.altitudeFt)),
          },
          geometry: {
            type: 'Point' as const,
            coordinates: [point.longitude, point.latitude],
          },
        },
      ]
    }),
  }
}

/** Thousands label for the legend, so the colour bands stay readable in metres. */
export function scaleLabel(feet: number, units: UnitPreferences): string {
  const thousands = altitudeDisplayValue(feet, units) / 1_000
  return `${units.altitude === 'm' ? thousands.toFixed(1) : thousands.toFixed(0)}k`
}

/** Legend segment label: the band's floor, so the segments read as a scale. */
export function bandLabel(band: AltitudeBand, units: UnitPreferences): string {
  if (band.key === 'ground') return 'GND'
  if (band.minimumFt === 0) return '0'
  return `${scaleLabel(band.minimumFt, units)}${band.maximumFt == null ? '+' : ''}`
}

/** What isolating a band would show, spoken in the reader's own units. */
export function bandDescription(band: AltitudeBand, units: UnitPreferences): string {
  if (band.key === 'ground') return 'on the ground'
  if (band.maximumFt == null) return `above ${formatAltitude(band.minimumFt, units)}`
  return `from ${formatAltitude(band.minimumFt, units)} to ${formatAltitude(band.maximumFt, units)}`
}

/** MapLibre's scale bar offers three unit families; map ours onto them. */
function scaleUnit(unit: UnitPreferences['distance']): 'nautical' | 'metric' | 'imperial' {
  if (unit === 'km') return 'metric'
  return unit === 'mi' ? 'imperial' : 'nautical'
}

function setSourceData(map: MapLibreMap, source: string, data: FeatureCollection) {
  ;(map.getSource(source) as GeoJSONSource | undefined)?.setData(data)
}

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
    trails = emptyTrails,
    trackColourMode = 'altitude',
    bottomInset = 0,
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
  const [rulerPoints, setRulerPoints] = useState<Array<[number, number]>>([])
  const rulerActiveRef = useRef(rulerActive)
  const hoverPointerRef = useRef(hasHoverPointer())
  const bottomInsetRef = useRef(bottomInset)
  const shareRef = useRef(share)
  shareRef.current = share
  const initialViewportRef = useRef(initialViewport)
  // Only set when the view was restored from a link: see the recentre effect.
  const restoredSelectionRef = useRef(initialViewport ? selectedIcao ?? null : null)
  const [shareStatus, setShareStatus] = useState<string | null>(null)
  const [shareLink, setShareLink] = useState<string | null>(null)
  const shareLinkRef = useRef<HTMLInputElement>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)
  const popupHostRef = useRef<HTMLDivElement | null>(null)
  popupHostRef.current ??= typeof document === 'undefined' ? null : document.createElement('div')
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
      const restored = initialViewportRef.current
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

      map.addSource(ALL_TRAILS_SOURCE, {
        type: 'geojson',
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
        data: liveAircraftData(aircraftRef.current, unitsRef.current, selectedIcaoRef.current),
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
          'circle-radius': 23,
          'circle-color': '#f5fcff',
          'circle-opacity': 0.08,
          'circle-stroke-color': '#eafcff',
          'circle-stroke-width': 1.5,
        },
      })
      map.addLayer({
        id: 'aircraft-icons',
        type: 'symbol',
        source: AIRCRAFT_SOURCE,
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': ['case', ['==', ['get', 'selected'], 1], 1.65, 1.4],
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
          'text-field': ['concat', ['get', 'label'], '  ', ['get', 'secondary']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 14,
          'text-offset': [0, 2.35],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'text-optional': true,
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
      map.remove()
      mapRef.current = null
      popupRef.current = null
      setMapReady(false)
    }
    // A style change replaces every layer, so the map is rebuilt rather than
    // patched; every other runtime setting is applied by the effects below.
    // Switching theme changes the style and these colours, so it rebuilds
    // through the same path.
  }, [mapStyleUrl, theme])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, AIRCRAFT_SOURCE, liveAircraftData(aircraft, units, selectedIcao))
  }, [aircraft, selectedIcao, units, mapReady])

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

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    applyLayerVisibility(mapRef.current, mapLayers)
  }, [mapLayers, mapReady])

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
  const pinned = selectedIcao ? aircraft.find((item) => item.icao === selectedIcao) ?? null : null
  const pinnedLongitude = pinned?.longitude ?? null
  const pinnedLatitude = pinned?.latitude ?? null

  // A popup anchored to the aircraft, rather than a card in a corner, is the
  // one place that answers "which of these is it?" without moving the camera.
  useEffect(() => {
    const map = mapRef.current
    const host = popupHostRef.current
    if (!mapReady || !map || !host) return
    if (pinnedLongitude == null || pinnedLatitude == null) {
      popupRef.current?.remove()
      return
    }
    popupRef.current ??= new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      // Taking focus on every 1 Hz reselection would fight the keyboard user
      // walking the list.
      focusAfterOpen: false,
      offset: 20,
      maxWidth: '272px',
      className: 'map-aircraft-popup',
    }).setDOMContent(host)
    popupRef.current.setLngLat([pinnedLongitude, pinnedLatitude])
    if (!popupRef.current.isOpen()) popupRef.current.addTo(map)
  }, [mapReady, pinnedLatitude, pinnedLongitude])

  // One Escape handler for the map's own affordances, so their precedence is
  // written down: a measurement unwinds before the popup closes. Anything with
  // its own overlay semantics — a dialog, a text field — keeps its Escape.
  useEffect(() => {
    const canClosePopup = Boolean(pinned) && Boolean(onClearSelection)
    if (!rulerActive && !canClosePopup) return
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
  }, [onClearSelection, pinned, rulerActive, rulerPoints.length])

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
        {share ? (
          <>
            <button type="button" title="Copy a link to this view" aria-label="Copy a link to this view" onClick={() => void copyLink()}>
              <Link2 size={20} />
            </button>
            <button type="button" title="Download this view as an image" aria-label="Download this view as an image" onClick={() => void downloadImage()}>
              <Camera size={20} />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={rulerActive ? 'active' : ''}
          title="Measure distance and bearing"
          aria-label="Measure distance and bearing"
          aria-pressed={rulerActive}
          onClick={() => {
            setRulerPoints([])
            setRulerActive((value) => !value)
          }}
        >
          <Ruler size={20} />
        </button>
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
      {popupHostRef.current && pinned
        ? createPortal(
            <div className="map-popup-card">
              <div className="map-popup-head">
                <strong>{aircraftLabel(pinned)}</strong>
                {onClearSelection ? (
                  <button type="button" onClick={onClearSelection} aria-label="Close aircraft popup">
                    <X size={14} />
                  </button>
                ) : null}
              </div>
              <small>
                {pinned.registration || pinned.icao.toUpperCase()}
                {pinned.typeCode ? ` · ${pinned.typeCode}` : ''}
              </small>
              <dl>
                <div>
                  <dt>Altitude</dt>
                  <dd>{pinned.altitudeBaro === 'ground' ? 'Ground' : pinned.altitudeBaro == null ? '—' : formatAltitude(pinned.altitudeBaro, units)}</dd>
                </div>
                <div>
                  <dt>Speed</dt>
                  <dd>{pinned.groundSpeed == null ? '—' : formatSpeed(pinned.groundSpeed, units)}</dd>
                </div>
                <div>
                  <dt>Range</dt>
                  <dd>{pinned.distanceNm == null ? '—' : formatDistance(pinned.distanceNm, units)}</dd>
                </div>
                <div>
                  <dt>Squawk</dt>
                  <dd>{pinned.squawk ?? '—'}</dd>
                </div>
              </dl>
              <div className="map-popup-links">
                <Link to={`/aircraft/${encodeURIComponent(pinned.icao)}`}>Profile</Link>
                <Link to={`/history?aircraft=${encodeURIComponent(pinned.icao)}`}>History</Link>
              </div>
            </div>,
            popupHostRef.current,
          )
        : null}
      {onMapLayersChange ? <MapLayerMenu layers={mapLayers} onChange={onMapLayersChange} display={onMapDisplayChange ? mapDisplay : undefined} onDisplayChange={onMapDisplayChange} /> : null}
      {hoveredIcao && !rulerActive ? (() => {
        const hovered = aircraft.find((item) => item.icao === hoveredIcao)
        return hovered ? <div className="map-hover-card"><strong>{aircraftLabel(hovered)}</strong><span>{hovered.registration || hovered.icao.toUpperCase()}</span><small>{hovered.altitudeBaro === 'ground' ? 'Ground' : hovered.altitudeBaro == null ? 'Altitude —' : formatAltitude(hovered.altitudeBaro, units)} · {hovered.groundSpeed == null ? 'Speed —' : formatSpeed(hovered.groundSpeed, units)}</small></div> : null
      })() : null}
      {/* The narrow layout collapses the legend to its toggle so the key never
          covers the map; wider viewports keep it permanently expanded. */}
      <div className={`map-legend ${legendOpen ? 'open' : ''}`} aria-label="Map legend">
        <button
          type="button"
          className="map-legend-toggle"
          aria-expanded={legendOpen}
          aria-controls={legendBodyId}
          onClick={() => setLegendOpen((value) => !value)}
        >
          <Info size={14} aria-hidden="true" />
          Map key
        </button>
        <div className="map-legend-body" id={legendBodyId}>
          {/* The colour scale says what the colours on the map currently mean:
              the altitude ramp, which on a page with an altitude filter is
              also the control for it, or the ramp the tracks are coloured by. */}
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
