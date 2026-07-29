import { describe, expect, it } from 'vitest'
import { adaptAircraft, adaptAlert, adaptReceiver, adaptTrackPoint } from './adapters'
import { wireAircraft } from '../test/fixtures'

describe('API adapters', () => {
  it('normalises canonical aircraft fields into the UI model', () => {
    const result = adaptAircraft(wireAircraft())

    expect(result).toMatchObject({
      icao: '406b90',
      registration: 'G-EZTH',
      altitudeBaro: 18_000,
      groundSpeed: 410,
      track: 164,
      bearing: 126,
    })
    expect(result.navigation.altitude).toBe(10_000)
  })

  it('preserves an explicit on-ground report', () => {
    const result = adaptAircraft(
      wireAircraft({ onGround: true, altitudeBarometricFt: null, groundSpeedKt: 7 }),
    )

    expect(result.altitudeBaro).toBe('ground')
    expect(result.groundSpeed).toBe(7)
  })

  it('uses the configured fallback coordinates before receiver position is known', () => {
    const result = adaptReceiver({
      health: 'unknown',
      latitude: null,
      longitude: null,
      version: null,
      advertisedRefreshMs: null,
      lastSnapshotAt: null,
      snapshotAgeSeconds: null,
      messageRatePerSecond: null,
    })

    expect(result.status).toBe('connecting')
    expect(result.latitude).toBe(53.61)
    expect(result.longitude).toBe(-2.31)
  })

  it('maps server alert rules and severity', () => {
    const result = adaptAlert({
      id: 'alert-1',
      icao: '406b90',
      sessionId: null,
      rule: 'emergency_squawk',
      state: '7700',
      message: 'General emergency',
      occurredAt: '2026-07-29T12:00:00.000Z',
      dismissedAt: null,
      callsign: 'EZY42KD',
    })

    expect(result.type).toBe('emergency')
    expect(result.severity).toBe('critical')
    expect(result.title).toContain('7700')
  })

  it('turns a track ground point into a numeric replay altitude', () => {
    const result = adaptTrackPoint({
      recordedAt: '2026-07-29T12:00:00.000Z',
      latitude: 53.8,
      longitude: -2.1,
      altitudeBarometricFt: null,
      altitudeGeometricFt: null,
      onGround: true,
      groundSpeedKt: 4,
      trackDeg: 90,
      verticalRateFpm: null,
      distanceNm: 2,
      bearingDeg: 100,
    })
    expect(result.altitudeFt).toBe(0)
  })

  it('falls back to geometric altitude for geometric-only tracks', () => {
    const result = adaptTrackPoint({
      recordedAt: '2026-07-29T12:00:00.000Z',
      latitude: 53.8,
      longitude: -2.1,
      altitudeBarometricFt: null,
      altitudeGeometricFt: 12_450,
      onGround: false,
      groundSpeedKt: 290,
      trackDeg: 90,
      verticalRateFpm: null,
      distanceNm: 12,
      bearingDeg: 100,
    })
    expect(result.altitudeFt).toBe(12_450)
  })
})
