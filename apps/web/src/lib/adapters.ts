import { DEFAULT_RECEIVER } from '../config'
import type {
  Aircraft,
  AircraftDetail,
  AircraftMetadata,
  AlertEvent,
  HistoricalSummary,
  LiveMessage,
  LiveSnapshot,
  Receiver,
  SessionSummary,
  SystemStatus,
  TrackPoint,
  TrackResponse,
  WatchlistEntry,
} from '../types'
import type {
  WireAircraft,
  WireAlert,
  WireDailySummary,
  WireLiveMessage,
  WireMetadata,
  WireReceiver,
  WireSession,
  WireStatus,
  WireTrackPoint,
} from './wire'

export function adaptMetadata(metadata: WireMetadata | null | undefined): AircraftMetadata | null {
  if (!metadata) return null
  return {
    registration: metadata.registration,
    typeCode: metadata.typeCode,
    description: metadata.description,
    operator: metadata.operator,
    owner: metadata.owner,
    country: metadata.country,
  }
}

export function adaptAircraft(item: WireAircraft): Aircraft {
  return {
    icao: item.icao.toLowerCase(),
    callsign: item.callsign,
    registration: item.metadata?.registration ?? null,
    typeCode: item.metadata?.typeCode ?? null,
    description: item.metadata?.description ?? null,
    operator: item.metadata?.operator ?? null,
    country: item.metadata?.country ?? null,
    latitude: item.latitude,
    longitude: item.longitude,
    altitudeBaro: item.onGround ? 'ground' : item.altitudeBarometricFt,
    altitudeGeom: item.altitudeGeometricFt,
    groundSpeed: item.groundSpeedKt,
    indicatedAirspeed: item.indicatedAirSpeedKt,
    trueAirspeed: item.trueAirSpeedKt,
    mach: item.mach,
    track: item.trackDeg,
    trueHeading: item.trueHeadingDeg,
    magneticHeading: item.magneticHeadingDeg,
    verticalRate: item.barometricRateFpm,
    geometricVerticalRate: item.geometricRateFpm,
    squawk: item.squawk,
    emergency: item.emergency,
    category: item.category,
    source: item.source,
    rssi: item.rssiDbfs,
    messages: item.messages,
    seenSeconds: item.seenSeconds,
    seenPositionSeconds: item.seenPositionSeconds,
    distanceNm: item.distanceNm,
    bearing: item.bearingDeg,
    navigation: {
      altitude: item.navigation.altitudeMcpFt ?? item.navigation.altitudeFmsFt,
      heading: item.navigation.headingDeg,
      qnh: item.navigation.qnhHpa,
    },
    quality: item.quality,
    sessionId: item.sessionId,
    watched: item.watched,
    hasActiveAlert: item.hasActiveAlert,
    firstSeenAt: null,
    lastSeenAt: item.recordedAt,
  }
}

export function adaptReceiver(receiver: WireReceiver): Receiver {
  return {
    status: receiver.health === 'unknown' ? 'connecting' : receiver.health,
    latitude: receiver.latitude ?? DEFAULT_RECEIVER.latitude,
    longitude: receiver.longitude ?? DEFAULT_RECEIVER.longitude,
    name: DEFAULT_RECEIVER.name,
    version: receiver.version,
    lastSnapshotAt: receiver.lastSnapshotAt,
    latencyMs:
      receiver.snapshotAgeSeconds == null ? null : Math.max(0, receiver.snapshotAgeSeconds * 1_000),
    messageRate: receiver.messageRatePerSecond,
  }
}

export function adaptAlert(alert: WireAlert): AlertEvent {
  const type = alert.rule === 'watchlist' ? 'watchlist' : 'emergency'
  const title =
    alert.rule === 'watchlist'
      ? 'Watchlist aircraft detected'
      : alert.rule === 'emergency_squawk'
        ? `Emergency squawk${alert.state ? ` ${alert.state}` : ''}`
        : 'Emergency state reported'
  return {
    id: alert.id,
    type,
    createdAt: alert.occurredAt,
    icao: alert.icao.toLowerCase(),
    callsign: alert.callsign,
    title,
    message: alert.message,
    dismissedAt: alert.dismissedAt,
    severity: type === 'emergency' ? 'critical' : type === 'watchlist' ? 'warning' : 'info',
  }
}

export function adaptSession(session: WireSession): SessionSummary {
  return {
    id: session.id,
    icao: session.icao.toLowerCase(),
    callsigns: session.callsigns,
    registration: session.metadata?.registration ?? null,
    typeCode: session.metadata?.typeCode ?? null,
    operator: session.metadata?.operator ?? null,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    sampleCount: session.sampleCount,
    minimumAltitudeFt: session.minimumAltitudeFt,
    maximumAltitudeFt: session.maximumAltitudeFt,
    maximumSpeedKt: session.maximumGroundSpeedKt,
    closestDistanceNm: session.closestRangeNm,
    hasDetailedTrack: session.detailedTrackAvailable,
    alertKinds: [
      ...new Set(
        session.alertRules.map((rule) =>
          rule === 'watchlist' ? 'watchlist' : 'emergency',
        ),
      ),
    ],
  }
}

