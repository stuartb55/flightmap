import { afterEach, describe, expect, it } from 'vitest'
import {
  altitudeToFeet,
  aviationUnits,
  convertAltitude,
  convertDistance,
  convertSpeed,
  convertVerticalRate,
  distanceToNauticalMiles,
  metricUnits,
  presetUnits,
  readUnitPreferences,
  setUnitPreferences,
  speedToKnots,
  subscribeUnitPreferences,
  unitPreferences,
  unitPreset,
} from './unit-preferences'

function storageOf(value: string | null): Pick<Storage, 'getItem'> {
  return { getItem: () => value }
}

afterEach(() => {
  setUnitPreferences(aviationUnits)
})

describe('unit conversion', () => {
  it('converts canonical aviation values and back again', () => {
    expect(convertAltitude(10_000, 'ft')).toBe(10_000)
    expect(convertAltitude(10_000, 'm')).toBeCloseTo(3_048, 6)
    expect(altitudeToFeet(3_048, 'm')).toBeCloseTo(10_000, 6)
    expect(convertSpeed(100, 'kmh')).toBeCloseTo(185.2, 6)
    expect(convertSpeed(100, 'mph')).toBeCloseTo(115.0779, 6)
    expect(speedToKnots(185.2, 'kmh')).toBeCloseTo(100, 6)
    expect(speedToKnots(115.0779, 'mph')).toBeCloseTo(100, 6)
    expect(convertDistance(40, 'km')).toBeCloseTo(74.08, 6)
    expect(convertDistance(40, 'mi')).toBeCloseTo(46.03116, 5)
    expect(distanceToNauticalMiles(74.08, 'km')).toBeCloseTo(40, 6)
    expect(distanceToNauticalMiles(46.03116, 'mi')).toBeCloseTo(40, 5)
    expect(convertVerticalRate(1_200, 'fpm')).toBe(1_200)
    expect(convertVerticalRate(1_200, 'ms')).toBeCloseTo(6.096, 6)
  })

  it('names the preset a unit set belongs to', () => {
    expect(unitPreset(aviationUnits)).toBe('aviation')
    expect(unitPreset(metricUnits)).toBe('metric')
    expect(unitPreset({ ...metricUnits, speed: 'mph' })).toBe('custom')
    expect(presetUnits('metric')).toEqual(metricUnits)
    expect(presetUnits('aviation')).toEqual(aviationUnits)
  })
})

describe('stored preferences', () => {
  it('falls back to aviation units for absent, corrupt or unknown values', () => {
    expect(readUnitPreferences(storageOf(null))).toEqual(aviationUnits)
    expect(readUnitPreferences(storageOf('{not json'))).toEqual(aviationUnits)
    expect(readUnitPreferences(storageOf('"metric"'))).toEqual(aviationUnits)
    expect(readUnitPreferences(storageOf(JSON.stringify({ altitude: 'furlongs' })))).toEqual(
      aviationUnits,
    )
  })

  it('keeps recognised fields when others are unusable', () => {
    const stored = JSON.stringify({ altitude: 'm', speed: 'nonsense', distance: 'km' })
    expect(readUnitPreferences(storageOf(stored))).toEqual({
      altitude: 'm',
      speed: 'kt',
      distance: 'km',
      verticalRate: 'fpm',
    })
  })

  it('persists a change and tells subscribers about it', () => {
    let notifications = 0
    const unsubscribe = subscribeUnitPreferences(() => {
      notifications += 1
    })
    setUnitPreferences(metricUnits)
    expect(notifications).toBe(1)
    expect(unitPreferences()).toEqual(metricUnits)
    expect(readUnitPreferences()).toEqual(metricUnits)
    unsubscribe()
    setUnitPreferences(aviationUnits)
    expect(notifications).toBe(1)
  })
})
