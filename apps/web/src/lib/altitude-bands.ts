import { altitudeColour } from './format'
import type { ResolvedTheme } from './theme'

/**
 * The altitude ramp the map colours aircraft by, as discrete bands. The legend
 * draws one segment per band and can isolate a band, which writes through to
 * the altitude filter so the table and the map always agree about what is on
 * screen.
 *
 * Boundaries mirror `altitudeColour`; a band's maximum is the next band's
 * minimum, so an aircraft sitting exactly on a boundary matches either.
 */
export interface AltitudeBand {
  key: string
  /** Inclusive lower bound in feet. Ground is its own band at zero. */
  minimumFt: number
  /** Inclusive upper bound in feet, or null for the open-ended top band. */
  maximumFt: number | null
  colour: string
}

/**
 * Computed per call rather than held as a constant: `altitudeColour` answers
 * differently under each theme, and a legend built at module load would keep
 * the ramp of whichever theme happened to be in force first.
 */
export function altitudeBands(theme?: ResolvedTheme): readonly AltitudeBand[] {
  const colour = (altitude: Parameters<typeof altitudeColour>[0]) =>
    altitudeColour(altitude, theme)
  return [
    { key: 'ground', minimumFt: 0, maximumFt: 0, colour: colour('ground') },
    { key: 'low', minimumFt: 0, maximumFt: 3_000, colour: colour(1_000) },
    { key: 'lower', minimumFt: 3_000, maximumFt: 10_000, colour: colour(5_000) },
    { key: 'middle', minimumFt: 10_000, maximumFt: 20_000, colour: colour(15_000) },
    { key: 'high', minimumFt: 20_000, maximumFt: 30_000, colour: colour(25_000) },
    { key: 'veryHigh', minimumFt: 30_000, maximumFt: 40_000, colour: colour(35_000) },
    { key: 'extreme', minimumFt: 40_000, maximumFt: null, colour: colour(45_000) },
  ]
}

export interface AltitudeRange {
  minimum: string
  maximum: string
}

/** The filter values that isolate a band, in the canonical feet the filter stores. */
export function bandRange(band: AltitudeBand): AltitudeRange {
  return {
    minimum: String(band.minimumFt),
    maximum: band.maximumFt == null ? '' : String(band.maximumFt),
  }
}

/**
 * The band a filter range isolates, if it isolates one. Any other range — a
 * hand-typed minimum, a span across bands — leaves the legend showing nothing
 * as pressed rather than guessing at the nearest match.
 */
export function bandForRange(range: AltitudeRange): AltitudeBand | null {
  return (
    altitudeBands().find((band) => {
      const target = bandRange(band)
      return target.minimum === range.minimum.trim() && target.maximum === range.maximum.trim()
    }) ?? null
  )
}

/** Toggles a band: pressing the isolated one again clears the altitude filter. */
export function toggleBand(band: AltitudeBand, current: AltitudeRange): AltitudeRange {
  return bandForRange(current)?.key === band.key ? { minimum: '', maximum: '' } : bandRange(band)
}
