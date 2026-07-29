import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson'
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import { LocateFixed, Maximize2, Minus, Plus } from 'lucide-react'
import { DEFAULT_RECEIVER, MAP_STYLE_URL, RANGE_RINGS_NM } from '../config'
import { aircraftLabel, altitudeColour } from '../lib/format'
import type { Aircraft, Receiver, TrackPoint, TrackResponse } from '../types'

export interface RadarMapHandle {
  fitAircraft: () => void
  centerReceiver: () => void
}

interface Props {
  aircraft?: Aircraft[]
  receiver?: Receiver | null
  selectedIcao?: string | null
  onSelectAircraft?: (icao: string) => void
  tracks?: TrackResponse[]
  replayTime?: number | null
  followReplay?: boolean
  className?: string
}

const AIRCRAFT_SOURCE = 'live-aircraft'
const RECEIVER_SOURCE = 'receiver'
const RINGS_SOURCE = 'range-rings'
const TRACK_SOURCE = 'history-tracks'
const REPLAY_SOURCE = 'replay-aircraft'

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

function planeImage(colour: string): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = 34
  canvas.height = 34
  const context = canvas.getContext('2d')
  if (!context) return new ImageData(34, 34)
  context.fillStyle = colour
  context.shadowColor = 'rgba(0,0,0,.8)'
  context.shadowBlur = 3
  context.beginPath()
  context.moveTo(17, 1)
  context.lineTo(19, 12)
  context.lineTo(31, 18)
  context.lineTo(31, 21)
  context.lineTo(19.5, 18.5)
  context.lineTo(20.5, 27)
  context.lineTo(25, 31)
  context.lineTo(24.5, 33)
  context.lineTo(17, 30)
  context.lineTo(9.5, 33)
  context.lineTo(9, 31)
  context.lineTo(13.5, 27)
  context.lineTo(14.5, 18.5)
  context.lineTo(3, 21)
  context.lineTo(3, 18)
  context.lineTo(15, 12)
  context.closePath()
  context.fill()
  return context.getImageData(0, 0, 34, 34)
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

function ringData(receiver: Receiver | null | undefined): FeatureCollection<Polygon> {
  const latitude = receiver?.latitude ?? DEFAULT_RECEIVER.latitude
  const longitude = receiver?.longitude ?? DEFAULT_RECEIVER.longitude
  return {
    type: 'FeatureCollection',
    features: RANGE_RINGS_NM.map((distance) => {
      const points = Array.from({ length: 97 }, (_, index) =>
        destinationPoint(latitude, longitude, (index / 96) * 360, distance),
      )
      return {
        type: 'Feature',
        properties: { distance, label: `${distance} nm` },
        geometry: { type: 'Polygon', coordinates: [points] },
      }
    }),
  }
}

function liveAircraftData(aircraft: Aircraft[], selectedIcao?: string | null): FeatureCollection<Point> {
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
          secondary: item.altitudeBaro === 'ground' ? 'GND' : item.altitudeBaro?.toLocaleString() ?? '',
          rotation: item.track ?? item.trueHeading ?? 0,
          icon: `aircraft-${altitudeBand(item.altitudeBaro)}`,
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
        properties: { name: receiver?.name ?? DEFAULT_RECEIVER.name },
        geometry: {
          type: 'Point',
          coordinates: [
            receiver?.longitude ?? DEFAULT_RECEIVER.longitude,
            receiver?.latitude ?? DEFAULT_RECEIVER.latitude,
          ],
        },
      },
    ],
  }
}

