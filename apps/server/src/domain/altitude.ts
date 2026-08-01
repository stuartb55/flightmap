export const HIGH_ALTITUDE_CONFIRMATION_FT = 60_000;

const MINIMUM_ANALYTICAL_ALTITUDE_FT = -2_000;
const MAXIMUM_ANALYTICAL_ALTITUDE_FT = 130_000;
const MAXIMUM_BAROMETRIC_GEOMETRIC_DIFFERENCE_FT = 5_000;
const MAXIMUM_NAVIGATION_DIFFERENCE_FT = 20_000;
const MAXIMUM_CONTINUITY_GAP_SECONDS = 30;
const ALTITUDE_JUMP_ALLOWANCE_FT = 1_000;
const MAXIMUM_VERTICAL_RATE_FPM = 15_000;

export type AltitudeReport = {
  recordedAt: string;
  altitudeBarometricFt: number | null;
  altitudeGeometricFt: number | null;
  barometricRateFpm?: number | null;
  geometricRateFpm?: number | null;
  navigation?: {
    altitudeMcpFt: number | null;
    altitudeFmsFt: number | null;
  };
};

export type PreviousAltitudeReport = AltitudeReport & {
  analyticalAltitudeFt: number | null;
};

function finite(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? value
    : null;
}

function agreeingSources(report: AltitudeReport): boolean {
  const barometric = finite(report.altitudeBarometricFt);
  const geometric = finite(report.altitudeGeometricFt);
  return (
    barometric !== null &&
    geometric !== null &&
    Math.abs(barometric - geometric) <=
      MAXIMUM_BAROMETRIC_GEOMETRIC_DIFFERENCE_FT
  );
}

function reportedAltitude(report: AltitudeReport): number | null {
  const barometric = finite(report.altitudeBarometricFt);
  const geometric = finite(report.altitudeGeometricFt);
  if (barometric === null) return geometric;
  if (geometric === null) return barometric;
  if (agreeingSources(report)) return barometric;
  return null;
}

function continuityAllowanceFt(
  elapsedSeconds: number,
  current: AltitudeReport
): number {
  const reportedRate = Math.max(
    Math.abs(finite(current.barometricRateFpm) ?? 0),
    Math.abs(finite(current.geometricRateFpm) ?? 0)
  );
  const rate = Math.min(
    MAXIMUM_VERTICAL_RATE_FPM,
    Math.max(MAXIMUM_VERTICAL_RATE_FPM / 2, reportedRate)
  );
  return ALTITUDE_JUMP_ALLOWANCE_FT + (rate * elapsedSeconds) / 60;
}

function contradictsNavigationTarget(
  report: AltitudeReport,
  altitudeFt: number
): boolean {
  const targets = [
    finite(report.navigation?.altitudeMcpFt),
    finite(report.navigation?.altitudeFmsFt)
  ].filter((value): value is number => value !== null);
  return targets.some(
    (target) =>
      target <= HIGH_ALTITUDE_CONFIRMATION_FT &&
      altitudeFt - target > MAXIMUM_NAVIGATION_DIFFERENCE_FT
  );
}

/**
 * Returns the altitude that may contribute to analytical extrema. Raw receiver
 * values remain untouched; this only prevents isolated or internally
 * contradictory decodes from permanently poisoning maximum-altitude rollups.
 */
export function analyticalAltitudeFt(
  current: AltitudeReport,
  previous: PreviousAltitudeReport | null
): number | null {
  const previousReference = previous
    ? finite(previous.analyticalAltitudeFt) ?? reportedAltitude(previous)
    : null;
  const altitude = reportedAltitude(current);
  if (
    altitude === null ||
    altitude < MINIMUM_ANALYTICAL_ALTITUDE_FT ||
    altitude > MAXIMUM_ANALYTICAL_ALTITUDE_FT
  ) {
    return null;
  }

  const elapsedSeconds = previous
    ? (Date.parse(current.recordedAt) - Date.parse(previous.recordedAt)) / 1_000
    : Number.NaN;
  const hasRecentReference =
    previousReference !== null &&
    Number.isFinite(elapsedSeconds) &&
    elapsedSeconds > 0 &&
    elapsedSeconds <= MAXIMUM_CONTINUITY_GAP_SECONDS;
  const continuous =
    hasRecentReference &&
    Math.abs(altitude - previousReference) <=
      continuityAllowanceFt(elapsedSeconds, current);

  if (altitude > HIGH_ALTITUDE_CONFIRMATION_FT) {
    if (!agreeingSources(current) || !continuous) return null;
    if (contradictsNavigationTarget(current, altitude)) return null;
    return altitude;
  }

  if (
    previous?.analyticalAltitudeFt !== null &&
    previous?.analyticalAltitudeFt !== undefined &&
    hasRecentReference &&
    !continuous
  ) {
    return null;
  }
  return altitude;
}
