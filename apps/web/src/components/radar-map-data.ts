/**
 * The map's data layer: the GeoJSON builders, icon generation, geometry and
 * label formatting behind `RadarMap`, none of which touch React.
 *
 * Split out because the component around them had grown past 1,900 lines. What
 * is left there is effects that own MapLibre instance state and have to be read
 * together; these do not, and they are the half with a contract worth testing —
 * `radar-map-data.test.ts` exercises this module directly.
 */
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson'
import type { CoverageCell, MapLayerPreferences } from '@flightmap/shared'
import type {
  DataDrivenPropertyValueSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
} from 'maplibre-gl'
import { defaultReceiver } from '../config'
import type { ResolvedTheme } from '../lib/theme'
import type { AltitudeBand } from '../lib/altitude-bands'
import {
  aircraftShape,
  shapeOutlines,
  type AircraftShape,
} from '../lib/aircraft-category'
import {
  aircraftLabel,
  altitudeColour,
  altitudeDisplayValue,
  formatAltitude,
  formatDistance,
} from '../lib/format'
import type { UnitPreferences } from '../lib/unit-preferences'
import { isNewSighting } from '../lib/sighting-preferences'
import type { Aircraft, Receiver, TrackPoint, TrackResponse } from '../types'
import type { TrailPoint } from '../state/live-reducer'
import { trackColour, type TrackColourMode } from '../lib/track-colour'

export const AIRCRAFT_SOURCE = 'live-aircraft'
export const RECEIVER_SOURCE = 'receiver'
export const RINGS_SOURCE = 'range-rings'
export const WAYPOINT_SOURCE = 'route-waypoints'
export const TRACK_SOURCE = 'history-tracks'
export const ALL_TRAILS_SOURCE = 'all-aircraft-trails'
export const REPLAY_SOURCE = 'replay-aircraft'
export const COVERAGE_SOURCE = 'map-coverage'
export const RULER_SOURCE = 'map-ruler'
export const AIRPORT_SOURCE = 'airports'
export const RUNWAY_SOURCE = 'airport-runways'

