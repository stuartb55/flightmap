import { describe, expect, it } from 'vitest'
import { dateTimeInputToIso, formatDateTimeInput } from './format'

describe('configured display time-zone inputs', () => {
  it('round-trips a summer date through Europe/London', () => {
    const instant = new Date('2026-07-29T12:30:00.000Z')
    expect(formatDateTimeInput(instant)).toBe('2026-07-29T13:30')
    expect(dateTimeInputToIso('2026-07-29T13:30')).toBe('2026-07-29T12:30:00.000Z')
  })

  it('rejects a local time skipped by daylight saving', () => {
    expect(() => dateTimeInputToIso('2026-03-29T01:30')).toThrow(/does not exist/)
  })
})
