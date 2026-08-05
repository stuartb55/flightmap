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
  "watchlist",
  "custom"
]);

const customAlertPredicateShape = {
  callsignPrefix: z.string().trim().max(16).nullable().default(null),
  icao: icaoSchema.nullable().default(null),
  operator: z.string().trim().max(128).nullable().default(null),
  typeCode: z.string().trim().max(16).nullable().default(null),
  minimumAltitudeFt: nullableFiniteNumberSchema.default(null),
  maximumAltitudeFt: nullableFiniteNumberSchema.default(null),
  minimumDistanceNm: nullableFiniteNumberSchema.default(null),
  maximumDistanceNm: nullableFiniteNumberSchema.default(null)
};

function customAlertRuleIsValid(rule: Record<string, unknown>) {
  const predicates = ["callsignPrefix", "icao", "operator", "typeCode", "minimumAltitudeFt", "maximumAltitudeFt", "minimumDistanceNm", "maximumDistanceNm"];
  return predicates.some((key) => rule[key] !== null && rule[key] !== undefined && rule[key] !== "")
    && (!(typeof rule.minimumAltitudeFt === "number" && typeof rule.maximumAltitudeFt === "number") || rule.minimumAltitudeFt <= rule.maximumAltitudeFt)
    && (!(typeof rule.minimumDistanceNm === "number" && typeof rule.maximumDistanceNm === "number") || rule.minimumDistanceNm <= rule.maximumDistanceNm);
}

const customAlertRuleBaseSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  severity: z.enum(["info", "warning", "critical"]).default("warning"),
  ...customAlertPredicateShape,
  cooldownMinutes: z.number().int().min(0).max(10_080).default(0)
});
export const customAlertRuleInputSchema = customAlertRuleBaseSchema.refine(customAlertRuleIsValid, { message: "At least one valid predicate is required" });

export const customAlertRuleSchema = customAlertRuleInputSchema.and(z.object({
  id: z.string().uuid(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}));

export const customAlertRulesResponseSchema = z.object({ items: z.array(customAlertRuleSchema) });
export const customAlertRulePatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  callsignPrefix: z.string().trim().max(16).nullable().optional(),
  icao: icaoSchema.nullable().optional(),
  operator: z.string().trim().max(128).nullable().optional(),
  typeCode: z.string().trim().max(16).nullable().optional(),
  minimumAltitudeFt: nullableFiniteNumberSchema.optional(),
  maximumAltitudeFt: nullableFiniteNumberSchema.optional(),
  minimumDistanceNm: nullableFiniteNumberSchema.optional(),
  maximumDistanceNm: nullableFiniteNumberSchema.optional(),
  cooldownMinutes: z.number().int().min(0).max(10_080).optional()
}).refine(
  (patch) => Object.keys(patch).length > 0,
  { message: "At least one field is required" }
);
export const customAlertRulePreviewSchema = z.object({
  matches: z.array(z.object({ icao: icaoSchema, callsign: z.string().nullable(), registration: z.string().nullable() }))
});

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

export const trackEventSchema = z.object({
  type: z.enum([
    "session_start",
    "session_end",
    "callsign",
    "squawk",
    "emergency",
    "alert",
    "closest_approach"
  ]),
  occurredAt: isoDateTimeSchema,
  label: z.string(),
  value: z.string().nullable(),
  severity: z.enum(["info", "warning", "critical"]).default("info")
});

export const alertEventSchema = z.object({
  id: z.string().uuid(),
  icao: icaoSchema,
  sessionId: z.string().uuid().nullable(),
  rule: alertRuleSchema,
  state: z.string().nullable(),
  message: z.string(),
  severity: z.enum(["info", "warning", "critical"]).default("warning"),
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
  events: z.array(trackEventSchema).default([]),
  truncated: z.boolean()
});

export const aircraftActivityPointSchema = z.object({
  bucketStart: isoDateTimeSchema,
  bucketEnd: isoDateTimeSchema,
  observations: z.number().int().nonnegative(),
  positionedObservations: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  closestRangeNm: nullableFiniteNumberSchema,
  maximumAltitudeFt: nullableFiniteNumberSchema
});