function trackData(tracks: TrackResponse[]): FeatureCollection<LineString> {
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
          colour: altitudeColour(point.altitudeFt),
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
            icon: `aircraft-${altitudeBand(point.altitudeFt)}`,
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

function setSourceData(map: MapLibreMap, source: string, data: FeatureCollection) {
  ;(map.getSource(source) as GeoJSONSource | undefined)?.setData(data)
}

export const RadarMap = forwardRef<RadarMapHandle, Props>(function RadarMap(
  {
    aircraft = [],
    receiver,
    selectedIcao,
    onSelectAircraft,
    tracks = [],
    replayTime,
    followReplay,
    className,
  },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const aircraftRef = useRef(aircraft)
  const receiverRef = useRef(receiver)
  const onSelectRef = useRef(onSelectAircraft)
  const tracksRef = useRef(tracks)
  const replayTimeRef = useRef(replayTime)
  const selectedIcaoRef = useRef(selectedIcao)
  const lastFollowAtRef = useRef(0)
  const [mapReady, setMapReady] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)

  aircraftRef.current = aircraft
  receiverRef.current = receiver
  onSelectRef.current = onSelectAircraft
  tracksRef.current = tracks
  replayTimeRef.current = replayTime
  selectedIcaoRef.current = selectedIcao

  const fitAircraft = () => {
    const positioned = aircraftRef.current.filter(
      (item) => item.latitude != null && item.longitude != null,
    )
    if (!positioned.length) {
      const currentReceiver = receiverRef.current
      mapRef.current?.easeTo({
        center: [
          currentReceiver?.longitude ?? DEFAULT_RECEIVER.longitude,
          currentReceiver?.latitude ?? DEFAULT_RECEIVER.latitude,
        ],
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
      padding: 70,
      maxZoom: 10,
      duration: motionDuration(700),
    })
  }

  const centerReceiver = () => {
    const currentReceiver = receiverRef.current
    mapRef.current?.easeTo({
      center: [
        currentReceiver?.longitude ?? DEFAULT_RECEIVER.longitude,
        currentReceiver?.latitude ?? DEFAULT_RECEIVER.latitude,
      ],
      zoom: 8.5,
      duration: motionDuration(600),
    })
  }

  useImperativeHandle(forwardedRef, () => ({ fitAircraft, centerReceiver }))

  useEffect(() => {
    if (!containerRef.current) return
    let map: MapLibreMap
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: MAP_STYLE_URL,
        center: [
          receiverRef.current?.longitude ?? DEFAULT_RECEIVER.longitude,
          receiverRef.current?.latitude ?? DEFAULT_RECEIVER.latitude,
        ],
        zoom: 7.7,
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
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: '© OpenFreeMap · © OpenMapTiles · © OpenStreetMap',
      }),
      'bottom-left',
    )
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left')

    map.on('error', (event) => {
      if (!map.isStyleLoaded()) setMapError(event.error?.message ?? 'Map tiles are unavailable')
    })
    map.on('style.load', () => {
      for (const [name, colour] of Object.entries(AIRCRAFT_COLOURS)) {
        const id = `aircraft-${name}`
        if (!map.hasImage(id)) map.addImage(id, planeImage(colour), { pixelRatio: 2 })
      }

      map.addSource(RINGS_SOURCE, { type: 'geojson', data: ringData(receiverRef.current) })
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

      map.addSource(TRACK_SOURCE, { type: 'geojson', data: trackData(tracksRef.current) })
      map.addLayer({
        id: 'history-track-shadow',
        type: 'line',
        source: TRACK_SOURCE,
        paint: { 'line-color': '#020406', 'line-width': 5, 'line-opacity': 0.5 },
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
        data: liveAircraftData(aircraftRef.current, selectedIcaoRef.current),
      })
      map.addLayer({
        id: 'aircraft-watched-halo',
        type: 'circle',
        source: AIRCRAFT_SOURCE,
        filter: ['==', ['get', 'watched'], 1],
        paint: {
          'circle-radius': 15,
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
          'circle-radius': 18,
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
          'circle-radius': 18,
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
          'icon-size': ['case', ['==', ['get', 'selected'], 1], 1.2, 0.92],
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
          'text-size': 13,
          'text-offset': [0, 2.1],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': '#d7e3eb',
          'text-halo-color': '#091015',
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
          'text-size': 14,
          'text-offset': [0, 2.2],
          'text-anchor': 'top',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#071014',
          'text-halo-width': 1.5,
        },
      })

      const selectAircraft = (event: maplibregl.MapMouseEvent) => {
        const feature = map.queryRenderedFeatures(event.point, { layers: ['aircraft-icons'] })[0]
        const icao = feature?.properties?.icao
        if (typeof icao === 'string') onSelectRef.current?.(icao)
      }
      map.on('click', 'aircraft-icons', selectAircraft)
      map.on('mouseenter', 'aircraft-icons', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'aircraft-icons', () => {
        map.getCanvas().style.cursor = ''
      })
      setMapError(null)
      setMapReady(true)
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, AIRCRAFT_SOURCE, liveAircraftData(aircraft, selectedIcao))
  }, [aircraft, selectedIcao, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, RECEIVER_SOURCE, receiverData(receiver))
    setSourceData(mapRef.current, RINGS_SOURCE, ringData(receiver))
  }, [receiver, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, TRACK_SOURCE, trackData(tracks))
  }, [tracks, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    setSourceData(mapRef.current, REPLAY_SOURCE, replayData(tracks, replayTime))
  }, [tracks, replayTime, mapReady])

  useEffect(() => {
    if (!mapReady || !mapRef.current || !selectedIcao) return
    const selected = aircraftRef.current.find((item) => item.icao === selectedIcao)
    if (selected?.longitude != null && selected.latitude != null) {
      mapRef.current.easeTo({
        center: [selected.longitude, selected.latitude],
        zoom: Math.max(mapRef.current.getZoom(), 9),
        duration: motionDuration(450),
      })
    }
  }, [selectedIcao, mapReady])

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
        role="img"
        aria-label="Interactive aircraft radar map. Use the adjacent controls to zoom and centre the view."
      />
      <div className="map-controls" aria-label="Map controls">
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
          <Plus size={17} />
        </button>
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
          <Minus size={17} />
        </button>
        <button type="button" title="Centre receiver" aria-label="Centre receiver" onClick={centerReceiver}>
          <LocateFixed size={17} />
        </button>
        <button type="button" title="Fit active aircraft" aria-label="Fit active aircraft" onClick={fitAircraft}>
          <Maximize2 size={17} />
        </button>
      </div>
      <div className="map-legend" aria-label="Altitude colour legend">
        <span>GND</span>
        <i />
        <span>10k</span>
        <span>20k</span>
        <span>30k</span>
        <span>40k+</span>
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