export const layerIds = {
  coverage: ['map-coverage-heat'],
  rangeRings: ['range-ring-fill', 'range-ring-line'],
  aircraftLabels: ['aircraft-labels', 'replay-label'],
  trails: ['history-track-shadow', 'history-track'],
  allTrails: ['all-aircraft-trails'],
  airports: ['airport-runways', 'airport-markers', 'airport-labels'],
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

export function coverageData(cells: CoverageCell[]): FeatureCollection<Point> {
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

export function applyLayerVisibility(map: MapLibreMap, layers: MapLayerPreferences) {
  for (const [key, ids] of Object.entries(layerIds) as Array<[
    keyof MapLayerPreferences,
    string[],
  ]>) {
    for (const id of ids) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', layers[key] ? 'visible' : 'none')
    }
  }
}

export const AIRCRAFT_COLOURS = {
  ground: '#aeb9c3',
  low: '#67dda9',
  lower: '#52d5df',
  middle: '#5a9ff5',
  high: '#a987f0',
  veryHigh: '#e57bd4',
  extreme: '#ff7684',
  unknown: '#8d9aa8',
} as const

export const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function motionDuration(milliseconds: number) {
  return prefersReducedMotion ? 0 : milliseconds
}

/**
 * Touch browsers synthesise a mouse event stream from a tap, so hover-only
 * affordances have to ask whether the pointer can actually hover rather than
 * whether a mouse event arrived.
 */
export function hasHoverPointer() {
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

export function altitudeBand(altitude: Aircraft['altitudeBaro'] | number | null) {
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
export const mapLabelColours = {
  dark: {
    halo: '#091015',
    aircraft: '#d7e3eb',
    replay: '#ffffff',
    arrival: '#ffd287',
    departure: '#7ce8c9',
    trackCasing: '#020406',
    airport: '#9fb4c4',
    runway: '#8fa6b8',
  },
  light: {
    halo: '#ffffff',
    aircraft: '#16202a',
    replay: '#101820',
    arrival: '#814300',
    departure: '#006d4b',
    trackCasing: '#ffffff',
    airport: '#43596b',
    runway: '#5a7183',
  },
} as const satisfies Record<ResolvedTheme, Record<string, string>>

export function aircraftImage(shape: AircraftShape, colour: string): ImageData {
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

export function destinationPoint(
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

export function ringData(
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

/** Exported for the emphasis-precedence test; the map is its only caller. */
export function liveAircraftData(
  aircraft: Aircraft[],
  units: UnitPreferences,
  selectedIcao?: string | null,
  newSince: number | null = null,
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
          /*
           * Emphasis precedence: emergency, then alert, then watchlist, then
           * new. Resolved here rather than by layer order so an aircraft that
           * is more than one thing wears exactly one halo — a first sighting
           * must never be what someone sees instead of an alert.
           */
          newSighting:
            isNewSighting(item.firstSeenAt, newSince) &&
            !isEmergencyAircraft(item) &&
            !item.hasActiveAlert &&
            !item.watched
              ? 1
              : 0,
          opacity: item.seenPositionSeconds == null ? 0.65 : Math.max(0.25, 1 - item.seenPositionSeconds / 60),
        },
        geometry: { type: 'Point', coordinates: [item.longitude!, item.latitude!] },
      })),
  }
}

export function receiverData(receiver?: Receiver | null): FeatureCollection<Point> {
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

/**
 * A track as one line per run of samples sharing a colour, in the same "a span
 * takes the colour of the point it arrives at" sense as `colourSpans`. Runs
 * overlap by their joining sample, so a change of colour has no seam.
 *
 * Emitting a feature per sample pair instead — which this did — made a track
 * vanish outright once it was zoomed far enough out. The source's tiler drops
 * any line whose whole length falls under the tile's simplification tolerance,
 * and because every segment is about as long as the next they all cross that
 * threshold at the same zoom, taking the track with them.
 *
 * Measured against geojson-vt with the options `GeoJSONSource` passes it, the
 * cutoff is roughly 29,350 / 2^zoom metres of projected length. A one-second
 * sample at 355 kt survives intact at zoom 7 and all 1,400 segments disappear
 * at zoom 6; a slower aircraft reaches it a zoom or two earlier. A run is
 * measured over its whole length instead, so it lives or dies as the path it
 * describes, and one feature replaces fourteen hundred either way.
 */
export function trackData(
  tracks: TrackResponse[],
  colourMode: TrackColourMode,
  theme?: ResolvedTheme,
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = []
  for (const track of tracks) {
    let coordinates: Array<[number, number]> = []
    let runColour: string | null = null
    const flush = () => {
      if (coordinates.length > 1 && runColour !== null) {
        features.push({
          type: 'Feature',
          properties: {
            sessionId: track.session.id,
            icao: track.session.icao,
            colour: runColour,
          },
          geometry: { type: 'LineString', coordinates },
        })
      }
      coordinates = []
      runColour = null
    }
    for (let index = 1; index < track.points.length; index += 1) {
      const previous = track.points[index - 1]
      const point = track.points[index]
      /*
       * Unreachable on a dense array — this is `noUncheckedIndexedAccess`
       * being satisfied, not gap handling. A break in reception is a gap in
       * time, not in the array, and a run still draws straight across one.
       */
      if (!previous || !point) {
        flush()
        continue
      }
      const colour = trackColour(colourMode, point, theme)
      if (colour !== runColour) {
        flush()
        coordinates = [[previous.longitude, previous.latitude]]
        runColour = colour
      }
      coordinates.push([point.longitude, point.latitude])
    }
    flush()
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

export function replayData(tracks: TrackResponse[], replayTime?: number | null): FeatureCollection<Point> {
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
export function scaleUnit(unit: UnitPreferences['distance']): 'nautical' | 'metric' | 'imperial' {
  if (unit === 'km') return 'metric'
  return unit === 'mi' ? 'imperial' : 'nautical'
}

export function setSourceData(map: MapLibreMap, source: string, data: FeatureCollection) {
  ;(map.getSource(source) as GeoJSONSource | undefined)?.setData(data)
}

/**
 * The basemap is fetched rather than authored here, and the dark style it ships
 * with draws its road network only a few percent above the background: at a
 * glance the motorways and A-roads a reader actually navigates by are not on
 * the map at all, and neither are the town names over them.
 *
 * These raise the classes the eye uses — motorway down to minor — and the
 * labels above them. Only colours are rewritten. Widths are zoom expressions
 * the style is entitled to own, and a flat width would break at either end of
 * the zoom range.
 *
 * The light basemap is left alone. Its road colouring is the conventional one,
 * already well clear of a pale background, and overriding it would trade a
 * familiar map for an unfamiliar one to fix a problem it does not have.
 */
const basemapContrast = {
  /* A steep ramp rather than an even one. The point is to be able to place
     yourself at a glance, which two or three classes of road do; lifting the
     rest by the same amount buys nothing and costs a web of lines over the
     traffic, which is the thing actually being read. */
  road: {
    motorway: '#8fa3b3',
    primary: '#5e7082',
    secondary: '#46525e',
    minor: '#2f3841',
    rail: '#3a444e',
    /* Paths, tracks, piers and ferry lines. Present at this zoom in quantity
       and never what someone is navigating by. */
    other: '#242b32',
  },
  /* Roads are drawn as a wide casing under a narrower fill. Keeping the casing
     near the background turns the lift above into a line with an edge rather
     than a band of flat colour. */
  roadCasing: '#0d1319',
  place: { text: '#e8eef3', halo: '#05090d' },
  roadLabel: { text: '#b9c6d1', halo: '#05090d' },
  water: '#132a37',
} as const

/** The OpenMapTiles layers this reads. Anything else in the style is untouched. */
const ROAD_SOURCE_LAYER = 'transportation'
const ROAD_LABEL_SOURCE_LAYER = 'transportation_name'
const PLACE_SOURCE_LAYER = 'place'
const WATER_SOURCE_LAYER = 'water'

/**
 * Layers in the road source that are not the road. A dashline is the dark
 * overlay that makes a railway read as hatched rather than solid, so lifting it
 * to a road colour fills the hatch in and turns the railway into a road.
 */
const ROAD_DECORATION = /dashline|hatch/i

type BasemapStyleMap = Pick<MapLibreMap, 'getStyle' | 'setPaintProperty'>

/**
 * `class` is a feature property rather than something encoded in the layer id,
 * so one expression re-colours every road layer a style happens to define —
 * surface, bridge, tunnel and low-zoom variants included — and keeps the
 * hierarchy that a single flat override would have thrown away.
 */
function roadColourExpression(): DataDrivenPropertyValueSpecification<string> {
  return [
    'match',
    ['get', 'class'],
    'motorway',
    basemapContrast.road.motorway,
    ['trunk', 'primary'],
    basemapContrast.road.primary,
    ['secondary', 'tertiary'],
    basemapContrast.road.secondary,
    ['minor', 'service', 'busway', 'bus_guideway'],
    basemapContrast.road.minor,
    ['rail', 'transit'],
    basemapContrast.road.rail,
    basemapContrast.road.other,
  ]
}

export function applyBasemapContrast(map: BasemapStyleMap, theme: ResolvedTheme): void {
  if (theme !== 'dark') return
  const road = roadColourExpression()

  for (const layer of map.getStyle().layers ?? []) {
    const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined
    if (!sourceLayer) continue

    if (layer.type === 'line' && sourceLayer === ROAD_SOURCE_LAYER) {
      if (ROAD_DECORATION.test(layer.id)) continue
      // Casings are named, not typed: every style in this family marks them in
      // the layer id because nothing in the data distinguishes them.
      const casing = /casing|outline/i.test(layer.id)
      map.setPaintProperty(layer.id, 'line-color', casing ? basemapContrast.roadCasing : road)
      continue
    }

    if (layer.type !== 'symbol') {
      if (layer.type === 'fill' && sourceLayer === WATER_SOURCE_LAYER) {
        map.setPaintProperty(layer.id, 'fill-color', basemapContrast.water)
      }
      continue
    }

    const labels =
      sourceLayer === PLACE_SOURCE_LAYER
        ? basemapContrast.place
        : sourceLayer === ROAD_LABEL_SOURCE_LAYER
          ? basemapContrast.roadLabel
          : null
    if (!labels) continue
    map.setPaintProperty(layer.id, 'text-color', labels.text)
    map.setPaintProperty(layer.id, 'text-halo-color', labels.halo)
    map.setPaintProperty(layer.id, 'text-halo-width', 1.2)
  }
}
