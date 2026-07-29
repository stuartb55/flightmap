import type { LiveAircraft } from "@flightmap/shared";

export type PreviousSessionState = {
  id: string;
  lastPositionAt: Date;
};

export type SessionDecision =
  | {
      kind: "none";
    }
  | {
      kind: "continue";
      sessionId: string;
    }
  | {
      kind: "start";
      closeSessionId: string | null;
    };

export function decideSession(
  aircraft: Pick<LiveAircraft, "latitude" | "longitude">,
  recordedAt: Date,
  previous: PreviousSessionState | null,
  gapSeconds = 300
): SessionDecision {
  if (aircraft.latitude === null || aircraft.longitude === null) {
    return { kind: "none" };
  }
  if (!previous) {
    return { kind: "start", closeSessionId: null };
  }
  const gapMs = recordedAt.getTime() - previous.lastPositionAt.getTime();
  if (gapMs > gapSeconds * 1000) {
    return { kind: "start", closeSessionId: previous.id };
  }
  return { kind: "continue", sessionId: previous.id };
}

function minimum(
  previous: number | null,
  next: number | null
): number | null {
  if (next === null) return previous;
  if (previous === null) return next;
  return Math.min(previous, next);
}

function maximum(
  previous: number | null,
  next: number | null
): number | null {
  if (next === null) return previous;
  if (previous === null) return next;
  return Math.max(previous, next);
}

export type SessionAggregate = {
  callsigns: string[];
  sampleCount: number;
  minimumAltitudeFt: number | null;
  maximumAltitudeFt: number | null;
  minimumGroundSpeedKt: number | null;
  maximumGroundSpeedKt: number | null;
  closestRangeNm: number | null;
};

export function aggregateSessionSample(
  aggregate: SessionAggregate,
  aircraft: LiveAircraft
): SessionAggregate {
  const altitude =
    aircraft.altitudeBarometricFt ?? aircraft.altitudeGeometricFt;
  return {
    callsigns:
      aircraft.callsign && !aggregate.callsigns.includes(aircraft.callsign)
        ? [...aggregate.callsigns, aircraft.callsign]
        : aggregate.callsigns,
    sampleCount: aggregate.sampleCount + 1,
    minimumAltitudeFt: minimum(aggregate.minimumAltitudeFt, altitude),
    maximumAltitudeFt: maximum(aggregate.maximumAltitudeFt, altitude),
    minimumGroundSpeedKt: minimum(
      aggregate.minimumGroundSpeedKt,
      aircraft.groundSpeedKt
    ),
    maximumGroundSpeedKt: maximum(
      aggregate.maximumGroundSpeedKt,
      aircraft.groundSpeedKt
    ),
    closestRangeNm: minimum(aggregate.closestRangeNm, aircraft.distanceNm)
  };
}
