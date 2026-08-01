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