export const aircraftActivityResponseSchema = z.object({
  icao: icaoSchema,
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  bucket: z.enum(["day", "month"]),
  totals: z.object({
    observations: z.number().int().nonnegative(),
    positionedObservations: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    activeDays: z.number().int().nonnegative(),
    closestRangeNm: nullableFiniteNumberSchema,
    maximumAltitudeFt: nullableFiniteNumberSchema
  }),
  callsigns: z.array(z.string()),
  series: z.array(aircraftActivityPointSchema),
  detailedTrackFrom: isoDateTimeSchema
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

export const mapLayerPreferencesSchema = z
  .object({
    coverage: z.boolean(),
    rangeRings: z.boolean(),
    aircraftLabels: z.boolean(),
    trails: z.boolean(),
    // Added after the original five. It carries a default so saved views and
    // stored preferences written before it still parse, rather than every one
    // of them failing this strict object for a missing key.
    allTrails: z.boolean().default(false),
    // Named for the reference deployment; the waypoints themselves are
    // configuration. Renaming would invalidate every persisted saved view.
    manchesterWaypoints: z.boolean()
  })
  .strict();

/**
 * Which series the Insights activity chart draws. Every one defaults to shown,
 * so a stored preference or a saved view written before the toggles existed
 * parses to the chart as it was.
 */
export const insightSeriesPreferencesSchema = z
  .object({
    reports: z.boolean().default(true),
    positionedReports: z.boolean().default(true),
    receiverAvailability: z.boolean().default(true)
  })
  .strict();

export const defaultInsightSeries: InsightSeriesPreferences = {
  reports: true,
  positionedReports: true,
  receiverAvailability: true
};

/** A display-only reference point, configured per receiver. */
export const mapWaypointSchema = z
  .object({
    name: z.string().trim().min(1).max(12),
    kind: z.enum(["arrival", "departure"]),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180)
  })
  .strict();

export const mapDisplayPreferencesSchema = z.object({
  trailMinutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30)]).default(15),
  labelDensity: z.enum(["auto", "reduced", "full"]).default("auto")
});

export const mapViewportSchema = z
  .object({
    longitude: z.number().finite().min(-180).max(180),
    latitude: z.number().finite().min(-90).max(90),
    zoom: z.number().finite().min(0).max(24),
    bearing: z.number().finite().min(-360).max(360),
    pitch: z.number().finite().min(0).max(85)
  })
  .strict();

const savedViewBaseSchema = z.object({
  mapLayers: mapLayerPreferencesSchema,
  viewport: mapViewportSchema.nullable()
});

export const liveSavedViewConfigurationSchema = savedViewBaseSchema
  .extend({
    surface: z.literal("live"),
    display: mapDisplayPreferencesSchema.optional(),
    filters: z
      .object({
        query: z.string().max(128),
        minimumAltitude: z.string().max(16),
        maximumAltitude: z.string().max(16),
        minimumSpeed: z.string().max(16),
        maximumDistance: z.string().max(16),
        maximumFreshness: z.string().max(16),
        position: z.enum(["all", "positioned", "unpositioned"]),
        source: z.string().max(32),
        category: z.string().max(32),
        watchedOnly: z.boolean(),
        alertsOnly: z.boolean()
      })
      .strict(),
    sort: z
      .object({
        // Mirrors AircraftSortKey in the web app. Additions are backwards
        // compatible: a view saved under an earlier, shorter list still parses.
        key: z.enum([
          "identity",
          "altitude",
          "distance",
          "speed",
          "freshness",
          "verticalRate",
          "track",
          "squawk",
          "operator",
          "typeCode"
        ]),
        direction: z.enum(["asc", "desc"])
      })
      .strict()
  })
  .strict();

/**
 * How a session search is ordered. Each option carries the direction that makes
 * it useful — nobody asks for the furthest approach or the shortest flight
 * first — which keeps the control a single list rather than a field and a
 * direction. Additions are backwards compatible: a view saved under the
 * earlier, shorter list still parses.
 */
export const sessionSortSchema = z.enum([
  "started_desc",
  "started_asc",
  "duration_desc",
  "closest_asc",
  "altitude_desc",
  "samples_desc"
]);

export const historySavedViewConfigurationSchema = savedViewBaseSchema
  .extend({
    surface: z.literal("history"),
    filters: z
      .object({
        query: z.string().max(128),
        icao: z.string().max(6).default(""),
        callsign: z.string().max(16).default(""),
        registration: z.string().max(32).default(""),
        type: z.string().max(16).default(""),
        operator: z.string().max(128).default(""),
        from: isoDateTimeSchema,
        to: isoDateTimeSchema,
        alert: z.enum(["", "emergency_squawk", "emergency_state", "watchlist"]),
        /*
         * The weekday-hour window drilled into from the Insights pattern grid.
         * Nullable and defaulted so a view saved before the drill-down existed
         * still parses.
         */
        weekday: z.number().int().min(0).max(6).nullable().default(null),
        hour: z.number().int().min(0).max(23).nullable().default(null)
      })
      .strict(),
    sort: sessionSortSchema,
    selectedSessionIds: z.array(z.string().uuid()).max(8),
    resolution: z.enum(["auto", "1s", "5s", "15s", "60s"]),
    replayTime: z.number().finite().nonnegative().nullable(),
    /**
     * How the flight profile lays out its x axis when several tracks are
     * overlaid. Defaulted rather than required, so a view saved before
     * comparison existed still parses.
     */
    profileAxis: z.enum(["absolute", "aligned"]).default("absolute")
  })
  .strict();

