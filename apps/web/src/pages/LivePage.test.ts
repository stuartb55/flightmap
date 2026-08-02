import { describe, expect, it } from 'vitest'
import type { AlertEvent } from '../types'
import { emergencyBannerAlert } from './LivePage'

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
