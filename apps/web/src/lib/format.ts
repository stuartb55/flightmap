import type { Altitude } from '../types'
import { displayTimeZone } from '../config'
import { currentTheme, type ResolvedTheme } from './theme'
import {
  convertAltitude,
  convertDistance,
  convertSpeed,
  convertVerticalRate,
  unitLabels,
  unitPreferences,
  type UnitPreferences,
} from './unit-preferences'

// Formatters are cached per time zone rather than per module load, so a time
// zone changed in Settings applies without a page reload.
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function dateFormatter(options: Intl.DateTimeFormatOptions) {
  const zone = displayTimeZone()
  const key = `${zone}:${JSON.stringify(options)}`
  const cached = formatterCache.get(key)
  if (cached) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone })
  } catch {
    formatter = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Europe/London' })
  }
  formatterCache.set(key, formatter)
  return formatter
}

const displayDate = () =>
  dateFormatter({
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })

const displayTime = () =>
  dateFormatter({
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

/**
 * Every value below arrives in canonical aviation units — feet, knots,
 * nautical miles, feet per minute — and is converted here against the
 * browser's unit preference. Passing `units` explicitly is for tests and for
 * callers that already hold the preference; everything else reads the store.
 */
export function altitudeDisplayValue(
  value: number,
  units: UnitPreferences = unitPreferences(),
): number {
  const converted = convertAltitude(value, units.altitude)
  // Altitude is reported to 25 ft, so metres are rounded to the nearest ten
  // rather than implying a precision the receiver never had.
  return units.altitude === 'm' ? Math.round(converted / 10) * 10 : Math.round(converted)
}

export function formatAltitude(
  value: Altitude | undefined,
  units: UnitPreferences = unitPreferences(),
): string {
  if (value === 'ground') return 'GND'
  if (value == null || !Number.isFinite(value)) return '—'
  return `${altitudeDisplayValue(value, units).toLocaleString('en-GB')} ${unitLabels.altitude[units.altitude]}`
}

export function speedDisplayValue(
  value: number,
  units: UnitPreferences = unitPreferences(),
): number {
  return Math.round(convertSpeed(value, units.speed))
}

export function formatSpeed(
  value: number | null | undefined,
  units: UnitPreferences = unitPreferences(),
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${speedDisplayValue(value, units).toLocaleString('en-GB')} ${unitLabels.speed[units.speed]}`
}

export function formatDistance(
  value: number | null | undefined,
  units: UnitPreferences = unitPreferences(),
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const converted = convertDistance(value, units.distance)
  return `${converted.toFixed(converted < 10 ? 1 : 0)} ${unitLabels.distance[units.distance]}`
}

export function verticalRateDisplayValue(
  value: number,
  units: UnitPreferences = unitPreferences(),
): number {
  return units.verticalRate === 'ms'
    ? Math.round(convertVerticalRate(value, 'ms') * 10) / 10
    : Math.round(value)
}

/** Signed rate without the trend arrow, for charts and readouts. */
export function formatVerticalRateValue(
  value: number | null | undefined,
  units: UnitPreferences = unitPreferences(),
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const label = unitLabels.verticalRate[units.verticalRate]
  const converted = verticalRateDisplayValue(value, units)
  if (units.verticalRate === 'ms') return `${converted.toFixed(1)} ${label}`
  return `${converted.toLocaleString('en-GB')} ${label}`
}

export function formatVerticalRate(
  value: number | null | undefined,
  units: UnitPreferences = unitPreferences(),
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  // The 100 ft/min deadband is applied to the canonical value so the arrow
  // never disagrees with verticalTrend, whatever the display unit.
  const arrow = value > 100 ? '↑' : value < -100 ? '↓' : '→'
  const magnitude = Math.abs(value)
  const label = unitLabels.verticalRate[units.verticalRate]
  const rate =
    units.verticalRate === 'ms'
      ? convertVerticalRate(magnitude, 'ms').toFixed(1)
      : (Math.round(magnitude / 100) * 100).toLocaleString('en-GB')
  return `${arrow} ${rate} ${label}`
}

/**
 * Climb state at a glance. The same 100 ft/min deadband as formatVerticalRate,
 * so the arrow beside the altitude and the vertical-rate column never disagree.
 */
export function verticalTrend(
  value: number | null | undefined,
): 'climb' | 'descent' | 'level' | null {
  if (value == null || !Number.isFinite(value)) return null
  if (value > 100) return 'climb'
  if (value < -100) return 'descent'
  return 'level'
}

export function formatBearing(value: number | null | undefined): string {
  return value == null ? '—' : `${Math.round(value).toString().padStart(3, '0')}°`
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : displayDate().format(date)
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : displayTime().format(date)
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  return `${formatDate(value)}, ${formatTime(value)}`
}

export function formatDateTimeInput(date: Date): string {
  const formatter = dateFormatter({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

function zonedPartsTimestamp(date: Date): number {
  const formatter = dateFormatter({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
}

export function dateTimeInputToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error('Enter a valid date and time.')
  const desired = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  )
  let instant = desired
  for (let attempt = 0; attempt < 3; attempt += 1) {
    instant = desired - (zonedPartsTimestamp(new Date(instant)) - instant)
  }
  const result = new Date(instant)
  if (!Number.isFinite(result.getTime()) || formatDateTimeInput(result) !== value) {
    throw new Error(`That time does not exist in ${displayTimeZone()}.`)
  }
  return result.toISOString()
}

export function formatDuration(start: string, end: string | null): string {
  const startMs = new Date(start).getTime()
  const endMs = end ? new Date(end).getTime() : Date.now()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '—'
  const minutes = Math.max(0, Math.round((endMs - startMs) / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * Time since a series began, for an axis that has been aligned on start. It is
 * a difference rather than a clock reading, so it carries no time zone and
 * keeps seconds: aligned approach profiles are compared at a scale where a
 * minute-resolution label says nothing.
 */
export function formatElapsed(milliseconds: number | null | undefined): string {
  if (milliseconds == null || !Number.isFinite(milliseconds)) return '—'
  const total = Math.max(0, Math.round(milliseconds / 1000))
  const seconds = `${total % 60}`.padStart(2, '0')
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  return hours
    ? `+${hours}:${`${minutes}`.padStart(2, '0')}:${seconds}`
    : `+${minutes}:${seconds}`
}

export function formatBytes(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

export function compactNumber(value: number | null | undefined): string {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

/**
 * The altitude ramp, once per theme. The hue sequence is the same in both —
 * grey ground, green low, through blue and violet to red at the top — because
 * that ordering is what a reader learns. Only the lightness moves: the dark
 * ramp is bright enough to sit on a dark basemap, and the light ramp is dark
 * enough to clear 3:1 against a pale one, which the dark ramp does not.
 */
const altitudeRamps: Record<ResolvedTheme, readonly string[]> = {
  //         ground     unknown    <3k        <10k       <20k       <30k       <40k       40k+
  dark: ['#b7c0c8', '#8090a0', '#72e5af', '#50d5df', '#5aa8ff', '#ac8cff', '#eb7ddd', '#ff7b86'],
  light: ['#626d78', '#586e84', '#00874a', '#008192', '#0068c6', '#724dbf', '#9e3a93', '#b62f45'],
}

export function altitudeColour(
  altitude: Altitude | undefined,
  theme: ResolvedTheme = currentTheme(),
): string {
  const ramp = altitudeRamps[theme]
  if (altitude === 'ground') return ramp[0]!
  if (altitude == null) return ramp[1]!
  if (altitude < 3_000) return ramp[2]!
  if (altitude < 10_000) return ramp[3]!
  if (altitude < 20_000) return ramp[4]!
  if (altitude < 30_000) return ramp[5]!
  if (altitude < 40_000) return ramp[6]!
  return ramp[7]!
}

export function aircraftLabel(aircraft: {
  callsign?: string | null
  registration?: string | null
  icao: string
}): string {
  return aircraft.callsign?.trim() || aircraft.registration || aircraft.icao.toUpperCase()
}