export const insightsSavedViewConfigurationSchema = savedViewBaseSchema
  .extend({
    surface: z.literal("insights"),
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    bucket: z.enum(["hour", "day"]),
    preset: z.enum(["today", "24h", "7d", "30d", "custom"]),
    sort: z.literal("reports_desc"),
    compare: z.boolean(),
    /** Defaulted so a view saved before the toggles existed still parses. */
    series: insightSeriesPreferencesSchema.default(defaultInsightSeries)
  })
  .strict();

export const savedViewConfigurationSchema = z.discriminatedUnion("surface", [
  liveSavedViewConfigurationSchema,
  historySavedViewConfigurationSchema,
  insightsSavedViewConfigurationSchema
]).superRefine((configuration, context) => {
  const from = configuration.surface === "history"
    ? configuration.filters.from
    : configuration.surface === "insights"
      ? configuration.from
      : null;
  const to = configuration.surface === "history"
    ? configuration.filters.to
    : configuration.surface === "insights"
      ? configuration.to
      : null;
  if (from && to && Date.parse(from) >= Date.parse(to)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: configuration.surface === "history" ? ["filters", "from"] : ["from"],
      message: "from must be before to"
    });
  }
});

export const savedViewSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    surface: z.enum(["live", "history", "insights"]),
    configuration: savedViewConfigurationSchema,
    isDefault: z.boolean(),
    pinnedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict()
  .superRefine((view, context) => {
    if (view.surface !== view.configuration.surface) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["configuration", "surface"],
        message: "configuration surface must match surface"
      });
    }
  });

export const savedViewsResponseSchema = z.object({
  items: z.array(savedViewSchema).max(20)
});

export const savedViewInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    configuration: savedViewConfigurationSchema
  })
  .strict();

/**
 * Pinned views are chips shown beside the saved-views button on the surface
 * itself. Three is what fits next to the button on a phone without pushing the
 * map controls into a second row; the cap is enforced in the database writer.
 */
export const savedViewPinLimit = 3;

export const savedViewPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    configuration: savedViewConfigurationSchema.optional(),
    /** True makes this the surface's default, clearing any previous one. */
    isDefault: z.boolean().optional(),
    pinned: z.boolean().optional()
  })
  .strict()
  .refine(
    (patch) =>
      patch.name !== undefined ||
      patch.configuration !== undefined ||
      patch.isDefault !== undefined ||
      patch.pinned !== undefined,
    { message: "At least one saved-view field is required" }
  );

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

export const insightPatternCellSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  uniqueAircraft: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  reports: z.number().int().nonnegative(),
  previousReports: z.number().int().nonnegative().nullable(),
  changePercent: nullableFiniteNumberSchema
});

export const insightPatternsResponseSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  timeZone: z.string(),
  cells: z.array(insightPatternCellSchema),
  busiest: insightPatternCellSchema.nullable(),
  availability: insightAvailabilitySchema
});

export const rangeProfileSectorSchema = z.object({
  bearingStartDeg: z.number().int().min(0).max(355),
  bearingEndDeg: z.number().int().min(5).max(360),
  reports: z.number().int().nonnegative(),
  medianRangeNm: nullableFiniteNumberSchema,
  p95RangeNm: nullableFiniteNumberSchema,
  maximumRangeNm: nullableFiniteNumberSchema,
  previousP95RangeNm: nullableFiniteNumberSchema,
  p95ChangeNm: nullableFiniteNumberSchema
});

export const rangeProfileResponseSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  altitudeBand: z.enum(["all", "ground", "low", "medium", "high"]),
  sectors: z.array(rangeProfileSectorSchema),
  availableFrom: z.string().date().nullable()
});

export const coverageCellDetailResponseSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  cell: coverageCellSchema,
  aircraft: z.array(
    z.object({
      icao: icaoSchema,
      registration: z.string().nullable(),
      typeCode: z.string().nullable(),
      operator: z.string().nullable()
    })
  )
});

