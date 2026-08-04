import { altitudeBands } from './altitude-bands'
import { currentTheme, type ResolvedTheme } from './theme'
import {
  formatSpeed,
  formatVerticalRateValue,
  speedDisplayValue,
  verticalRateDisplayValue,
} from './format'
import type { UnitPreferences } from './unit-preferences'
import type { TrackPoint } from '../types'

/** What a history track's colour along its length means. */
export type TrackColourMode = 'altitude' | 'speed' | 'verticalRate'

/** The colour every mode gives a point whose value the receiver never decoded. */
const UNKNOWN: Record<ResolvedTheme, string> = { dark: '#8090a0', light: '#586e84' }

/**
 * One step of a colour ramp: the colour applies from `minimum` up to the next
 * step's minimum, and the top step is open-ended. `minimum` is in the canonical
 * unit of the measure — feet, knots, feet per minute — so the ramp itself does
 * not move when the reader's unit preference does; only its labels do.
 */
export interface ColourStep {
  key: string
  minimum: number
  colour: string
}

interface ColourMode {
  label: string
  steps: readonly ColourStep[]
  value: (point: TrackPoint) => number | null | undefined
}

/**
 * A mode whose legend this module labels. Altitude is the exception: its scale
 * is also the live map's altitude filter, so the map draws that one itself.
 */
interface RampMode extends ColourMode {
  /** The scale label under a legend segment, in the reader's units. */
  tick: (step: ColourStep, units: UnitPreferences) => string
  /** What a segment means, for the segment's tooltip and a screen reader. */
  description: (step: ColourStep, next: ColourStep | undefined, units: UnitPreferences) => string
}

/*
 * Altitude reuses the live map's ramp, so a track and the aircraft flying it
 * are the same colour. Speed runs cool-to-hot, and vertical rate diverges
 * around level flight on an orange/blue axis that survives the common forms of
 * colour blindness — a red-to-green axis would not.
 */
const speedSteps: Record<ResolvedTheme, readonly ColourStep[]> = {
  dark: [
    { key: 'ground', minimum: 0, colour: '#b7c0c8' },
    { key: 'slow', minimum: 60, colour: '#ffe08a' },
    { key: 'moderate', minimum: 150, colour: '#ffbe63' },
    { key: 'brisk', minimum: 250, colour: '#ff9350' },
    { key: 'fast', minimum: 350, colour: '#ff6f6b' },
    { key: 'veryFast', minimum: 450, colour: '#ff5f9e' },
  ],
  light: [
    { key: 'ground', minimum: 0, colour: '#76828d' },
    { key: 'slow', minimum: 60, colour: '#ab7f00' },
    { key: 'moderate', minimum: 150, colour: '#ad5f00' },
    { key: 'brisk', minimum: 250, colour: '#ad3d00' },
    { key: 'fast', minimum: 350, colour: '#a51e26' },
    { key: 'veryFast', minimum: 450, colour: '#950e50' },
  ],
}

const verticalRateSteps: Record<ResolvedTheme, readonly ColourStep[]> = {
  dark: [
    { key: 'steepDescent', minimum: Number.NEGATIVE_INFINITY, colour: '#ff9d4d' },
    { key: 'descent', minimum: -2_000, colour: '#ffcf8f' },
    { key: 'level', minimum: -500, colour: '#b7c0c8' },
    { key: 'climb', minimum: 500, colour: '#8fd0ff' },
    { key: 'steepClimb', minimum: 2_000, colour: '#3fa0ff' },
  ],
  light: [
    { key: 'steepDescent', minimum: Number.NEGATIVE_INFINITY, colour: '#962e00' },
    { key: 'descent', minimum: -2_000, colour: '#b87600' },
    { key: 'level', minimum: -500, colour: '#67737e' },
    { key: 'climb', minimum: 500, colour: '#0f88c9' },
    { key: 'steepClimb', minimum: 2_000, colour: '#004da8' },
  ],
}

/**
 * Built per call, like `altitudeBands`: every ramp has a variant per theme so
 * a track stays legible on a pale basemap as well as a dark one, and a
 * constant would freeze whichever theme loaded first.
 */
export function trackColourModes(theme: ResolvedTheme = currentTheme()): {
  altitude: ColourMode
  speed: RampMode
  verticalRate: RampMode
} {
  return {
    altitude: {
      label: 'Altitude',
      // The ground band shares its floor with the band above it; ordering keeps
      // it first, so a point at zero feet reads as on the ground.
      steps: altitudeBands(theme).map((band) => ({
        key: band.key,
        minimum: band.minimumFt,
        colour: band.colour,
      })),
      value: (point) => point.altitudeFt,
    },
    speed: {
      label: 'Ground speed',
      steps: speedSteps[theme],
      value: (point) => point.groundSpeedKt,
      tick: (step, units) => speedDisplayValue(step.minimum, units).toLocaleString('en-GB'),
      description: (step, next, units) =>
        describeRange(formatSpeed(step.minimum, units), next && formatSpeed(next.minimum, units)),
    },
    verticalRate: {
      label: 'Vertical rate',
      steps: verticalRateSteps[theme],
      value: (point) => point.verticalRateFpm,
      tick: (step, units) =>
        Number.isFinite(step.minimum)
          ? verticalRateDisplayValue(step.minimum, units).toLocaleString('en-GB')
          : '',
      description: (step, next, units) =>
        step.key === 'level'
          ? 'flying level'
          : describeRange(
              Number.isFinite(step.minimum) ? formatVerticalRateValue(step.minimum, units) : null,
              next && formatVerticalRateValue(next.minimum, units),
            ),
    },
  }
}

function describeRange(from: string | null, to: string | undefined): string {
  if (from == null) return `below ${to ?? ''}`.trim()
  return to == null ? `${from} and above` : `${from} to ${to}`
}

/**
 * The colour a point takes in a mode. Steps are ordered, so the last one the
 * value clears wins; a value the receiver never reported is grey in every mode
 * rather than borrowing the colour of the bottom step.
 */
export function trackColour(
  mode: TrackColourMode,
  point: TrackPoint,
  theme: ResolvedTheme = currentTheme(),
): string {
  const definition = trackColourModes(theme)[mode]
  const value = definition.value(point)
  const unknown = UNKNOWN[theme]
  if (value == null || !Number.isFinite(value)) return unknown
  let colour = unknown
  for (const step of definition.steps) {
    if (value >= step.minimum) colour = step.colour
  }
  return colour
}

/**
 * A track's colours as spans of wall-clock time, in epoch milliseconds. Spans
 * are contiguous — each begins where the last ended — so a strip drawn from
 * them has no seams, and a track carrying twenty thousand samples still yields
 * only as many spans as it has colour changes.
 */
export function colourSpans(
  points: readonly TrackPoint[],
  mode: TrackColourMode,
  theme: ResolvedTheme = currentTheme(),
): Array<{ start: number; end: number; colour: string }> {
  const spans: Array<{ start: number; end: number; colour: string }> = []
  for (const point of points) {
    const time = Date.parse(point.recordedAt)
    if (!Number.isFinite(time)) continue
    const colour = trackColour(mode, point, theme)
    const last = spans[spans.length - 1]
    if (!last) spans.push({ start: time, end: time, colour })
    else if (last.colour === colour) last.end = time
    // A span takes the colour of the point it arrives at, as the map and the
    // flight profile both do.
    else spans.push({ start: last.end, end: time, colour })
  }
  return spans
}
