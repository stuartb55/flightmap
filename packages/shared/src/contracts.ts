import { z } from "zod";

export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const icaoSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{6}$/);
export const nullableFiniteNumberSchema = z.number().finite().nullable();

export const aircraftSourceSchema = z.enum([
  "adsb",
  "adsr",
  "tisb",
  "mlat",
  "mode_s",
  "adsc",
  "unknown"
]);

export const aircraftMetadataSchema = z.object({
  icao: icaoSchema,
  registration: z.string().nullable(),
  typeCode: z.string().nullable(),
  description: z.string().nullable(),
  operator: z.string().nullable(),
  owner: z.string().nullable(),
  country: z.string().nullable()
});

export const qualityIndicatorsSchema = z.object({
  nic: nullableFiniteNumberSchema,
  nicBaro: nullableFiniteNumberSchema,
  nacP: nullableFiniteNumberSchema,
  nacV: nullableFiniteNumberSchema,
  sil: nullableFiniteNumberSchema,
  silType: z.string().nullable(),
  gva: nullableFiniteNumberSchema,
  sda: nullableFiniteNumberSchema,
  rcMetres: nullableFiniteNumberSchema,
  adsbVersion: nullableFiniteNumberSchema
});

export const liveAircraftSchema = z.object({
  icao: icaoSchema,
  recordedAt: isoDateTimeSchema,
  callsign: z.string().nullable(),
  latitude: nullableFiniteNumberSchema,
  longitude: nullableFiniteNumberSchema,
  altitudeBarometricFt: nullableFiniteNumberSchema,
  altitudeGeometricFt: nullableFiniteNumberSchema,
  onGround: z.boolean(),
  groundSpeedKt: nullableFiniteNumberSchema,
  indicatedAirSpeedKt: nullableFiniteNumberSchema,
  trueAirSpeedKt: nullableFiniteNumberSchema,
  mach: nullableFiniteNumberSchema,
  trackDeg: nullableFiniteNumberSchema,
  trackRateDegPerSec: nullableFiniteNumberSchema,
  rollDeg: nullableFiniteNumberSchema,
  magneticHeadingDeg: nullableFiniteNumberSchema,
  trueHeadingDeg: nullableFiniteNumberSchema,
  barometricRateFpm: nullableFiniteNumberSchema,
  geometricRateFpm: nullableFiniteNumberSchema,
  squawk: z.string().nullable(),
  emergency: z.string().nullable(),
  category: z.string().nullable(),
  rssiDbfs: nullableFiniteNumberSchema,
  messages: z.number().int().nonnegative().nullable(),
  seenSeconds: nullableFiniteNumberSchema,
  seenPositionSeconds: nullableFiniteNumberSchema,
  navigation: z.object({
    altitudeMcpFt: nullableFiniteNumberSchema,
    altitudeFmsFt: nullableFiniteNumberSchema,
    headingDeg: nullableFiniteNumberSchema,
    qnhHpa: nullableFiniteNumberSchema,
    modes: z.array(z.string())
  }),
  quality: qualityIndicatorsSchema,
  source: aircraftSourceSchema,
  distanceNm: nullableFiniteNumberSchema,
  bearingDeg: nullableFiniteNumberSchema,
  sessionId: z.string().uuid().nullable(),
  stale: z.boolean(),
  watched: z.boolean(),
  hasActiveAlert: z.boolean(),
  metadata: aircraftMetadataSchema.nullable()
});

export const receiverHealthSchema = z.enum([
  "unknown",
  "online",
  "degraded",
  "offline"
]);

export const receiverRealtimeStateSchema = z.object({
  health: receiverHealthSchema,
  latitude: nullableFiniteNumberSchema,
  longitude: nullableFiniteNumberSchema,
  version: z.string().nullable(),
  advertisedRefreshMs: nullableFiniteNumberSchema,
  lastSnapshotAt: isoDateTimeSchema.nullable(),
  snapshotAgeSeconds: nullableFiniteNumberSchema,
  messageRatePerSecond: nullableFiniteNumberSchema
});