/*
 * All-time receiver records. Every one of these comes from an aggregate that
 * is retained indefinitely, so a record survives the expiry of the detailed
 * track that set it — which is the point: these are the numbers a receiver is
 * shown off with, and they must not quietly reset at the retention horizon.
 *
 * There is no "longest session" here even though it is the obvious sibling:
 * `track_sessions` is pruned at retention, so an all-time session record would
 * shrink as history aged out. The longest *contact* — first to last report for
 * one airframe on one day — is the same question asked of data that is kept.
 */
export const receiverRecordKinds = [
  "farthest_contact",
  "highest_altitude",
  "closest_approach",
  "longest_contact",
  "busiest_day",
  "most_observed_airframe"
] as const;

export const receiverRecordSchema = z.object({
  kind: z.enum(receiverRecordKinds),
  /** The measure in its canonical unit; the reader's preference applies on display. */
  value: z.number().finite(),
  unit: z.enum(["distance_nm", "altitude_ft", "duration_seconds", "count"]),
  /** The UTC day the record was set, matching how the daily aggregates bucket. */
  occurredOn: z.string().date(),
  /** Null for a record about the receiver rather than about one airframe. */
  icao: icaoSchema.nullable(),
  label: z.string().nullable(),
  secondary: z.string().nullable(),
  /**
   * Whether that day is still inside detailed retention. False means the track
   * behind the record has expired, and the record links onward to the aircraft
   * profile alone.
   */
  detailedTrackAvailable: z.boolean()
});

export const receiverRecordsResponseSchema = z.object({
  /** Only the records the receiver has actually set; empty on a new receiver. */
  records: z.array(receiverRecordSchema),
  /** The first day any aggregate covers, so the panel can say what "all time" means. */
  availableFrom: z.string().date().nullable(),
  /** The last day inside detailed retention, for the History links. */
  detailedFrom: z.string().date()
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

/**
 * An IANA zone the database can be asked to convert into. Unrecognised names
 * reach PostgreSQL as `AT TIME ZONE 'nonsense'`, which raises rather than
 * returning nothing, so they are rejected here as bad input instead.
 */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "must be an IANA time zone");

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

export const insightPatternsQuerySchema = z
  .object({
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    timeZone: timeZoneSchema,
    compare: z
      .preprocess(emptyToUndefined, z.enum(["true", "false"]).optional())
      .transform((value) => value === "true")
  })
  .superRefine((query, context) => {
    if (Date.parse(query.from) >= Date.parse(query.to)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "from must be before to" });
    }
  });

export const rangeProfileQuerySchema = z
  .object({
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    altitudeBand: z.enum(["all", "ground", "low", "medium", "high"]).default("all"),
    compare: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional()).transform((value) => value === "true")
  })
  .superRefine((query, context) => {
    if (Date.parse(query.from) >= Date.parse(query.to)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "from must be before to" });
  });

