import { describe, expect, it, vi } from 'vitest'
import {
  interpolateTrack,
  isEmergencyAircraft,
  replayPointAtTime,
  resolveStyleImageAlias,
} from './RadarMap'
import type { TrackPoint } from '../types'

describe('track interpolation', () => {
  const points: TrackPoint[] = [
    {
      recordedAt: '2026-07-29T12:00:00.000Z',
      latitude: 53,
      longitude: -2,
      altitudeFt: 10_000,
      groundSpeedKt: 300,
      trackDegrees: 90,
    },
    {
      recordedAt: '2026-07-29T12:00:10.000Z',
      latitude: 54,
      longitude: -1,
      altitudeFt: 12_000,
      groundSpeedKt: 320,
      trackDegrees: 100,
    },
  ]

  it('interpolates between stored source-of-truth samples', () => {
    const result = interpolateTrack(points, Date.parse('2026-07-29T12:00:05.000Z'))
    expect(result).toMatchObject({
      latitude: 53.5,
      longitude: -1.5,
      altitudeFt: 11_000,
      groundSpeedKt: 310,
      trackDegrees: 95,
    })
  })

  it('clamps to the first and last samples', () => {
    expect(interpolateTrack(points, Date.parse('2026-07-29T11:00:00.000Z'))).toBe(points[0])
    expect(interpolateTrack(points, Date.parse('2026-07-29T13:00:00.000Z'))).toBe(points[1])
  })

  it('omits a replay marker outside its session time range', () => {
    expect(replayPointAtTime(points, Date.parse('2026-07-29T11:59:59.000Z'))).toBeNull()
    expect(replayPointAtTime(points, Date.parse('2026-07-29T12:00:11.000Z'))).toBeNull()
    expect(replayPointAtTime(points, Date.parse('2026-07-29T12:00:05.000Z'))?.latitude).toBe(53.5)
  })

  it('distinguishes emergencies from ordinary alert states', () => {
    expect(isEmergencyAircraft({ squawk: '7700', emergency: 'none' })).toBe(true)
    expect(isEmergencyAircraft({ squawk: '1234', emergency: 'no emergency' })).toBe(false)
    expect(isEmergencyAircraft({ squawk: '1234', emergency: 'no_emergency' })).toBe(false)
    expect(isEmergencyAircraft({ squawk: '1234', emergency: 'general' })).toBe(true)
  })
})

describe('resolveStyleImageAlias', () => {
  it('registers the OpenFreeMap circle image under the ID used by its style', () => {
    const source = {
      data: {
        width: 15,
        height: 15,
        data: new Uint8Array(15 * 15 * 4),
      },
      pixelRatio: 1,
      sdf: false,
    }
    const map = {
      hasImage: vi.fn((id: string) => id === 'circle_11'),
      getImage: vi.fn(() => source),
      addImage: vi.fn(),
    }

    resolveStyleImageAlias(map as never, 'circle-11')

    expect(map.getImage).toHaveBeenCalledWith('circle_11')
    expect(map.addImage).toHaveBeenCalledWith(
      'circle-11',
      {
        width: 15,
        height: 15,
        data: source.data.data,
      },
      expect.objectContaining({ pixelRatio: 1, sdf: false }),
    )
  })

  it('ignores unrelated missing images', () => {
    const map = {
      hasImage: vi.fn(),
      getImage: vi.fn(),
      addImage: vi.fn(),
    }

    resolveStyleImageAlias(map as never, 'airport')

    expect(map.hasImage).not.toHaveBeenCalled()
    expect(map.getImage).not.toHaveBeenCalled()
    expect(map.addImage).not.toHaveBeenCalled()
  })
})
