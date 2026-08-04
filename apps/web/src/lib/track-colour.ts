import { altitudeBands } from './altitude-bands'
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
const UNKNOWN = '#8090a0'

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
const speedSteps: readonly ColourStep[] = [
  { key: 'ground', minimum: 0, colour: '#b7c0c8' },
  { key: 'slow', minimum: 60, colour: '#ffe08a' },
  { key: 'moderate', minimum: 150, colour: '#ffbe63' },
  { key: 'brisk', minimum: 250, colour: '#ff9350' },
  { key: 'fast', minimum: 350, colour: '#ff6f6b' },
  { key: 'veryFast', minimum: 450, colour: '#ff5f9e' },
]

const verticalRateSteps: readonly ColourStep[] = [
  { key: 'steepDescent', minimum: Number.NEGATIVE_INFINITY, colour: '#ff9d4d' },
  { key: 'descent', minimum: -2_000, colour: '#ffcf8f' },
  { key: 'level', minimum: -500, colour: '#b7c0c8' },
  { key: 'climb', minimum: 500, colour: '#8fd0ff' },
  { key: 'steepClimb', minimum: 2_000, colour: '#3fa0ff' },
]

export const trackColourModes: {
  altitude: ColourMode
  speed: RampMode
  verticalRate: RampMode
} = {
  altitude: {
    label: 'Altitude',
    // The ground band shares its floor with the band above it; ordering keeps
    // it first, so a point at zero feet reads as on the ground.
    steps: altitudeBands.map((band) => ({
      key: band.key,
      minimum: band.minimumFt,
      colour: band.colour,
    })),
    value: (point) => point.altitudeFt,
  },
  speed: {
    label: 'Ground speed',
    steps: speedSteps,
    value: (point) => point.groundSpeedKt,
    tick: (step, units) => speedDisplayValue(step.minimum, units).toLocaleString('en-GB'),
    description: (step, next, units) =>
      describeRange(formatSpeed(step.minimum, units), next && formatSpeed(next.minimum, units)),
  },
  verticalRate: {
    label: 'Vertical rate',
    steps: verticalRateSteps,
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

function describeRange(from: string | null, to: string | undefined): string {
  if (from == null) return `below ${to ?? ''}`.trim()
  return to == null ? `${from} and above` : `${from} to ${to}`
}

/**
 * The colour a point takes in a mode. Steps are ordered, so the last one the
 * value clears wins; a value the receiver never reported is grey in every mode
 * rather than borrowing the colour of the bottom step.
 */
export function trackColour(mode: TrackColourMode, point: TrackPoint): string {
  const definition = trackColourModes[mode]
  const value = definition.value(point)
  if (value == null || !Number.isFinite(value)) return UNKNOWN
  let colour = UNKNOWN
  for (const step of definition.steps) {
    if (value >= step.minimum) colour = step.colour
  }
  return colour
}