export function adaptTrackPoint(point: WireTrackPoint): TrackPoint {
  return {
    recordedAt: point.recordedAt,
    latitude: point.latitude,
    longitude: point.longitude,
    altitudeFt: point.onGround ? 0 : (point.altitudeBarometricFt ?? point.altitudeGeometricFt),
    groundSpeedKt: point.groundSpeedKt,
    trackDegrees: point.trackDeg,
  }
}

export function adaptTrack(response: {
  session: WireSession
  resolution: TrackResponse['resolution']
  points: WireTrackPoint[]
  truncated: boolean
}): TrackResponse {
  return {
    session: adaptSession(response.session),
    resolution: response.resolution,
    points: response.points.map(adaptTrackPoint),
    truncated: response.truncated,
  }
}

export function adaptSummary(summary: WireDailySummary): HistoricalSummary {
  return {
    id: `${summary.icao}-${summary.date}`,
    date: summary.date,
    icao: summary.icao.toLowerCase(),
    callsigns: summary.callsigns,
    registration: summary.metadata?.registration ?? null,
    typeCode: summary.metadata?.typeCode ?? null,
    operator: summary.metadata?.operator ?? null,
    observationCount: summary.observations,
    sessionCount: summary.sessionCount,
    minimumAltitudeFt: summary.minimumAltitudeFt,
    maximumAltitudeFt: summary.maximumAltitudeFt,
    closestDistanceNm: summary.closestRangeNm,
    hasDetailedTrack: summary.detailedTrackAvailable,
  }
}

export function adaptSnapshot(response: {
  sequence: number
  generatedAt: string
  receiver: WireReceiver
  aircraft: WireAircraft[]
}): LiveSnapshot {
  return {
    sequence: response.sequence,
    generatedAt: response.generatedAt,
    receiver: adaptReceiver(response.receiver),
    aircraft: response.aircraft.map(adaptAircraft),
  }
}

export function adaptAircraftDetail(response: {
  aircraft: WireAircraft | null
  metadata: WireMetadata | null
  summary: {
    firstSeenAt: string
    lastSeenAt: string
    totalObservations: number
    sessionCount: number
    closestRangeNm: number | null
  } | null
  recentSessions: WireSession[]
  alerts: WireAlert[]
}): AircraftDetail {
  return {
    aircraft: response.aircraft ? adaptAircraft(response.aircraft) : null,
    metadata: adaptMetadata(response.metadata),
    summary: response.summary
      ? {
          firstSeenAt: response.summary.firstSeenAt,
          lastSeenAt: response.summary.lastSeenAt,
          observationCount: response.summary.totalObservations,
          sessionCount: response.summary.sessionCount,
          closestDistanceNm: response.summary.closestRangeNm,
        }
      : null,
    recentSessions: response.recentSessions.map(adaptSession),
    alerts: response.alerts.map(adaptAlert),
  }
}

export function adaptStatus(response: WireStatus): SystemStatus {
  return {
    overall:
      response.status === 'unavailable' ? 'offline' : response.status === 'degraded' ? 'degraded' : 'ok',
    version: response.application.version,
    receiver: {
      status: response.receiver.health === 'unknown' ? 'connecting' : response.receiver.health,
      url: null,
      lastAircraftPollAt: response.receiver.lastAircraftPollAt,
      lastStatsPollAt: response.receiver.lastStatsPollAt,
      latencyMs:
        response.receiver.snapshotAgeSeconds == null
          ? null
          : Math.max(0, response.receiver.snapshotAgeSeconds * 1_000),
      software: response.receiver.version,
    },
    collector: {
      status: response.receiver.health,
      pollIntervalMs: response.receiver.configuredPollIntervalMs,
      snapshotRate: response.receiver.snapshotRatePerSecond,
      aircraftRate: response.receiver.messageRatePerSecond,
      rejectedRecords: response.receiver.rejectedRecords,
      lastError: response.receiver.lastError,
    },
    database: {
      status: response.database.healthy ? 'ok' : 'error',
      sizeBytes: response.database.sizeBytes,
      capacityBytes: response.database.capacityBytes,
      usePercent: response.database.usePercent,
      oldestSampleAt: response.database.oldestSampleAt,
      newestSampleAt: response.database.newestSampleAt,
      retainedDays: response.retention.days,
    },
    metadata: {
      status: response.metadata.lastError ? 'error' : response.metadata.importedAt ? 'ok' : 'degraded',
      updatedAt: response.metadata.importedAt,
      version: response.metadata.version,
      rowCount: response.metadata.rowCount,
      nextUpdateAt: response.metadata.nextCheckAt,
      lastError: response.metadata.lastError,
    },
    uptimeSeconds: response.application.uptimeSeconds,
  }
}

export function adaptWatchlist(entry: {
  icao: string
  label: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}): WatchlistEntry {
  return {
    icao: entry.icao.toLowerCase(),
    label: entry.label,
    notes: entry.notes,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

export function adaptLiveMessage(message: WireLiveMessage): LiveMessage {
  if (message.type !== 'delta') return message
  return {
    ...message,
    upserts: message.upserts.map(adaptAircraft),
    receiver: message.receiver ? adaptReceiver(message.receiver) : undefined,
    alerts: message.alerts.map(adaptAlert),
  }
}
