import { describe, expect, it } from 'vitest'
import {
  aircraftLabel,
  altitudeColour,
  compactNumber,
  dateTimeInputToIso,
  formatAltitude,
  formatBearing,
  formatBytes,
  formatDate,
  formatDateTime,
  formatDateTimeInput,
  formatDistance,
  formatDuration,
  formatSpeed,
  formatTime,
  formatVerticalRate,
} from './format'

describe('configured display time-zone inputs', () => {
  it('round-trips a summer date through Europe/London', () => {
    const instant = new Date('2026-07-29T12:30:00.000Z')
    expect(formatDateTimeInput(instant)).toBe('2026-07-29T13:30')
    expect(dateTimeInputToIso('2026-07-29T13:30')).toBe('2026-07-29T12:30:00.000Z')
  })

  it('rejects a local time skipped by daylight saving', () => {
    expect(() => dateTimeInputToIso('2026-03-29T01:30')).toThrow(/does not exist/)
  })
})

describe('value formatting', () => {
  it('formats altitudes, speeds, distances and rates for display', () => {
    expect(formatAltitude('ground')).toBe('GND')
    expect(formatAltitude(18_000)).toBe('18,000 ft')
    expect(formatAltitude(null)).toBe('—')
    expect(formatAltitude(Number.NaN)).toBe('—')
    expect(formatSpeed(349.6)).toBe('350 kt')
    expect(formatSpeed(null)).toBe('—')
    expect(formatDistance(4.25)).toBe('4.3 nm')
    expect(formatDistance(42.4)).toBe('42 nm')
    expect(formatDistance(null)).toBe('—')
    expect(formatVerticalRate(1_240)).toBe('↑ 1,200 ft/min')
    expect(formatVerticalRate(-1_240)).toBe('↓ 1,200 ft/min')
    expect(formatVerticalRate(20)).toBe('→ 0 ft/min')
    expect(formatVerticalRate(null)).toBe('—')
    expect(formatBearing(7)).toBe('007°')
    expect(formatBearing(null)).toBe('—')
  })

  it('formats dates, durations, bytes and compact numbers', () => {
    expect(formatDate('2026-07-29T12:30:00.000Z')).toBe('29 Jul 2026')
    expect(formatTime('2026-07-29T12:30:05.000Z')).toBe('13:30:05')
    expect(formatDateTime('2026-07-29T12:30:05.000Z')).toBe('29 Jul 2026, 13:30:05')
    expect(formatDate(null)).toBe('—')
    expect(formatDate('not a date')).toBe('—')
    expect(formatTime(null)).toBe('—')
    expect(formatDuration('2026-07-29T12:00:00.000Z', '2026-07-29T12:45:00.000Z')).toBe('45m')
    expect(formatDuration('2026-07-29T10:00:00.000Z', '2026-07-29T12:45:00.000Z')).toBe('2h 45m')
    expect(formatDuration('nonsense', null)).toBe('—')
    expect(formatBytes(2_048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
    expect(formatBytes(null)).toBe('—')
    // The compact suffix is CLDR data, not our formatting: en-GB renders
    // "12.5K" on macOS's ICU and "12.5k" on the Linux build CI uses.
    expect(compactNumber(12_500)).toMatch(/^12\.5[Kk]$/)
    expect(compactNumber(null)).toBe('—')
  })

  it('rejects an unparseable date-time input', () => {
    expect(() => dateTimeInputToIso('29/07/2026')).toThrow(/valid date and time/)
  })

  it('bands altitude colours and falls back through identity fields', () => {
    const colours = [
      altitudeColour('ground'),
      altitudeColour(undefined),
      altitudeColour(1_000),
      altitudeColour(5_000),
      altitudeColour(15_000),
      altitudeColour(25_000),
      altitudeColour(35_000),
      altitudeColour(45_000),
    ]
    expect(new Set(colours).size).toBe(colours.length)
    expect(aircraftLabel({ callsign: ' EZY42KD ', registration: 'G-EZTH', icao: '406b90' })).toBe('EZY42KD')
    expect(aircraftLabel({ callsign: '  ', registration: 'G-EZTH', icao: '406b90' })).toBe('G-EZTH')
    expect(aircraftLabel({ icao: '406b90' })).toBe('406B90')
  })
})
