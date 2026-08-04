import type { MapWaypoint } from '@flightmap/shared'
export type ReceiverHealth = 'online' | 'degraded' | 'offline' | 'connecting'
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline'
export type Altitude = number | 'ground' | null

export interface AircraftMetadata {
  registration: string | null
  typeCode: string | null
  description: string | null
  operator: string | null
  owner: string | null
  country: string | null
}

export interface NavigationTargets {
  altitude: number | null
  heading: number | null
  qnh: number | null
}

export interface AircraftQuality {
  nic: number | null
  nicBaro: number | null
  nacP: number | null
  nacV: number | null
  sil: number | null
  silType: string | null
  gva: number | null
  sda: number | null
  rcMetres: number | null
  adsbVersion: number | null
}

export interface Aircraft {
  icao: string
  callsign: string | null
  registration: string | null
  typeCode: string | null
  description: string | null
  operator: string | null
  country: string | null
  latitude: number | null
  longitude: number | null
  altitudeBaro: Altitude
  altitudeGeom: number | null
  groundSpeed: number | null
  indicatedAirspeed: number | null
  trueAirspeed: number | null
  mach: number | null
  track: number | null
  trueHeading: number | null
  magneticHeading: number | null
  verticalRate: number | null
  geometricVerticalRate: number | null
  squawk: string | null
  emergency: string | null
  category: string | null
  source: string | null
  rssi: number | null
  messages: number | null
  seenSeconds: number | null
  seenPositionSeconds: number | null
  distanceNm: number | null
  bearing: number | null
  navigation: NavigationTargets
  quality: AircraftQuality
  sessionId: string | null
  watched: boolean
  hasActiveAlert: boolean
  firstSeenAt: string | null
  lastSeenAt: string | null
  trail?: TrackPoint[]
}

export interface Receiver {
  status: ReceiverHealth
  latitude: number
  longitude: number
  name: string
  version: string | null
  lastSnapshotAt: string | null
  latencyMs: number | null
  messageRate: number | null
}

export interface LiveSnapshot {
  sequence: number
  generatedAt: string
  receiver: Receiver
  aircraft: Aircraft[]
}

export type AlertKind = 'emergency' | 'watchlist' | 'custom'

export interface AlertEvent {
  id: string
  type: AlertKind
  createdAt: string
  icao: string
  callsign: string | null
  title: string
  message: string
  dismissedAt: string | null
  severity: 'critical' | 'warning' | 'info'
}

export interface AircraftDetail {
  aircraft: Aircraft | null
  metadata: AircraftMetadata | null
  recentSessions: SessionSummary[]
  alerts: AlertEvent[]
  summary: {
    firstSeenAt: string | null
    lastSeenAt: string | null
    observationCount: number | null
    sessionCount: number | null
    closestDistanceNm: number | null
  } | null
}

export interface SessionSummary {
  id: string
  icao: string
  callsigns: string[]
  registration: string | null
  typeCode: string | null
  operator: string | null
  startedAt: string
  endedAt: string | null
  sampleCount: number
  minimumAltitudeFt: number | null
  maximumAltitudeFt: number | null
  maximumSpeedKt: number | null
  closestDistanceNm: number | null
  hasDetailedTrack: boolean
  alertKinds: AlertKind[]
}

export interface TrackPoint {
  recordedAt: string
  latitude: number
  longitude: number
  altitudeFt: number | null
  groundSpeedKt: number | null
  trackDegrees: number | null
  verticalRateFpm?: number | null
  distanceNm?: number | null
  bearingDegrees?: number | null
}

export interface TrackEvent {
  type: 'session_start' | 'session_end' | 'callsign' | 'squawk' | 'emergency' | 'alert' | 'closest_approach'
  occurredAt: string
  label: string
  value: string | null
  severity: 'info' | 'warning' | 'critical'
}

export interface TrackResponse {
  session: SessionSummary
  resolution: 'auto' | '1s' | '5s' | '15s' | '60s'
  points: TrackPoint[]
  events: TrackEvent[]
  truncated: boolean
}

export interface SessionPage {
  sessions: SessionSummary[]
  nextCursor: string | null
}

export interface HistoricalSummary {
  id: string
  date: string
  icao: string
  callsigns: string[]
  registration: string | null
  typeCode: string | null
  operator: string | null
  observationCount: number
  sessionCount: number
  minimumAltitudeFt: number | null
  maximumAltitudeFt: number | null
  closestDistanceNm: number | null
  hasDetailedTrack: boolean
}

export interface WatchlistEntry {
  icao: string
  label: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface SystemStatus {
  overall: 'ok' | 'degraded' | 'offline'
  version: string | null
  receiver: {
    status: ReceiverHealth
    url: string | null
    lastAircraftPollAt: string | null
    lastStatsPollAt: string | null
    latencyMs: number | null
    software: string | null
  }
  collector: {
    status: string
    pollIntervalMs: number | null
    snapshotRate: number | null
    aircraftRate: number | null
    rejectedRecords: number | null
    lastError: string | null
  }
  database: {
    status: string
    sizeBytes: number | null
    capacityBytes: number | null
    usePercent: number | null
    oldestSampleAt: string | null
    newestSampleAt: string | null
    retainedDays: number | null
  }
  metadata: {
    status: string
    updatedAt: string | null
    version: string | null
    rowCount: number | null
    nextUpdateAt: string | null
    lastError: string | null
  }
  uptimeSeconds: number | null
}

export interface AppSettings {
  receiverBaseUrl: string
  receiverName: string
  receiverLatitude: number | null
  receiverLongitude: number | null
  pollIntervalMs: number
  receiverTimeoutMs: number
  receiverInfoIntervalMs: number
  receiverStatsIntervalMs: number
  displayTimeZone: string
  mapStyleUrl: string
  mapStyleUrlLight: string
  rangeRingsNm: number[]
  /** Configured on the server; the Settings form does not edit these. */
  mapWaypoints?: MapWaypoint[]
  historyRetentionDays: number
  sessionGapSeconds: number
  currentAircraftTtlSeconds: number
  metadataUrl: string
  metadataCheckIntervalMs: number
  metadataTimeoutMs: number
  metadataMinRows: number
  metadataMaxDownloadBytes: number
  metadataMaxUncompressedBytes: number
  databaseVolumeCapacityBytes: number | null
  collectorEnabled: boolean
  maintenanceEnabled: boolean
  metadataUpdatesEnabled: boolean
}

export interface AppSettingsResponse {
  settings: AppSettings
  updatedAt: string | null
}

export interface HistoryFilters {
  query: string
  icao: string
  callsign: string
  registration: string
  type: string
  operator: string
  from: string
  to: string
  alert: '' | 'emergency_squawk' | 'emergency_state' | 'watchlist'
}

export type LiveMessage =
  | { type: 'hello'; sequence: number; generatedAt: string }
  | {
      type: 'delta'
      sequence: number
      generatedAt: string
      upserts: Aircraft[]
      removals: string[]
      receiver?: Receiver
      alerts: AlertEvent[]
    }
  | { type: 'resync_required'; sequence: number; generatedAt: string }
