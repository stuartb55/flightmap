import { describe, expect, it } from 'vitest'
import { defaultInsightSeries } from '@flightmap/shared'
import { readInsightSeries } from './insight-preferences'

const stored = (value: string | null) => ({ getItem: () => value })

describe('insight series preferences', () => {
  it('reads a stored choice back', () => {
    expect(
      readInsightSeries(
        stored(JSON.stringify({ reports: false, positionedReports: true, receiverAvailability: false })),
      ),
    ).toEqual({ reports: false, positionedReports: true, receiverAvailability: false })
  })

  it('falls back to every series shown rather than withholding data', () => {
    expect(readInsightSeries(stored(null))).toEqual(defaultInsightSeries)
    expect(readInsightSeries(stored('not json'))).toEqual(defaultInsightSeries)
    expect(readInsightSeries(stored('{"reports":"yes"}'))).toEqual(defaultInsightSeries)
    expect(
      readInsightSeries({
        getItem: () => {
          throw new Error('Storage is disabled')
        },
      }),
    ).toEqual(defaultInsightSeries)
  })

  it('fills a partial stored choice from the defaults', () => {
    // A preference written before a series existed must not hide it.
    expect(readInsightSeries(stored('{"reports":false}'))).toEqual({
      ...defaultInsightSeries,
      reports: false,
    })
  })
})
