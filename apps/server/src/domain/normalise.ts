import {
  receiverAircraftSchema,
  receiverAircraftSnapshotSchema,
  type LiveAircraft,
  type ReceiverAircraft
} from "@flightmap/shared";
import { calculateRangeAndBearing } from "./geo.js";

export type NormalisedSnapshot = {
  recordedAt: Date;
  receiverMessages: number;
  aircraft: LiveAircraft[];
  rejectedRecords: number;
};

export class SnapshotValidationError extends Error {
  readonly issues: unknown;

  constructor(message: string, issues: unknown) {
    super(message);
    this.name = "SnapshotValidationError";
    this.issues = issues;
  }
}

function nullable(value: number | null | undefined): number | null {
  return value ?? null;
}

function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function normaliseSquawk(
  value: string | number | null | undefined
): string | null {
  if (value === undefined || value === null) return null;
  const squawk = String(value).trim();
  if (!/^\d{1,4}$/.test(squawk)) return null;
  return squawk.padStart(4, "0");
}

function sourceFor(record: ReceiverAircraft): LiveAircraft["source"] {
  const type = record.type?.toLowerCase() ?? "";
  if (type.startsWith("adsb")) return "adsb";
  if (type.startsWith("adsr")) return "adsr";
  if (type.startsWith("tisb") || (record.tisb?.length ?? 0) > 0) return "tisb";
  if (type === "mlat" || (record.mlat?.length ?? 0) > 0) return "mlat";
  if (type.startsWith("adsc")) return "adsc";
  if (type === "mode_s" || type === "mode_ac") return "mode_s";
  // Some dump1090-fa payloads omit the readsb `type` field but retain
  // indicators that can only have been decoded from ADS-B messages.
  if (
    [
      record.version,
      record.category,
      record.nic,
      record.nic_baro,
      record.nac_p,
      record.nac_v,
      record.sil,
      record.gva,
      record.sda
    ].some((value) => value !== null && value !== undefined)
  ) {
    return "adsb";
  }
  return "unknown";
}

export type NormaliseOptions = {
  receiverLatitude: number | null;
  receiverLongitude: number | null;
  staleAfterSeconds?: number;
};

export function normaliseAircraft(
  record: ReceiverAircraft,
  recordedAt: Date,
  options: NormaliseOptions
): LiveAircraft {
  const hasPosition =
    typeof record.lat === "number" && typeof record.lon === "number";
  const relative =
    hasPosition &&
    options.receiverLatitude !== null &&
    options.receiverLongitude !== null
      ? calculateRangeAndBearing(
          options.receiverLatitude,
          options.receiverLongitude,
          record.lat as number,
          record.lon as number
        )
      : null;
  const onGround = record.alt_baro === "ground";
  const staleAfterSeconds = options.staleAfterSeconds ?? 15;

  return {
    icao: record.hex.toLowerCase(),
    recordedAt: recordedAt.toISOString(),
    callsign: cleanText(record.flight),
    latitude: record.lat ?? null,
    longitude: record.lon ?? null,
    altitudeBarometricFt:
      typeof record.alt_baro === "number" ? record.alt_baro : null,
    altitudeGeometricFt: nullable(record.alt_geom),
    onGround,
    groundSpeedKt: nullable(record.gs),
    indicatedAirSpeedKt: nullable(record.ias),
    trueAirSpeedKt: nullable(record.tas),
    mach: nullable(record.mach),
    trackDeg: nullable(record.track),
    trackRateDegPerSec: nullable(record.track_rate),
    rollDeg: nullable(record.roll),
    magneticHeadingDeg: nullable(record.mag_heading),
    trueHeadingDeg: nullable(record.true_heading),
    barometricRateFpm: nullable(record.baro_rate),
    geometricRateFpm: nullable(record.geom_rate),
    squawk: normaliseSquawk(record.squawk),
    emergency: cleanText(record.emergency)?.toLowerCase() ?? null,
    category: cleanText(record.category),
    rssiDbfs: nullable(record.rssi),
    messages: record.messages ?? null,
    seenSeconds: nullable(record.seen),
    seenPositionSeconds: nullable(record.seen_pos),
    navigation: {
      altitudeMcpFt: nullable(record.nav_altitude_mcp),
      altitudeFmsFt: nullable(record.nav_altitude_fms),
      headingDeg: nullable(record.nav_heading),
      qnhHpa: nullable(record.nav_qnh),
      modes: record.nav_modes ?? []
    },
    quality: {
      nic: nullable(record.nic),
      nicBaro: nullable(record.nic_baro),
      nacP: nullable(record.nac_p),
      nacV: nullable(record.nac_v),
      sil: nullable(record.sil),
      silType: cleanText(record.sil_type),
      gva: nullable(record.gva),
      sda: nullable(record.sda),
      rcMetres: nullable(record.rc),
      adsbVersion: nullable(record.version)
    },
    source: sourceFor(record),
    distanceNm: relative?.distanceNm ?? null,
    bearingDeg: relative?.bearingDeg ?? null,
    sessionId: null,
    stale: (record.seen ?? 0) > staleAfterSeconds,
    watched: false,
    hasActiveAlert: false,
    metadata: null
  };
}

export function normaliseSnapshot(
  payload: unknown,
  options: NormaliseOptions
): NormalisedSnapshot {
  const snapshotResult = receiverAircraftSnapshotSchema.safeParse(payload);
  if (!snapshotResult.success) {
    throw new SnapshotValidationError(
      "Malformed receiver snapshot",
      snapshotResult.error.issues
    );
  }

  const recordedAt = new Date(snapshotResult.data.now * 1000);
  if (Number.isNaN(recordedAt.getTime())) {
    throw new SnapshotValidationError("Invalid receiver timestamp", []);
  }

  const aircraft: LiveAircraft[] = [];
  let rejectedRecords = 0;
  for (const rawRecord of snapshotResult.data.aircraft) {
    const recordResult = receiverAircraftSchema.safeParse(rawRecord);
    if (!recordResult.success) {
      rejectedRecords += 1;
      continue;
    }
    aircraft.push(normaliseAircraft(recordResult.data, recordedAt, options));
  }

  return {
    recordedAt,
    receiverMessages: snapshotResult.data.messages,
    aircraft,
    rejectedRecords
  };
}
