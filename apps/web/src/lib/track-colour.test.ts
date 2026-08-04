import { describe, expect, it } from 'vitest'
import { trackColour, trackColourModes } from './track-colour'
import { altitudeBands } from './altitude-bands'
import { aviationUnits, metricUnits } from './unit-preferences'
import type { TrackPoint } from '../types'

const point = (overrides: Partial<TrackPoint> = {}): TrackPoint => ({
  recordedAt: '2026-08-01T10:00:00.000Z',
  latitude: 53.4,
  longitude: -2.3,
  altitudeFt: 12_000,
  groundSpeedKt: 400,
  trackDegrees: 90,
  ...overrides,
})

describe('track colouring', () => {
  it('gives a track the same altitude colours the live map uses', () => {
    for (const band of altitudeBands) {
      if (band.key === 'ground') continue
      expect(trackColour('altitude', point({ altitudeFt: band.minimumFt + 1 }))).toBe(band.colour)
    }
  })

  it('colours by the step a value clears, not the one it approaches', () => {
    const steps = trackColourModes.speed.steps
    for (const [index, step] of steps.entries()) {
      const next = steps[index + 1]
      expect(trackColour('speed', point({ groundSpeedKt: step.minimum }))).toBe(step.colour)
      if (next) {
        expect(trackColour('speed', point({ groundSpeedKt: next.minimum - 1 }))).toBe(step.colour)
      }
    }
  })

  it('diverges around level flight, and treats a steep descent as its own end', () => {
    const level = trackColour('verticalRate', point({ verticalRateFpm: 0 }))
    expect(trackColour('verticalRate', point({ verticalRateFpm: -3_000 }))).not.toBe(level)
    expect(trackColour('verticalRate', point({ verticalRateFpm: 3_000 }))).not.toBe(level)
    expect(trackColour('verticalRate', point({ verticalRateFpm: -3_000 }))).not.toBe(
      trackColour('verticalRate', point({ verticalRateFpm: 3_000 })),
    )
  })

  it('marks a value the receiver never reported rather than colouring it lowest', () => {
    const unknown = trackColour('speed', point({ groundSpeedKt: null }))
    expect(unknown).not.toBe(trackColourModes.speed.steps[0]?.colour)
    expect(trackColour('verticalRate', point({ verticalRateFpm: undefined }))).toBe(unknown)
    expect(trackColour('altitude', point({ altitudeFt: null }))).toBe(unknown)
  })

  it('labels a ramp in the reader own units without moving its boundaries', () => {
    const step = trackColourModes.speed.steps.find((item) => item.minimum === 150)!
    expect(trackColourModes.speed.tick(step, aviationUnits)).toBe('150')
    expect(trackColourModes.speed.tick(step, metricUnits)).toBe('278')
    expect(trackColourModes.speed.description(step, undefined, aviationUnits)).toBe(
      '150 kt and above',
    )
  })

  it('describes the open-ended descent step without printing an infinite rate', () => {
    const steps = trackColourModes.verticalRate.steps
    const steepest = steps[0]!
    expect(trackColourModes.verticalRate.tick(steepest, aviationUnits)).toBe('')
    expect(trackColourModes.verticalRate.description(steepest, steps[1], aviationUnits)).toBe(
      'below -2,000 ft/min',
    )
  })
})
