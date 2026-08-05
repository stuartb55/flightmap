import { describe, expect, it } from 'vitest'
import { defaultMapLayers, readMapLayers } from './map-preferences'

describe('map layer preferences', () => {
  it('restores strictly validated browser-local choices', () => {
    const layers = { ...defaultMapLayers, coverage: true, aircraftLabels: false }
    expect(readMapLayers({ getItem: () => JSON.stringify(layers) })).toEqual(layers)
  })

  it('falls back safely when storage is malformed or incomplete', () => {
    expect(readMapLayers({ getItem: () => '{broken' })).toEqual(defaultMapLayers)
    expect(readMapLayers({ getItem: () => JSON.stringify({ coverage: true }) })).toEqual(
      defaultMapLayers,
    )
  })
})

/*
 * `mapLayerPreferencesSchema` is strict, so every key added after the original
 * set has to carry a default or a preference written before it stops parsing
 * and the reader silently loses every other choice they had made.
 */
describe('layer keys added after the original set', () => {
  it('accepts a stored preference written before the airport layer existed', () => {
    const { airports, ...beforeAirports } = defaultMapLayers
    expect(airports).toBe(false)
    expect(readMapLayers({ getItem: () => JSON.stringify({ ...beforeAirports, coverage: true }) }))
      .toEqual({ ...defaultMapLayers, coverage: true })
  })

  it('keeps the airport layer off by default, since most deployments have no data', () => {
    expect(defaultMapLayers.airports).toBe(false)
  })
})
