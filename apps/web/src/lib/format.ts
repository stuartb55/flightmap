import type { Altitude } from '../types'
import { displayTimeZone } from '../config'

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

export function formatAltitude(value: Altitude | undefined): string {
  if (value === 'ground') return 'GND'
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value).toLocaleString('en-GB')} ft`
}

export function formatSpeed(value: number | null | undefined): string {
  return value == null ? '—' : `${Math.round(value)} kt`
}

export function formatDistance(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toFixed(value < 10 ? 1 : 0)} nm`
}

export function formatVerticalRate(value: number | null | undefined): string {
  if (value == null) return '—'
  const arrow = value > 100 ? '↑' : value < -100 ? '↓' : '→'
  return `${arrow} ${Math.abs(Math.round(value / 100) * 100).toLocaleString('en-GB')} ft/min`
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

export function altitudeColour(altitude: Altitude | undefined): string {
  if (altitude === 'ground') return '#b7c0c8'
  if (altitude == null) return '#8090a0'
  if (altitude < 3_000) return '#72e5af'
  if (altitude < 10_000) return '#50d5df'
  if (altitude < 20_000) return '#5aa8ff'
  if (altitude < 30_000) return '#ac8cff'
  if (altitude < 40_000) return '#eb7ddd'
  return '#ff7b86'
}

export function aircraftLabel(aircraft: {
  callsign?: string | null
  registration?: string | null
  icao: string
}): string {
  return aircraft.callsign?.trim() || aircraft.registration || aircraft.icao.toUpperCase()
}
