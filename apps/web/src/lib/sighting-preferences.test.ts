import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultSightingThreshold,
  isNewSighting,
  newSightingCutoff,
  readSightingThreshold,
  sessionStartedAt,
  setSightingThreshold,
  sightingThreshold,
  subscribeSightingThreshold,
} from './sighting-preferences'

function storageOf(value: string | null): Pick<Storage, 'getItem'> {
  return { getItem: () => value }
}

afterEach(() => {
  setSightingThreshold(defaultSightingThreshold)
})

const NOW = Date.parse('2026-08-05T12:00:30.500Z')

describe('sighting threshold storage', () => {
  it('defaults to this session, which is the least noisy useful window', () => {
    expect(defaultSightingThreshold).toBe('session')
    expect(readSightingThreshold(storageOf(null))).toBe('session')
  })

  it('reads a stored choice back', () => {
    expect(readSightingThreshold(storageOf('week'))).toBe('week')
    expect(readSightingThreshold(storageOf('off')).valueOf()).toBe('off')
  })

  it('falls back to the default rather than blocking on corrupt storage', () => {
    expect(readSightingThreshold(storageOf('last tuesday'))).toBe('session')
    expect(readSightingThreshold(storageOf('{"threshold":"day"}'))).toBe('session')
    expect(
      readSightingThreshold({
        getItem() {
          throw new Error('storage disabled')
        },
      }),
    ).toBe('session')
  })

  it('notifies subscribers so a change in Settings repaints the live surfaces', () => {
    let notified = 0
    const unsubscribe = subscribeSightingThreshold(() => {
      notified += 1
    })
    setSightingThreshold('day')
    expect(sightingThreshold()).toBe('day')
    expect(notified).toBe(1)
    unsubscribe()
    setSightingThreshold('week')
    expect(notified).toBe(1)
  })
})

describe('the session anchor', () => {
  it('is written once and read back, so a reload keeps the same session', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    expect(sessionStartedAt(storage, NOW)).toBe(NOW)
    // A reload calls it again with a later clock and must get the first answer.
    expect(sessionStartedAt(storage, NOW + 600_000)).toBe(NOW)
  })

  it('survives storage that throws, rather than taking the page down with it', () => {
    const hostile = {
      getItem() {
        throw new Error('storage disabled')
      },
      setItem() {
        throw new Error('storage disabled')
      },
    }
    expect(Number.isFinite(sessionStartedAt(hostile, NOW))).toBe(true)
  })

  it('ignores a stored anchor that is not a usable timestamp', () => {
    const store = new Map<string, string>([[
      'flightmap.session-start.v1',
      'the beginning of time',
    ]])
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    expect(sessionStartedAt(storage, NOW)).toBe(NOW)
  })
})

describe('the new-sighting cutoff', () => {
  it('is null when the marker is off, which every surface reads as "mark nothing"', () => {
    expect(newSightingCutoff('off', NOW, NOW - 1_000)).toBeNull()
  })

  it('is the session anchor exactly, not a rounded version of it', () => {
    expect(newSightingCutoff('session', NOW, 1_754_395_230_500)).toBe(1_754_395_230_500)
  })

  /*
   * Rolling windows are floored to the minute so the value is stable between
   * renders: `orderAircraft` compares it to decide whether the previous order
   * can be reused, and a millisecond-precision cutoff would force a re-filter
   * and re-sort of the whole list on every 1 Hz tick.
   */
  it('quantises rolling windows to the minute so the list order can be reused', () => {
    const day = newSightingCutoff('day', NOW)!
    expect(day % 60_000).toBe(0)
    expect(newSightingCutoff('day', NOW + 1_000)).toBe(day)
    expect(NOW - day).toBeGreaterThanOrEqual(24 * 60 * 60 * 1_000)
    expect(NOW - day).toBeLessThan(24 * 60 * 60 * 1_000 + 60_000)

    const week = newSightingCutoff('week', NOW)!
    expect(week % 60_000).toBe(0)
    expect(NOW - week).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1_000)
  })
})

describe('deciding whether a sighting is new', () => {
  const cutoff = Date.parse('2026-08-05T00:00:00.000Z')

  it('marks an airframe first heard at or after the cutoff', () => {
    expect(isNewSighting('2026-08-05T09:00:00.000Z', cutoff)).toBe(true)
    expect(isNewSighting('2026-08-05T00:00:00.000Z', cutoff)).toBe(true)
  })

  it('leaves an airframe heard before the cutoff alone', () => {
    expect(isNewSighting('2026-08-04T23:59:59.999Z', cutoff)).toBe(false)
    expect(isNewSighting('2019-03-02T10:00:00.000Z', cutoff)).toBe(false)
  })

  /*
   * An aircraft with no `aircraft_summary` row has no first-seen time. That is
   * unknown, not new: claiming it as a first sighting would be the one thing
   * this feature must never do, which is assert something the receiver has not
   * observed.
   */
  it('never marks an airframe with no summary row', () => {
    expect(isNewSighting(null, cutoff)).toBe(false)
    expect(isNewSighting(undefined, cutoff)).toBe(false)
    expect(isNewSighting('not a timestamp', cutoff)).toBe(false)
  })

  it('marks nothing at all when the cutoff is null', () => {
    expect(isNewSighting('2026-08-05T09:00:00.000Z', null)).toBe(false)
  })
})
