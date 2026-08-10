import { describe, expect, it } from 'vitest'
import type { AlertEvent } from '../types'
import type { AircraftSortKey } from '../lib/aircraft-filter'
import { emergencyBannerAlert, sortDescription } from './LivePage'

function alert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'alert-1',
    type: 'watchlist',
    createdAt: '2026-08-01T09:00:00.000Z',
    icao: '406b90',
    callsign: 'EZY42KD',
    title: 'Watchlist aircraft detected',
    message: 'Watchlisted aircraft is active',
    dismissedAt: null,
    severity: 'info',
    ...overrides,
  }
}

describe('emergencyBannerAlert', () => {
  it('does not interrupt the map for watchlist alerts', () => {
    expect(
      emergencyBannerAlert([
        alert(),
        alert({ id: 'alert-2' }),
      ]),
    ).toBeUndefined()
  })

  it('returns the first active emergency alert', () => {
    const emergency = alert({ id: 'alert-3', type: 'emergency', severity: 'critical' })
    expect(
      emergencyBannerAlert([
        alert({ id: 'alert-2', type: 'emergency', severity: 'critical', dismissedAt: '2026-08-01T09:01:00.000Z' }),
        emergency,
      ]),
    ).toBe(emergency)
  })
})

describe('sortDescription', () => {
  it('names the ordering in the words a reader would use', () => {
    expect(sortDescription({ key: 'distance', direction: 'asc' })).toBe('Nearest first')
    expect(sortDescription({ key: 'distance', direction: 'desc' })).toBe('Farthest first')
    expect(sortDescription({ key: 'altitude', direction: 'desc' })).toBe('Highest first')
    expect(sortDescription({ key: 'freshness', direction: 'asc' })).toBe('Newest first')
  })

  /* The sheet's header is the only thing at this width saying which way the
     rows are ordered, so every sort the table offers has to have an answer. */
  it('has a description for every column the table can sort by', () => {
    const keys: AircraftSortKey[] = [
      'identity', 'altitude', 'distance', 'speed', 'freshness',
      'verticalRate', 'track', 'squawk', 'operator', 'typeCode',
    ]
    for (const key of keys) {
      expect(sortDescription({ key, direction: 'asc' })).toBeTruthy()
      expect(sortDescription({ key, direction: 'desc' })).toBeTruthy()
    }
  })
})
