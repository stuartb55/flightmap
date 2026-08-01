import type { InsightMetrics, InsightSeriesPoint } from "@flightmap/shared";

export const COVERAGE_GRID_DEGREES = 0.05;

export type CoverageGridCell = {
  latitudeIndex: number;
  longitudeIndex: number;
  south: number;
  west: number;
  north: number;
  east: number;
  latitude: number;
  longitude: number;
};

function boundedIndex(value: number, offset: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, Math.floor((value + offset) / COVERAGE_GRID_DEGREES)));
}

export function coverageGridCell(latitude: number, longitude: number): CoverageGridCell {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError("latitude must be between -90 and 90");
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError("longitude must be between -180 and 180");
  }
  const latitudeIndex = boundedIndex(latitude, 90, 3599);
  const longitudeIndex = boundedIndex(longitude, 180, 7199);
  const south = -90 + latitudeIndex * COVERAGE_GRID_DEGREES;
  const west = -180 + longitudeIndex * COVERAGE_GRID_DEGREES;
  const north = Math.min(90, south + COVERAGE_GRID_DEGREES);
  const east = Math.min(180, west + COVERAGE_GRID_DEGREES);
  return {
    latitudeIndex,
    longitudeIndex,
    south,
    west,
    north,
    east,
    latitude: (south + north) / 2,
    longitude: (west + east) / 2
  };
}

export function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function utcHour(value: Date): string {
  const result = new Date(value);
  result.setUTCMinutes(0, 0, 0);
  return result.toISOString();
}

const insightMetricKeys = [
  "uniqueAircraft",
  "sessions",
  "reports",
  "positionedReports",
  "maximumRangeNm",
  "maximumAltitudeFt"
] as const satisfies readonly (keyof InsightMetrics)[];

export function insightMetricChanges(
  current: InsightMetrics,
  previous: InsightMetrics
): Record<string, { absolute: number | null; percent: number | null }> {
  return Object.fromEntries(
    insightMetricKeys.map((key) => {
      const currentValue = current[key];
      const previousValue = previous[key];
      if (currentValue === null || previousValue === null) {
        return [key, { absolute: null, percent: null }];
      }
      const absolute = currentValue - previousValue;
      return [
        key,
        {
          absolute,
          percent: previousValue === 0 ? null : (absolute / previousValue) * 100
        }
      ];
    })
  );
}

export type ReceiverBucketAggregate = {
  samples: number;
  availableSamples: number;
  messageRatePerSecond: number | null;
  rejectedRecords: number | null;
};

export function receiverPerformanceForBucket(
  bucketStart: Date,
  bucketEnd: Date,
  rangeFrom: Date,
  rangeTo: Date,
  retainedFrom: Date,
  intervalMs: number,
  aggregate?: ReceiverBucketAggregate
): Pick<
  InsightSeriesPoint,
  | "messageRatePerSecond"
  | "receiverAvailabilityPercent"
  | "rejectedRecords"
  | "dataGapMinutes"
> {
  const eligibleStart = Math.max(
    bucketStart.getTime(),
    rangeFrom.getTime(),
    retainedFrom.getTime()
  );
  const eligibleEnd = Math.min(bucketEnd.getTime(), rangeTo.getTime());
  if (eligibleEnd <= eligibleStart) {
    return {
      messageRatePerSecond: null,
      receiverAvailabilityPercent: null,
      rejectedRecords: null,
      dataGapMinutes: null
    };
  }
  const expectedSamples = Math.max(
    1,
    Math.ceil((eligibleEnd - eligibleStart) / intervalMs)
  );
  const receivedSamples = Math.min(expectedSamples, aggregate?.samples ?? 0);
  const availableSamples = Math.min(
    expectedSamples,
    aggregate?.availableSamples ?? 0
  );
  return {
    messageRatePerSecond: aggregate?.messageRatePerSecond ?? null,
    receiverAvailabilityPercent: (availableSamples / expectedSamples) * 100,
    rejectedRecords: aggregate?.rejectedRecords ?? null,
    dataGapMinutes: Math.ceil(
      ((expectedSamples - receivedSamples) * intervalMs) / 60_000
    )
  };
}
