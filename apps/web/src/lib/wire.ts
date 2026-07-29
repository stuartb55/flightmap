import type {
  AircraftMetadata,
  AlertEvent,
  DailyAircraftSummary,
  LiveAircraft,
  LiveWebSocketMessage,
  ReceiverRealtimeState,
  StatusResponse,
  TrackPoint,
  TrackSession,
} from '@flightmap/shared'

/*
 * The public contract is owned by @flightmap/shared. The aliases keep the
 * view-model adapter names concise without duplicating the transport schema.
 */
export type WireMetadata = AircraftMetadata
export type WireAircraft = LiveAircraft
export type WireReceiver = ReceiverRealtimeState
export type WireAlert = AlertEvent
export type WireSession = TrackSession
export type WireTrackPoint = TrackPoint
export type WireDailySummary = DailyAircraftSummary
export type WireStatus = StatusResponse
export type WireLiveMessage = LiveWebSocketMessage