export const aircraftSummarySchema = z.object({
  icao: icaoSchema,
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  totalObservations: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  closestRangeNm: nullableFiniteNumberSchema,
  latestCallsign: z.string().nullable(),
  latestRegistration: z.string().nullable(),
  latestTypeCode: z.string().nullable(),
  latestOperator: z.string().nullable()
});

export const alertRuleSchema = z.enum([
  "emergency_squawk",
  "emergency_state",
  "first_seen",
  "watchlist"
]);

export const dailyAircraftSummarySchema = z.object({
  icao: icaoSchema,
  date: z.string().date(),
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  observations: z.number().int().nonnegative(),
  positionedObservations: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  minimumAltitudeFt: nullableFiniteNumberSchema,
  maximumAltitudeFt: nullableFiniteNumberSchema,
  maximumGroundSpeedKt: nullableFiniteNumberSchema,
  closestRangeNm: nullableFiniteNumberSchema,
  callsigns: z.array(z.string()),
  detailedTrackAvailable: z.boolean(),
  metadata: aircraftMetadataSchema.nullable().optional()
});

export const trackSessionSchema = z.object({
  id: z.string().uuid(),
  icao: icaoSchema,
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.nullable(),
  lastPositionAt: isoDateTimeSchema,
  callsigns: z.array(z.string()),
  sampleCount: z.number().int().nonnegative(),
  minimumAltitudeFt: nullableFiniteNumberSchema,
  maximumAltitudeFt: nullableFiniteNumberSchema,
  minimumGroundSpeedKt: nullableFiniteNumberSchema,
  maximumGroundSpeedKt: nullableFiniteNumberSchema,
  closestRangeNm: nullableFiniteNumberSchema,
  lastLatitude: nullableFiniteNumberSchema,
  lastLongitude: nullableFiniteNumberSchema,
  lastAltitudeFt: nullableFiniteNumberSchema,
  detailedTrackAvailable: z.boolean(),
  metadata: aircraftMetadataSchema.nullable().optional(),
  alertRules: z.array(alertRuleSchema).default([])
});

export const trackPointSchema = z.object({
  recordedAt: isoDateTimeSchema,
  latitude: z.number().finite(),
  longitude: z.number().finite(),
  altitudeBarometricFt: nullableFiniteNumberSchema,
  altitudeGeometricFt: nullableFiniteNumberSchema,
  onGround: z.boolean(),
  groundSpeedKt: nullableFiniteNumberSchema,
  trackDeg: nullableFiniteNumberSchema,
  verticalRateFpm: nullableFiniteNumberSchema,
  distanceNm: nullableFiniteNumberSchema,
  bearingDeg: nullableFiniteNumberSchema
});

export const alertEventSchema = z.object({
  id: z.string().uuid(),
  icao: icaoSchema,
  sessionId: z.string().uuid().nullable(),
  rule: alertRuleSchema,
  state: z.string().nullable(),
  message: z.string(),
  occurredAt: isoDateTimeSchema,
  dismissedAt: isoDateTimeSchema.nullable(),
  callsign: z.string().nullable()
});

export const watchlistEntrySchema = z.object({
  icao: icaoSchema,
  label: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const statusResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "unavailable"]),
  application: z.object({
    version: z.string(),
    startedAt: isoDateTimeSchema,
    uptimeSeconds: z.number().nonnegative()
  }),
  receiver: receiverRealtimeStateSchema.extend({
    lastAircraftPollAt: isoDateTimeSchema.nullable(),
    lastReceiverPollAt: isoDateTimeSchema.nullable(),
    lastStatsPollAt: isoDateTimeSchema.nullable(),
    configuredPollIntervalMs: z.number().int().positive(),
    snapshotRatePerSecond: nullableFiniteNumberSchema,
    lastError: z.string().nullable(),
    rejectedRecords: z.number().int().nonnegative(),
    acceptedSnapshots: z.number().int().nonnegative(),
    duplicateSnapshots: z.number().int().nonnegative(),
    failedPolls: z.number().int().nonnegative()
  }),
  database: z.object({
    healthy: z.boolean(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    capacityBytes: z.number().int().positive().nullable(),
    usePercent: nullableFiniteNumberSchema,
    oldestSampleAt: isoDateTimeSchema.nullable(),
    newestSampleAt: isoDateTimeSchema.nullable()
  }),
  retention: z.object({
    days: z.number().int().positive(),
    cutoffAt: isoDateTimeSchema,
    lastMaintenanceAt: isoDateTimeSchema.nullable()
  }),
  metadata: z.object({
    importedAt: isoDateTimeSchema.nullable(),
    sourceModifiedAt: isoDateTimeSchema.nullable(),
    version: z.string().nullable(),
    rowCount: z.number().int().nonnegative(),
    lastCheckedAt: isoDateTimeSchema.nullable(),
    nextCheckAt: isoDateTimeSchema.nullable(),
    lastError: z.string().nullable()
  })
});

