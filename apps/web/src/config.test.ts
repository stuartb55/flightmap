import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyRuntimeConfig,
  displayTimeZone,
  mapWaypoints,
  runtimeConfig,
  subscribeRuntimeConfig,
} from './config'
import { formatTime } from './lib/format'

describe('runtime configuration', () => {
  beforeEach(() => {
    applyRuntimeConfig({
      mapStyleUrl: 'https://tiles.example/styles/dark',
      displayTimeZone: 'Europe/London',
      rangeRingsNm: [10, 20],
      mapWaypoints: [],
      receiverName: 'Home receiver',
      receiverLatitude: 53.61,
      receiverLongitude: -2.31,
    })
  })

  it('applies settings saved in the running app without a reload', () => {
    const instant = '2026-07-29T12:30:05.000Z'
    expect(formatTime(instant)).toBe('13:30:05')

    applyRuntimeConfig({ displayTimeZone: 'UTC', mapStyleUrl: 'https://tiles.example/light' })

    expect(displayTimeZone()).toBe('UTC')
    expect(formatTime(instant)).toBe('12:30:05')
    expect(runtimeConfig().mapStyleUrl).toBe('https://tiles.example/light')
    // Values the update did not mention are preserved.
    expect(runtimeConfig().rangeRingsNm).toEqual([10, 20])
  })

  it('notifies subscribers and keeps only valid waypoints', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeRuntimeConfig(listener)

    applyRuntimeConfig({
      mapWaypoints: [
        { name: 'ROSUN', kind: 'arrival', latitude: 53.67, longitude: -2.35 },
        { name: 'BROKEN', kind: 'sideways', latitude: 0, longitude: 0 },
        'nonsense',
      ],
    })

    expect(listener).toHaveBeenCalled()
    expect(mapWaypoints().map((waypoint) => waypoint.name)).toEqual(['ROSUN'])
    unsubscribe()
  })

  it('ignores non-positive range rings', () => {
    applyRuntimeConfig({ rangeRingsNm: [0, -5, 30] })
    expect(runtimeConfig().rangeRingsNm).toEqual([30])
  })
})