export const aircraftActivityQuerySchema = z
  .object({
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    bucket: z.enum(["day", "month"]).default("day")
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

export const coverageCellDetailQuerySchema = insightCoverageQuerySchema.extend({
  latitude: z.coerce.number().finite().min(-90).max(90),
  longitude: z.coerce.number().finite().min(-180).max(180)
});

export const sessionExportQuerySchema = z
  .object({
    format: z
      .preprocess(emptyToUndefined, z.enum(["csv", "geojson"]).optional())
      .transform((value) => value ?? "csv"),
    resolution: z
      .preprocess(
        emptyToUndefined,
        z.enum(["auto", "1s", "5s", "15s", "60s"]).optional()
      )
      .transform((value) => value ?? "auto"),
    from: optionalDateTime
  })
  .strict();

export const sessionQuerySchema = z
  .object({
    sort: sessionSortSchema.default("started_desc"),
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
    /*
     * The weekday-hour window an Insights pattern cell drills into: Monday is
     * 0, matching `extract(isodow) - 1`, and both parts are named in the
     * viewer's zone rather than UTC because that is the zone the grid was
     * drawn in. They are meaningless apart, so the pair is required together.
     */
    weekday: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(0).max(6).optional()
    ),
    hour: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(0).max(23).optional()
    ),
    timeZone: z.preprocess(emptyToUndefined, timeZoneSchema.optional()),
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
    if ((query.weekday === undefined) !== (query.hour === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [query.weekday === undefined ? "weekday" : "hour"],
        message: "weekday and hour must be given together"
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
export type TrackEvent = z.infer<typeof trackEventSchema>;
export type AlertRule = z.infer<typeof alertRuleSchema>;
export type CustomAlertRule = z.infer<typeof customAlertRuleSchema>;
export type CustomAlertRuleInput = z.infer<typeof customAlertRuleInputSchema>;
export type CustomAlertRulePatch = z.infer<typeof customAlertRulePatchSchema>;
export type AlertEvent = z.infer<typeof alertEventSchema>;
export type WatchlistEntry = z.infer<typeof watchlistEntrySchema>;
export type StatusResponse = z.infer<typeof statusResponseSchema>;
export type LiveAircraftResponse = z.infer<typeof liveAircraftResponseSchema>;
export type AircraftDetailResponse = z.infer<
  typeof aircraftDetailResponseSchema
>;
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
export type TrackResponse = z.infer<typeof trackResponseSchema>;
export type AircraftActivityPoint = z.infer<typeof aircraftActivityPointSchema>;
export type AircraftActivityResponse = z.infer<typeof aircraftActivityResponseSchema>;
export type SummariesResponse = z.infer<typeof summariesResponseSchema>;
export type AlertsResponse = z.infer<typeof alertsResponseSchema>;
export type DismissAlertsResponse = z.infer<
  typeof dismissAlertsResponseSchema
>;
export type WatchlistResponse = z.infer<typeof watchlistResponseSchema>;
export type MapLayerPreferences = z.infer<typeof mapLayerPreferencesSchema>;
export type InsightSeriesPreferences = z.infer<
  typeof insightSeriesPreferencesSchema
>;
export type MapDisplayPreferences = z.infer<typeof mapDisplayPreferencesSchema>;
export type MapViewport = z.infer<typeof mapViewportSchema>;
export type SavedViewConfiguration = z.infer<
  typeof savedViewConfigurationSchema
>;
export type SavedView = z.infer<typeof savedViewSchema>;
export type SavedViewsResponse = z.infer<typeof savedViewsResponseSchema>;
export type SavedViewInput = z.infer<typeof savedViewInputSchema>;
export type SavedViewPatch = z.infer<typeof savedViewPatchSchema>;
export type InsightAvailability = z.infer<typeof insightAvailabilitySchema>;
export type InsightSeriesPoint = z.infer<typeof insightSeriesPointSchema>;
export type InsightLeader = z.infer<typeof insightLeaderSchema>;
export type InsightMetrics = z.infer<typeof insightMetricsSchema>;
export type MapWaypoint = z.infer<typeof mapWaypointSchema>;
export type InsightOverview = z.infer<typeof insightOverviewSchema>;
export type CoverageCell = z.infer<typeof coverageCellSchema>;
export type InsightCoverageResponse = z.infer<
  typeof insightCoverageResponseSchema
>;
export type InsightPatternCell = z.infer<typeof insightPatternCellSchema>;
export type InsightPatternsResponse = z.infer<typeof insightPatternsResponseSchema>;
export type RangeProfileSector = z.infer<typeof rangeProfileSectorSchema>;
export type RangeProfileResponse = z.infer<typeof rangeProfileResponseSchema>;
export type CoverageCellDetailResponse = z.infer<
  typeof coverageCellDetailResponseSchema
>;
export type ReceiverRecordKind = (typeof receiverRecordKinds)[number];
export type ReceiverRecord = z.infer<typeof receiverRecordSchema>;
export type ReceiverRecordsResponse = z.infer<
  typeof receiverRecordsResponseSchema
>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type SessionQuery = z.infer<typeof sessionQuerySchema>;
export type SessionSort = z.infer<typeof sessionSortSchema>;
export type TrackQuery = z.infer<typeof trackQuerySchema>;
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
export type AlertQuery = z.infer<typeof alertQuerySchema>;
export type DismissAlertsInput = z.infer<typeof dismissAlertsInputSchema>;
export type WatchlistInput = z.infer<typeof watchlistInputSchema>;
export type InsightQuery = z.infer<typeof insightQuerySchema>;
export type InsightCoverageQuery = z.infer<typeof insightCoverageQuerySchema>;
export type InsightPatternsQuery = z.infer<typeof insightPatternsQuerySchema>;
export type RangeProfileQuery = z.infer<typeof rangeProfileQuerySchema>;
export type AircraftActivityQuery = z.infer<typeof aircraftActivityQuerySchema>;
export type CoverageCellDetailQuery = z.infer<
  typeof coverageCellDetailQuerySchema
>;
export type SessionExportQuery = z.infer<typeof sessionExportQuerySchema>;
export type LiveDelta = z.infer<typeof liveDeltaSchema>;
export type LiveWebSocketMessage = z.infer<
  typeof liveWebSocketMessageSchema
>;