export const liveAircraftResponseSchema = z.object({
  sequence: z.number().int().nonnegative(),
  generatedAt: isoDateTimeSchema,
  receiver: receiverRealtimeStateSchema,
  aircraft: z.array(liveAircraftSchema)
});

export const aircraftDetailResponseSchema = z.object({
  aircraft: liveAircraftSchema.nullable(),
  metadata: aircraftMetadataSchema.nullable(),
  summary: aircraftSummarySchema.nullable(),
  recentSessions: z.array(trackSessionSchema),
  alerts: z.array(alertEventSchema)
});

export const sessionsResponseSchema = z.object({
  items: z.array(trackSessionSchema),
  nextCursor: z.string().nullable()
});

export const trackResponseSchema = z.object({
  session: trackSessionSchema,
  resolution: z.enum(["1s", "5s", "15s", "60s"]),
  points: z.array(trackPointSchema),
  truncated: z.boolean()
});

export const summariesResponseSchema = z.object({
  items: z.array(dailyAircraftSummarySchema),
  nextCursor: z.string().nullable()
});

export const alertsResponseSchema = z.object({
  items: z.array(alertEventSchema),
  nextCursor: z.string().nullable()
});

export const dismissAlertsResponseSchema = z.object({
  items: z.array(alertEventSchema)
});

export const watchlistResponseSchema = z.object({
  items: z.array(watchlistEntrySchema)
});

export const insightBackfillStatusSchema = z.enum([
  "pending",
  "running",
  "complete",
  "failed"
]);

export const insightAvailabilitySchema = z.object({
  hourlyFrom: isoDateTimeSchema.nullable(),
  dailyFrom: z.string().date().nullable(),
  coverageFrom: z.string().date().nullable(),
  detailedTrackFrom: isoDateTimeSchema,
  partial: z.boolean(),
  notices: z.array(z.string()),
  backfill: z.object({
    status: insightBackfillStatusSchema,
    processedDays: z.number().int().nonnegative(),
    totalDays: z.number().int().nonnegative(),
    nextDate: z.string().date().nullable(),
    error: z.string().nullable()
  })
});

export const insightSeriesPointSchema = z.object({
  bucketStart: isoDateTimeSchema,
  bucketEnd: isoDateTimeSchema,
  uniqueAircraft: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  reports: z.number().int().nonnegative(),
  positionedReports: z.number().int().nonnegative(),
  maximumRangeNm: nullableFiniteNumberSchema,
  maximumAltitudeFt: nullableFiniteNumberSchema,
  messageRatePerSecond: nullableFiniteNumberSchema.optional(),
  receiverAvailabilityPercent: nullableFiniteNumberSchema.optional(),
  rejectedRecords: z.number().int().nonnegative().nullable().optional(),
  dataGapMinutes: z.number().int().nonnegative().nullable().optional()
});

export const insightLeaderSchema = z.object({
  key: z.string(),
  label: z.string(),
  secondary: z.string().nullable(),
  reports: z.number().int().nonnegative(),
  positionedReports: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative()
});

export const insightMetricsSchema = z.object({
  uniqueAircraft: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  reports: z.number().int().nonnegative(),
  positionedReports: z.number().int().nonnegative(),
  maximumRangeNm: nullableFiniteNumberSchema,
  maximumAltitudeFt: nullableFiniteNumberSchema
});

export const insightComparisonSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  metrics: insightMetricsSchema,
  changes: z.record(
    z.string(),
    z.object({
      absolute: z.number().finite().nullable(),
      percent: z.number().finite().nullable()
    })
  )
});

