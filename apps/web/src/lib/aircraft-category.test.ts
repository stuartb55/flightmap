import { describe, expect, it } from 'vitest'
import {
  aircraftShape,
  aircraftShapes,
  categoryLabel,
  categoryOptionLabel,
  normaliseCategory,
  shapeLabels,
  shapeOutlines,
  shapePoints,
} from './aircraft-category'

describe('aircraftShape', () => {
  it('maps the emitter categories that change the map picture', () => {
    expect(aircraftShape({ category: 'A1' })).toBe('light')
    expect(aircraftShape({ category: 'A3' })).toBe('standard')
    expect(aircraftShape({ category: 'A5' })).toBe('heavy')
    expect(aircraftShape({ category: 'A6' })).toBe('highPerformance')
    expect(aircraftShape({ category: 'A7' })).toBe('rotorcraft')
    expect(aircraftShape({ category: 'B1' })).toBe('glider')
    expect(aircraftShape({ category: 'B6' })).toBe('drone')
    expect(aircraftShape({ category: 'C2' })).toBe('ground')
  })

  it('accepts lowercase and padded receiver values', () => {
    expect(aircraftShape({ category: ' a7 ' })).toBe('rotorcraft')
    expect(normaliseCategory(' a7 ')).toBe('A7')
    expect(normaliseCategory('   ')).toBeNull()
    expect(normaliseCategory(null)).toBeNull()
  })

  it('falls back to the airliner glyph for unknown or absent categories', () => {
    expect(aircraftShape({ category: 'A0' })).toBe('standard')
    expect(aircraftShape({ category: 'Z9' })).toBe('standard')
    expect(aircraftShape({})).toBe('standard')
    expect(aircraftShape({ category: null, typeCode: null })).toBe('standard')
  })

  it('recovers heavies and rotorcraft from the type code when no category is sent', () => {
    expect(aircraftShape({ typeCode: 'A388' })).toBe('heavy')
    expect(aircraftShape({ typeCode: 'b77w' })).toBe('heavy')
    expect(aircraftShape({ typeCode: 'EC35' })).toBe('rotorcraft')
    expect(aircraftShape({ typeCode: 'A320' })).toBe('standard')
  })

  it('prefers a transmitted category over the type-code fallback', () => {
    expect(aircraftShape({ category: 'A1', typeCode: 'A388' })).toBe('light')
  })
})

describe('category labels', () => {
  it('names the categories a user sees in the filter', () => {
    expect(categoryLabel('A3')).toBe('Large')
    expect(categoryLabel('a7')).toBe('Rotorcraft')
    expect(categoryLabel('Z9')).toBeNull()
    expect(categoryLabel(null)).toBeNull()
  })

  it('pairs the code with its meaning, and degrades to the raw code', () => {
    expect(categoryOptionLabel('A3')).toBe('A3 · Large')
    expect(categoryOptionLabel('Z9')).toBe('Z9')
  })
})

describe('shape geometry', () => {
  it('provides an outline and a label for every generated shape', () => {
    for (const shape of aircraftShapes) {
      expect(shapeOutlines[shape].length).toBeGreaterThanOrEqual(4)
      expect(shapeLabels[shape]).toBeTruthy()
    }
  })

  it('keeps every vertex inside the 34x34 icon box', () => {
    for (const shape of aircraftShapes) {
      for (const [x, y] of shapeOutlines[shape]) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(34)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(34)
      }
    }
  })

  it('renders the shared outline as SVG points', () => {
    expect(shapePoints('drone')).toBe('17,3 30,29 17,22 4,29')
  })
})
