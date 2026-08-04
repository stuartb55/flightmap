import { describe, expect, it } from 'vitest'
import { altitudeBands, bandForRange, bandRange, toggleBand } from './altitude-bands'

const band = (key: string) => altitudeBands().find((item) => item.key === key)!

describe('altitude bands', () => {
  it('covers the colour ramp from the ground upwards without a gap', () => {
    const flying = altitudeBands().filter((item) => item.key !== 'ground')
    for (const [index, item] of flying.entries()) {
      if (index === 0) expect(item.minimumFt).toBe(0)
      else expect(item.minimumFt).toBe(flying[index - 1]!.maximumFt)
    }
    expect(flying.at(-1)?.maximumFt).toBeNull()
  })

  it('isolates a band with canonical feet, open-ended at the top', () => {
    expect(bandRange(band('high'))).toEqual({ minimum: '20000', maximum: '30000' })
    expect(bandRange(band('extreme'))).toEqual({ minimum: '40000', maximum: '' })
    expect(bandRange(band('ground'))).toEqual({ minimum: '0', maximum: '0' })
  })

  it('recognises a filter range that matches a band', () => {
    expect(bandForRange({ minimum: '20000', maximum: '30000' })?.key).toBe('high')
    expect(bandForRange({ minimum: ' 40000 ', maximum: '' })?.key).toBe('extreme')
  })

  it('claims nothing for a range that spans or splits bands', () => {
    expect(bandForRange({ minimum: '', maximum: '' })).toBeNull()
    expect(bandForRange({ minimum: '12000', maximum: '18000' })).toBeNull()
    expect(bandForRange({ minimum: '20000', maximum: '40000' })).toBeNull()
  })

  it('clears the filter when the isolated band is pressed again', () => {
    const isolated = toggleBand(band('middle'), { minimum: '', maximum: '' })
    expect(isolated).toEqual({ minimum: '10000', maximum: '20000' })
    expect(toggleBand(band('middle'), isolated)).toEqual({ minimum: '', maximum: '' })
  })

  it('moves straight from one band to another', () => {
    expect(toggleBand(band('low'), bandRange(band('extreme')))).toEqual(bandRange(band('low')))
  })
})