export const insightOverviewSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  bucket: z.enum(["hour", "day"]),
  metrics: insightMetricsSchema,
  series: z.array(insightSeriesPointSchema),
  leaders: z.object({
    aircraft: z.array(insightLeaderSchema),
    types: z.array(insightLeaderSchema),
    operators: z.array(insightLeaderSchema)
  }),
  availability: insightAvailabilitySchema,
  comparison: insightComparisonSchema.nullable().optional()
});

export const coverageCellSchema = z.object({
  latitude: z.number().finite(),
  longitude: z.number().finite(),
  south: z.number().finite(),
  west: z.number().finite(),
  north: z.number().finite(),
  east: z.number().finite(),
  reports: z.number().int().nonnegative(),
  uniqueAircraft: z.number().int().nonnegative(),
  maximumAltitudeFt: nullableFiniteNumberSchema
});

export const insightCoverageResponseSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  cells: z.array(coverageCellSchema),
  truncated: z.boolean(),
  availability: insightAvailabilitySchema
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  })
});

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalDateTime = z.preprocess(
  emptyToUndefined,
  isoDateTimeSchema.optional()
);

export const insightQuerySchema = z
  .object({
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    bucket: z.enum(["hour", "day"]),
    compare: z
      .preprocess(emptyToUndefined, z.enum(["true", "false"]).optional())
      .transform((value) => value === "true")
  })
  .superRefine((query, context) => {
    if (Date.parse(query.from) >= Date.parse(query.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "from must be before to"
      });
    }
  });

export const insightCoverageQuerySchema = z
  .object({
    from: isoDateTimeSchema,
    to: isoDateTimeSchema
  })
  .superRefine((query, context) => {
    if (Date.parse(query.from) >= Date.parse(query.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "from must be before to"
      });
    }
  });

export const sessionQuerySchema = z
  .object({
    from: optionalDateTime,
    to: optionalDateTime,
    icao: z.preprocess(emptyToUndefined, icaoSchema.optional()),
    callsign: z.preprocess(emptyToUndefined, z.string().trim().max(16).optional()),
    query: z.preprocess(
      emptyToUndefined,
      z.string().trim().max(128).optional()
    ),
    q: z.preprocess(
      emptyToUndefined,
      z.string().trim().max(128).optional()
    ),
    registration: z.preprocess(
      emptyToUndefined,
      z.string().trim().max(32).optional()
    ),
    type: z.preprocess(emptyToUndefined, z.string().trim().max(16).optional()),
    operator: z.preprocess(emptyToUndefined, z.string().trim().max(128).optional()),
    alert: z.preprocess(
      emptyToUndefined,
      z
        .enum(["any", "active", "emergency", ...alertRuleSchema.options])
        .optional()
    ),
    cursor: z.preprocess(emptyToUndefined, z.string().max(512).optional()),
    limit: z.coerce.number().int().min(1).max(200).default(50)
  })
  .superRefine((query, context) => {
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "from must be before to"
      });
    }
  });

export const trackQuerySchema = z.object({
  resolution: z.enum(["auto", "1s", "5s", "15s", "60s"]).default("auto"),
  from: optionalDateTime,
  tail: z
    .preprocess(emptyToUndefined, z.enum(["true", "false"]).optional())
    .transform((value) => value === "true"),
  limit: z.coerce.number().int().min(1).max(20_000).default(20_000)
});

export const summaryQuerySchema = z
  .object({
    from: z.preprocess(emptyToUndefined, z.string().date().optional()),
    to: z.preprocess(emptyToUndefined, z.string().date().optional()),
    query: z.preprocess(emptyToUndefined, z.string().trim().max(128).optional()),
    icao: z.preprocess(emptyToUndefined, icaoSchema.optional()),
    cursor: z.preprocess(emptyToUndefined, z.string().max(512).optional()),
    limit: z.coerce.number().int().min(1).max(200).default(50)
  })
  .superRefine((query, context) => {
    if (query.from && query.to && query.from > query.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "from must be before to"
      });
    }
  });

