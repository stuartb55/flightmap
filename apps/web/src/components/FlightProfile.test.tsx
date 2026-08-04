import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlightProfile } from './FlightProfile'
import { trackColour } from '../lib/track-colour'
import type { TrackResponse } from '../types'

const track: TrackResponse = {
  session: {
    id: '11111111-1111-4111-8111-111111111111',
    icao: 'abc123',
    callsigns: ['TEST1'],
    registration: 'G-TEST',
    typeCode: 'A320',
    operator: 'Test Air',
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: '2026-08-01T10:01:00.000Z',
    sampleCount: 2,
    minimumAltitudeFt: 1000,
    maximumAltitudeFt: 2000,
    maximumSpeedKt: 150,
    closestDistanceNm: 10,
    hasDetailedTrack: true,
    alertKinds: [],
  },
  resolution: '1s',
  points: [
    { recordedAt: '2026-08-01T10:00:00.000Z', latitude: 53.6, longitude: -2.3, altitudeFt: 1000, groundSpeedKt: 120, trackDegrees: 90, verticalRateFpm: 500, distanceNm: 12, bearingDegrees: 180 },
    { recordedAt: '2026-08-01T10:01:00.000Z', latitude: 53.7, longitude: -2.2, altitudeFt: 2000, groundSpeedKt: 150, trackDegrees: 95, verticalRateFpm: 1000, distanceNm: 10, bearingDegrees: 170 },
  ],
  events: [{ type: 'closest_approach', occurredAt: '2026-08-01T10:01:00.000Z', label: 'Closest approach', value: '10 nm', severity: 'info' }],
  truncated: false,
}

afterEach(cleanup)

describe('FlightProfile', () => {
  it('switches telemetry metrics and exposes event navigation', () => {
    const onReplayTime = vi.fn()
    render(<FlightProfile track={track} replayTime={Date.parse(track.points[0]!.recordedAt)} onReplayTime={onReplayTime} />)
    expect(screen.getByRole('region', { name: 'Flight profile and event timeline' })).toHaveTextContent('TEST1')
    fireEvent.click(screen.getByRole('button', { name: /Receiver distance/ }))
    expect(screen.getByRole('button', { name: /Receiver distance/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Go to event' }))
    expect(onReplayTime).toHaveBeenCalledWith(Date.parse('2026-08-01T10:01:00.000Z'))
  })

  // jsdom reports an inline stroke back as rgb(), whatever notation it was set in.
  const asRgb = (hex: string) => {
    const [red, green, blue] = [1, 3, 5].map((offset) =>
      Number.parseInt(hex.slice(offset, offset + 2), 16),
    )
    return `rgb(${red}, ${green}, ${blue})`
  }

  it('colours the line by the same measure as the map, however the chart is scaled', () => {
    const { container, rerender } = render(
      <FlightProfile track={track} replayTime={null} onReplayTime={vi.fn()} colourMode="altitude" />,
    )
    const strokes = () =>
      [...container.querySelectorAll('path.profile-line')].map((path) =>
        (path as SVGPathElement).style.stroke,
      )
    // Both points sit in the same altitude band, so the line is one colour.
    expect(strokes()).toEqual([asRgb(trackColour('altitude', track.points[1]!))])

    rerender(
      <FlightProfile track={track} replayTime={null} onReplayTime={vi.fn()} colourMode="verticalRate" />,
    )
    expect(strokes()).toEqual([asRgb(trackColour('verticalRate', track.points[1]!))])
  })

  it('splits the line where the colour changes and leaves no gap between pieces', () => {
    const climbing = {
      ...track,
      points: [
        { ...track.points[0]!, verticalRateFpm: 0 },
        { ...track.points[1]!, verticalRateFpm: 0 },
        {
          ...track.points[1]!,
          recordedAt: '2026-08-01T10:02:00.000Z',
          altitudeFt: 3_000,
          verticalRateFpm: 3_000,
        },
      ],
    }
    const { container } = render(
      <FlightProfile track={climbing} replayTime={null} onReplayTime={vi.fn()} colourMode="verticalRate" />,
    )
    const paths = [...container.querySelectorAll('path.profile-line')] as SVGPathElement[]
    expect(paths).toHaveLength(2)
    // The second piece starts where the first ended, so the line stays joined.
    const firstEnd = paths[0]!.getAttribute('d')!.split('L').at(-1)!.trim()
    expect(paths[1]!.getAttribute('d')).toContain(`M${firstEnd}`)
  })
})
