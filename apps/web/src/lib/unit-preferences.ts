import { useSyncExternalStore } from 'react'

/**
 * Display units are a per-browser choice, not a server setting: two people
 * looking at the same receiver can want different units, and the receiver
 * itself always speaks feet, knots and nautical miles. Every value carried by
 * the API stays in those canonical aviation units — conversion happens only at
 * the point of display, through `format.ts`.
 */

export type AltitudeUnit = 'ft' | 'm'
export type SpeedUnit = 'kt' | 'kmh' | 'mph'
export type DistanceUnit = 'nm' | 'km' | 'mi'
export type VerticalRateUnit = 'fpm' | 'ms'

export interface UnitPreferences {
  altitude: AltitudeUnit
  speed: SpeedUnit
  distance: DistanceUnit
  verticalRate: VerticalRateUnit
}

export type UnitPreset = 'aviation' | 'metric' | 'custom'

const STORAGE_KEY = 'flightmap.units.v1'

export const aviationUnits: UnitPreferences = {
  altitude: 'ft',
  speed: 'kt',
  distance: 'nm',
  verticalRate: 'fpm',
}

export const metricUnits: UnitPreferences = {
  altitude: 'm',
  speed: 'kmh',
  distance: 'km',
  verticalRate: 'ms',
}

export const altitudeUnits: readonly AltitudeUnit[] = ['ft', 'm']
export const speedUnits: readonly SpeedUnit[] = ['kt', 'kmh', 'mph']
export const distanceUnits: readonly DistanceUnit[] = ['nm', 'km', 'mi']
export const verticalRateUnits: readonly VerticalRateUnit[] = ['fpm', 'ms']

export const unitLabels = {
  altitude: { ft: 'ft', m: 'm' },
  speed: { kt: 'kt', kmh: 'km/h', mph: 'mph' },
  distance: { nm: 'nm', km: 'km', mi: 'mi' },
  verticalRate: { fpm: 'ft/min', ms: 'm/s' },
} as const

const FEET_TO_METRES = 0.3048
const KNOTS_TO_KMH = 1.852
const KNOTS_TO_MPH = 1.150779
const NM_TO_KM = 1.852
const NM_TO_MI = 1.150779
const FPM_TO_MS = FEET_TO_METRES / 60

export function convertAltitude(feet: number, unit: AltitudeUnit): number {
  return unit === 'm' ? feet * FEET_TO_METRES : feet
}

export function altitudeToFeet(value: number, unit: AltitudeUnit): number {
  return unit === 'm' ? value / FEET_TO_METRES : value
}

export function convertSpeed(knots: number, unit: SpeedUnit): number {
  if (unit === 'kmh') return knots * KNOTS_TO_KMH
  if (unit === 'mph') return knots * KNOTS_TO_MPH
  return knots
}

export function speedToKnots(value: number, unit: SpeedUnit): number {
  if (unit === 'kmh') return value / KNOTS_TO_KMH
  if (unit === 'mph') return value / KNOTS_TO_MPH
  return value
}

export function convertDistance(nauticalMiles: number, unit: DistanceUnit): number {
  if (unit === 'km') return nauticalMiles * NM_TO_KM
  if (unit === 'mi') return nauticalMiles * NM_TO_MI
  return nauticalMiles
}

export function distanceToNauticalMiles(value: number, unit: DistanceUnit): number {
  if (unit === 'km') return value / NM_TO_KM
  if (unit === 'mi') return value / NM_TO_MI
  return value
}

export function convertVerticalRate(feetPerMinute: number, unit: VerticalRateUnit): number {
  return unit === 'ms' ? feetPerMinute * FPM_TO_MS : feetPerMinute
}

export function unitPreset(units: UnitPreferences): UnitPreset {
  if (sameUnits(units, aviationUnits)) return 'aviation'
  if (sameUnits(units, metricUnits)) return 'metric'
  return 'custom'
}

export function presetUnits(preset: Exclude<UnitPreset, 'custom'>): UnitPreferences {
  return preset === 'metric' ? { ...metricUnits } : { ...aviationUnits }
}

function sameUnits(left: UnitPreferences, right: UnitPreferences): boolean {
  return (
    left.altitude === right.altitude &&
    left.speed === right.speed &&
    left.distance === right.distance &&
    left.verticalRate === right.verticalRate
  )
}

function option<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/**
 * Corrupt or partial storage falls back field by field rather than discarding
 * the whole preference, so an unknown unit added by a later version does not
 * cost the user the choices they made in this one.
 */
export function readUnitPreferences(
  storage: Pick<Storage, 'getItem'> = localStorage,
): UnitPreferences {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    if (parsed === null || typeof parsed !== 'object') return { ...aviationUnits }
    const record = parsed as Record<string, unknown>
    return {
      altitude: option(record.altitude, altitudeUnits, aviationUnits.altitude),
      speed: option(record.speed, speedUnits, aviationUnits.speed),
      distance: option(record.distance, distanceUnits, aviationUnits.distance),
      verticalRate: option(record.verticalRate, verticalRateUnits, aviationUnits.verticalRate),
    }
  } catch {
    return { ...aviationUnits }
  }
}

let current: UnitPreferences | null = null
const listeners = new Set<() => void>()

export function unitPreferences(): UnitPreferences {
  current ??= readUnitPreferences()
  return current
}

export function setUnitPreferences(units: UnitPreferences): void {
  current = { ...units }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // A unit choice that cannot be stored still applies to this session.
  }
  for (const listener of listeners) listener()
}

export function subscribeUnitPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Subscribes a component to the unit choice. Components that render a
 * converted value call this so a change in Settings repaints them without a
 * reload — the formatters themselves read the same store.
 */
export function useUnitPreferences(): UnitPreferences {
  return useSyncExternalStore(subscribeUnitPreferences, unitPreferences, unitPreferences)
}