export const alertQuerySchema = z.object({
  icao: z.preprocess(emptyToUndefined, icaoSchema.optional()),
  dismissed: z
    .preprocess(emptyToUndefined, z.enum(["true", "false"]).optional())
    .transform((value) =>
      value === undefined ? undefined : value === "true"
    ),
  cursor: z.preprocess(emptyToUndefined, z.string().max(512).optional()),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export const dismissAlertsInputSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200)
});

export const watchlistInputSchema = z.object({
  label: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional()
});

export const liveDeltaSchema = z.object({
  type: z.literal("delta"),
  sequence: z.number().int().nonnegative(),
  generatedAt: isoDateTimeSchema,
  upserts: z.array(liveAircraftSchema),
  removals: z.array(icaoSchema),
  receiver: receiverRealtimeStateSchema.optional(),
  alerts: z.array(alertEventSchema)
});

export const liveHelloSchema = z.object({
  type: z.literal("hello"),
  sequence: z.number().int().nonnegative(),
  generatedAt: isoDateTimeSchema
});

export const liveResyncRequiredSchema = z.object({
  type: z.literal("resync_required"),
  sequence: z.number().int().nonnegative(),
  generatedAt: isoDateTimeSchema
});

export const liveWebSocketMessageSchema = z.discriminatedUnion("type", [
  liveHelloSchema,
  liveDeltaSchema,
  liveResyncRequiredSchema
]);

export type AircraftMetadata = z.infer<typeof aircraftMetadataSchema>;
export type LiveAircraft = z.infer<typeof liveAircraftSchema>;
export type ReceiverHealth = z.infer<typeof receiverHealthSchema>;
export type ReceiverRealtimeState = z.infer<
  typeof receiverRealtimeStateSchema
>;
export type AircraftSummary = z.infer<typeof aircraftSummarySchema>;
export type DailyAircraftSummary = z.infer<
  typeof dailyAircraftSummarySchema
>;
export type TrackSession = z.infer<typeof trackSessionSchema>;
export type TrackPoint = z.infer<typeof trackPointSchema>;
export type AlertRule = z.infer<typeof alertRuleSchema>;
export type AlertEvent = z.infer<typeof alertEventSchema>;
export type WatchlistEntry = z.infer<typeof watchlistEntrySchema>;
export type StatusResponse = z.infer<typeof statusResponseSchema>;
export type LiveAircraftResponse = z.infer<typeof liveAircraftResponseSchema>;
export type AircraftDetailResponse = z.infer<
  typeof aircraftDetailResponseSchema
>;
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
export type TrackResponse = z.infer<typeof trackResponseSchema>;
export type SummariesResponse = z.infer<typeof summariesResponseSchema>;
export type AlertsResponse = z.infer<typeof alertsResponseSchema>;
export type DismissAlertsResponse = z.infer<
  typeof dismissAlertsResponseSchema
>;
export type WatchlistResponse = z.infer<typeof watchlistResponseSchema>;
export type InsightAvailability = z.infer<typeof insightAvailabilitySchema>;
export type InsightSeriesPoint = z.infer<typeof insightSeriesPointSchema>;
export type InsightLeader = z.infer<typeof insightLeaderSchema>;
export type InsightMetrics = z.infer<typeof insightMetricsSchema>;
export type InsightOverview = z.infer<typeof insightOverviewSchema>;
export type CoverageCell = z.infer<typeof coverageCellSchema>;
export type InsightCoverageResponse = z.infer<
  typeof insightCoverageResponseSchema
>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type SessionQuery = z.infer<typeof sessionQuerySchema>;
export type TrackQuery = z.infer<typeof trackQuerySchema>;
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
export type AlertQuery = z.infer<typeof alertQuerySchema>;
export type DismissAlertsInput = z.infer<typeof dismissAlertsInputSchema>;
export type WatchlistInput = z.infer<typeof watchlistInputSchema>;
export type InsightQuery = z.infer<typeof insightQuerySchema>;
export type InsightCoverageQuery = z.infer<typeof insightCoverageQuerySchema>;
export type LiveDelta = z.infer<typeof liveDeltaSchema>;
export type LiveWebSocketMessage = z.infer<
  typeof liveWebSocketMessageSchema
>;
