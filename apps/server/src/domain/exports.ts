import type {
  InsightCoverageResponse,
  InsightOverview,
  TrackResponse
} from "@flightmap/shared";

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]|^\s|\s$/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

export function csvDocument(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>
): string {
  return `${[columns, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}

export const insightExportColumns = [
  "bucket_start_utc",
  "bucket_end_utc",
  "unique_aircraft",
  "sessions",
  "reports",
  "positioned_reports",
  "maximum_range_nm",
  "maximum_altitude_ft",
  "message_rate_per_second",
  "receiver_availability_percent",
  "rejected_records",
  "data_gap_minutes"
] as const;

export function insightSeriesCsv(overview: InsightOverview): string {
  return csvDocument(
    insightExportColumns,
    overview.series.map((point) => [
      point.bucketStart,
      point.bucketEnd,
      point.uniqueAircraft,
      point.sessions,
      point.reports,
      point.positionedReports,
      point.maximumRangeNm,
      point.maximumAltitudeFt,
      point.messageRatePerSecond,
      point.receiverAvailabilityPercent,
      point.rejectedRecords,
      point.dataGapMinutes
    ])
  );
}

export const sessionExportColumns = [
  "recorded_at_utc",
  "icao",
  "session_id",
  "callsign",
  "latitude",
  "longitude",
  "altitude_ft",
  "ground_speed_kt",
  "track_degrees"
] as const;

export function sessionTelemetryCsv(track: TrackResponse): string {
  const callsign = track.session.callsigns[0] ?? null;
  return csvDocument(
    sessionExportColumns,
    track.points.map((point) => [
      point.recordedAt,
      track.session.icao,
      track.session.id,
      callsign,
      point.latitude,
      point.longitude,
      point.altitudeBarometricFt,
      point.groundSpeedKt,
      point.trackDeg
    ])
  );
}

export function sessionTrackGeoJson(track: TrackResponse): object {
  const coordinates = track.points.map((point) => [
    point.longitude,
    point.latitude,
    ...(point.altitudeBarometricFt === null ? [] : [point.altitudeBarometricFt])
  ]);
  const geometry = coordinates.length >= 2
    ? { type: "LineString", coordinates }
    : coordinates.length === 1
      ? { type: "Point", coordinates: coordinates[0] }
      : null;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: track.session.id,
        properties: {
          session_id: track.session.id,
          icao: track.session.icao,
          callsigns: track.session.callsigns,
          registration: track.session.metadata?.registration ?? null,
          type_code: track.session.metadata?.typeCode ?? null,
          operator: track.session.metadata?.operator ?? null,
          started_at_utc: track.session.startedAt,
          ended_at_utc: track.session.endedAt,
          resolution: track.resolution,
          point_count: track.points.length,
          truncated: track.truncated
        },
        geometry
      }
    ]
  };
}

export function coverageGeoJson(coverage: InsightCoverageResponse): object {
  return {
    type: "FeatureCollection",
    properties: {
      from_utc: coverage.from,
      to_utc: coverage.to,
      truncated: coverage.truncated
    },
    features: coverage.cells.map((cell, index) => ({
      type: "Feature",
      id: index,
      properties: {
        reports: cell.reports,
        unique_aircraft: cell.uniqueAircraft,
        maximum_altitude_ft: cell.maximumAltitudeFt
      },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [cell.west, cell.south],
          [cell.east, cell.south],
          [cell.east, cell.north],
          [cell.west, cell.north],
          [cell.west, cell.south]
        ]]
      }
    }))
  };
}

export function exportDateToken(value: string): string {
  return new Date(value).toISOString().replaceAll(/[:.]/g, "-");
}
