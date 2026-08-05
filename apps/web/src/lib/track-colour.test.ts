import { describe, expect, it } from 'vitest'
import {
  colourSpans,
  comparisonDimming,
  trackColour,
  trackColourModes,
  trackIdentity,
} from './track-colour'
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
    for (const band of altitudeBands()) {
      if (band.key === 'ground') continue
      expect(trackColour('altitude', point({ altitudeFt: band.minimumFt + 1 }))).toBe(band.colour)
    }
  })

  it('colours by the step a value clears, not the one it approaches', () => {
    const steps = trackColourModes().speed.steps
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
    expect(unknown).not.toBe(trackColourModes().speed.steps[0]?.colour)
    expect(trackColour('verticalRate', point({ verticalRateFpm: undefined }))).toBe(unknown)
    expect(trackColour('altitude', point({ altitudeFt: null }))).toBe(unknown)
  })

  it('labels a ramp in the reader own units without moving its boundaries', () => {
    const step = trackColourModes().speed.steps.find((item) => item.minimum === 150)!
    expect(trackColourModes().speed.tick(step, aviationUnits)).toBe('150')
    expect(trackColourModes().speed.tick(step, metricUnits)).toBe('278')
    expect(trackColourModes().speed.description(step, undefined, aviationUnits)).toBe(
      '150 kt and above',
    )
  })

  it('folds a track into contiguous spans, one per colour change', () => {
    const at = (minute: number, altitudeFt: number) =>
      point({
        recordedAt: new Date(Date.parse('2026-08-01T10:00:00.000Z') + minute * 60_000).toISOString(),
        altitudeFt,
      })
    const spans = colourSpans([at(0, 1_000), at(1, 2_000), at(2, 25_000), at(3, 26_000)], 'altitude')

    expect(spans).toHaveLength(2)
    expect(spans[0]?.start).toBe(Date.parse('2026-08-01T10:00:00.000Z'))
    // No seam: the second span begins exactly where the first ended.
    expect(spans[1]?.start).toBe(spans[0]?.end)
    expect(spans[1]?.end).toBe(Date.parse('2026-08-01T10:03:00.000Z'))
    expect(spans[0]?.colour).not.toBe(spans[1]?.colour)
  })

  it('describes the open-ended descent step without printing an infinite rate', () => {
    const steps = trackColourModes().verticalRate.steps
    const steepest = steps[0]!
    expect(trackColourModes().verticalRate.tick(steepest, aviationUnits)).toBe('')
    expect(trackColourModes().verticalRate.description(steepest, steps[1], aviationUnits)).toBe(
      'below -2,000 ft/min',
    )
  })
})

/**
 * The ramps are drawn onto a basemap, so they are graphical objects carrying
 * information: WCAG 1.4.11 asks for 3:1 against what they sit on. The dark
 * ramps were authored against a dark basemap and fail badly on a pale one,
 * which is the whole reason a second set exists.
 */
describe('ramp contrast against the basemap of each theme', () => {
  const channel = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4

  const luminance = (hex: string) => {
    const [red, green, blue] = [1, 3, 5].map((index) =>
      channel(parseInt(hex.slice(index, index + 2), 16) / 255),
    )
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
  }

  const contrast = (one: string, two: string) => {
    const [brighter, darker] = [luminance(one), luminance(two)].sort((a, b) => b - a)
    return (brighter! + 0.05) / (darker! + 0.05)
  }

  // Representative land colours from the dark and the bright OpenFreeMap styles.
  const basemap = { dark: '#0c1319', light: '#f8f4f0' } as const

  it.each(['dark', 'light'] as const)('keeps every %s ramp legible', (theme) => {
    const modes = trackColourModes(theme)
    for (const mode of [modes.altitude, modes.speed, modes.verticalRate]) {
      for (const step of mode.steps) {
        expect(
          contrast(step.colour, basemap[theme]),
          `${mode.label} ${step.key} (${step.colour}) on the ${theme} basemap`,
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('gives each theme its own ramp rather than reusing one', () => {
    const dark = trackColourModes('dark')
    const light = trackColourModes('light')
    for (const key of ['altitude', 'speed', 'verticalRate'] as const) {
      expect(dark[key].steps.map((step) => step.colour)).not.toEqual(
        light[key].steps.map((step) => step.colour),
      )
    }
  })
})

describe('track identity', () => {
  // Duplicated from the ramp suite above: the profile panel is a panel, not the
  // basemap, so the identity colours are judged against what they sit on.
  const panel = { dark: '#0d131a', light: '#e5e7eb' } as const
  const relative = (hex: string) => {
    const channels = [1, 3, 5]
      .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
  }
  const ratio = (one: string, two: string) => {
    const [brighter, darker] = [relative(one), relative(two)].sort((a, b) => b - a)
    return (brighter! + 0.05) / (darker! + 0.05)
  }
  // History caps the selection at eight, so eight is what has to be distinct.
  const slots = [0, 1, 2, 3, 4, 5, 6, 7]

  it.each(['dark', 'light'] as const)('keeps every %s identity legible on the panel', (theme) => {
    for (const slot of slots) {
      const identity = trackIdentity(slot, theme)
      expect(
        ratio(identity.colour, panel[theme]),
        `series ${slot} (${identity.colour}) on the ${theme} panel`,
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('gives a whole selection distinct colours and distinct dashes', () => {
    for (const theme of ['dark', 'light'] as const) {
      const identities = slots.map((slot) => trackIdentity(slot, theme))
      expect(new Set(identities.map((identity) => identity.colour)).size).toBe(slots.length)
      // Colour is never the only difference: the dash and its name carry it too.
      expect(new Set(identities.map((identity) => identity.dash)).size).toBe(slots.length)
      expect(new Set(identities.map((identity) => identity.pattern)).size).toBe(slots.length)
    }
    expect(trackIdentity(0, 'dark').colour).not.toBe(trackIdentity(0, 'light').colour)
  })

  it('keeps a dimmed series above the threshold it was chosen against', () => {
    // Dimming is compositing: the line the reader sees is the identity colour
    // mixed with the panel, and it is that mix which has to clear 3:1.
    const mix = (hex: string, background: string) =>
      `#${[1, 3, 5]
        .map((offset) => {
          const front = Number.parseInt(hex.slice(offset, offset + 2), 16)
          const behind = Number.parseInt(background.slice(offset, offset + 2), 16)
          return Math.round(front * comparisonDimming + behind * (1 - comparisonDimming))
            .toString(16)
            .padStart(2, '0')
        })
        .join('')}`
    for (const theme of ['dark', 'light'] as const) {
      for (const slot of slots) {
        const identity = trackIdentity(slot, theme)
        expect(
          ratio(mix(identity.colour, panel[theme]), panel[theme]),
          `dimmed series ${slot} (${identity.colour}) on the ${theme} panel`,
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('wraps rather than running out, and tolerates a nonsense index', () => {
    expect(trackIdentity(8, 'dark')).toEqual(trackIdentity(0, 'dark'))
    expect(trackIdentity(-1, 'dark')).toEqual(trackIdentity(7, 'dark'))
    expect(trackIdentity(1.6, 'dark')).toEqual(trackIdentity(1, 'dark'))
  })
})
