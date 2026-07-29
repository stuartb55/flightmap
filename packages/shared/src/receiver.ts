import { z } from "zod";

const finiteNumber = z.number().finite();
const optionalFiniteNumber = finiteNumber.nullish();

/**
 * readsb adds fields over time, so receiver payloads deliberately passthrough
 * unknown keys while validating every field that the application consumes.
 */
export const receiverAircraftSchema = z
  .object({
    hex: z.string().regex(/^[0-9a-fA-F]{6}$/),
    flight: z.string().nullish(),
    lat: finiteNumber.min(-90).max(90).nullish(),
    lon: finiteNumber.min(-180).max(180).nullish(),
    alt_baro: z.union([finiteNumber, z.literal("ground")]).nullish(),
    alt_geom: optionalFiniteNumber,
    gs: optionalFiniteNumber,
    ias: optionalFiniteNumber,
    tas: optionalFiniteNumber,
    mach: optionalFiniteNumber,
    track: optionalFiniteNumber,
    track_rate: optionalFiniteNumber,
    roll: optionalFiniteNumber,
    mag_heading: optionalFiniteNumber,
    true_heading: optionalFiniteNumber,
    baro_rate: optionalFiniteNumber,
    geom_rate: optionalFiniteNumber,
    squawk: z.union([z.string(), z.number()]).nullish(),
    emergency: z.string().nullish(),
    category: z.string().nullish(),
    rssi: optionalFiniteNumber,
    messages: z.number().int().nonnegative().nullish(),
    seen: z.number().nonnegative().finite().nullish(),
    seen_pos: z.number().nonnegative().finite().nullish(),
    nav_altitude_mcp: optionalFiniteNumber,
    nav_altitude_fms: optionalFiniteNumber,
    nav_heading: optionalFiniteNumber,
    nav_qnh: optionalFiniteNumber,
    nav_modes: z.array(z.string()).nullish(),
    nic: optionalFiniteNumber,
    nic_baro: optionalFiniteNumber,
    nac_p: optionalFiniteNumber,
    nac_v: optionalFiniteNumber,
    sil: optionalFiniteNumber,
    sil_type: z.string().nullish(),
    gva: optionalFiniteNumber,
    sda: optionalFiniteNumber,
    rc: optionalFiniteNumber,
    version: optionalFiniteNumber,
    type: z.string().nullish(),
    mlat: z.array(z.string()).nullish(),
    tisb: z.array(z.string()).nullish()
  })
  .passthrough();

export const receiverAircraftSnapshotSchema = z
  .object({
    now: finiteNumber.nonnegative(),
    messages: z.number().int().nonnegative(),
    aircraft: z.array(z.unknown())
  })
  .passthrough();

export const receiverInfoSchema = z
  .object({
    version: z.string().nullish(),
    refresh: finiteNumber.positive().nullish(),
    lat: finiteNumber.min(-90).max(90).nullish(),
    lon: finiteNumber.min(-180).max(180).nullish()
  })
  .passthrough();

const receiverStatsSourceSchema = z
  .object({
    accepted: z.array(z.number().nonnegative()).optional(),
    bad: z.number().nonnegative().optional(),
    unknown_icao: z.number().nonnegative().optional(),
    signal: finiteNumber.optional(),
    noise: finiteNumber.optional(),
    peak_signal: finiteNumber.optional(),
    strong_signals: z.number().nonnegative().optional()
  })
  .passthrough();

export const receiverStatsSchema = z
  .object({
    now: finiteNumber.optional(),
    total: z
      .object({
        messages: z.number().nonnegative().optional(),
        valid: z.number().nonnegative().optional(),
        bad: z.number().nonnegative().optional(),
        unknown_icao: z.number().nonnegative().optional(),
        strong_signals: z.number().nonnegative().optional(),
        local: receiverStatsSourceSchema.optional(),
        remote: receiverStatsSourceSchema.optional(),
        cpu: z
          .object({
            demod: z.number().nonnegative().optional(),
            reader: z.number().nonnegative().optional(),
            background: z.number().nonnegative().optional()
          })
          .partial()
          .optional()
      })
      .passthrough()
      .optional(),
    last1min: z
      .object({
        messages: z.number().nonnegative().optional(),
        local: receiverStatsSourceSchema.optional(),
        remote: receiverStatsSourceSchema.optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export type ReceiverAircraft = z.infer<typeof receiverAircraftSchema>;
export type ReceiverAircraftSnapshot = z.infer<
  typeof receiverAircraftSnapshotSchema
>;
export type ReceiverInfo = z.infer<typeof receiverInfoSchema>;
export type ReceiverStats = z.infer<typeof receiverStatsSchema>;
