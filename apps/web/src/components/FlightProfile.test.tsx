import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlightProfile, comparedSeries, maximumComparedTracks } from './FlightProfile'
import { formatTime } from '../lib/format'
import { trackColour, trackIdentity } from '../lib/track-colour'
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

/*
 * Comparison fixtures: same shape, later in the day and each a minute shorter
 * than the last, so absolute time spreads them across the axis and aligning on
 * start stacks them on top of each other.
 */
function laterTrack(index: number): TrackResponse {
  const start = Date.parse('2026-08-01T11:00:00.000Z') + index * 3_600_000
  const end = start + 60_000
  const iso = (time: number) => new Date(time).toISOString()
  return {
    ...track,
    session: {
      ...track.session,
      id: `${index + 2}`.repeat(8) + '-0000-4000-8000-000000000000',
      icao: `def${index}00`,
      callsigns: [`CMP${index}`],
      startedAt: iso(start),
      endedAt: iso(end),
    },
    points: [
      { ...track.points[0]!, recordedAt: iso(start) },
      { ...track.points[1]!, recordedAt: iso(end) },
    ],
    events: [],
  }
}

const comparison = [track, laterTrack(0), laterTrack(1), laterTrack(2), laterTrack(3)]

afterEach(cleanup)

describe('FlightProfile', () => {
  it('switches telemetry metrics and exposes event navigation', () => {
    const onReplayTime = vi.fn()
    render(
      <FlightProfile
        tracks={[track]}
        focusedTrackId={track.session.id}
        replayTime={Date.parse(track.points[0]!.recordedAt)}
        onReplayTime={onReplayTime}
      />,
    )
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
      <FlightProfile
        tracks={[track]}
        focusedTrackId={track.session.id}
        replayTime={null}
        onReplayTime={vi.fn()}
        colourMode="altitude"
      />,
    )
    const strokes = () =>
      [...container.querySelectorAll('path.profile-line')].map((path) =>
        (path as SVGPathElement).style.stroke,
      )
    // Both points sit in the same altitude band, so the line is one colour.
    expect(strokes()).toEqual([asRgb(trackColour('altitude', track.points[1]!))])

    rerender(
      <FlightProfile
        tracks={[track]}
        focusedTrackId={track.session.id}
        replayTime={null}
        onReplayTime={vi.fn()}
        colourMode="verticalRate"
      />,
    )
    expect(strokes()).toEqual([asRgb(trackColour('verticalRate', track.points[1]!))])
    // One track is not a comparison: no identity colours, no dashes, no legend.
    expect(container.querySelector('path.profile-line.comparison')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Profile time axis' })).toBeNull()
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
      <FlightProfile
        tracks={[climbing]}
        focusedTrackId={climbing.session.id}
        replayTime={null}
        onReplayTime={vi.fn()}
        colourMode="verticalRate"
      />,
    )
    const paths = [...container.querySelectorAll('path.profile-line')] as SVGPathElement[]
    expect(paths).toHaveLength(2)
    // The second piece starts where the first ended, so the line stays joined.
    const firstEnd = paths[0]!.getAttribute('d')!.split('L').at(-1)!.trim()
    expect(paths[1]!.getAttribute('d')).toContain(`M${firstEnd}`)
  })
})

describe('FlightProfile comparison', () => {
  const renderComparison = (
    props: Partial<Parameters<typeof FlightProfile>[0]> = {},
  ) =>
    render(
      <FlightProfile
        tracks={comparison}
        focusedTrackId={comparison[0]!.session.id}
        onFocusTrack={vi.fn()}
        replayTime={null}
        onReplayTime={vi.fn()}
        {...props}
      />,
    )

  it('caps the overlay and keeps the focused track on the chart wherever it sits', () => {
    expect(comparedSeries(comparison, comparison[0]!.session.id).map((entry) => entry.slot))
      .toEqual([0, 1, 2, 3])
    // The last track is beyond the cap, so it takes the last slot rather than
    // leaving the readout reporting a series nobody can see.
    const withLateFocus = comparedSeries(comparison, comparison[4]!.session.id)
    expect(withLateFocus).toHaveLength(maximumComparedTracks)
    expect(withLateFocus.at(-1)).toEqual({ track: comparison[4], slot: 4 })
  })

  it('gives each series its own colour and dash, and says which is which', () => {
    const { container } = renderComparison()
    const paths = [...container.querySelectorAll('path.profile-line.comparison')] as SVGPathElement[]
    expect(paths).toHaveLength(maximumComparedTracks)
    // Colour alone never carries it: every series also has its own dash.
    expect(new Set(paths.map((path) => path.style.stroke)).size).toBe(maximumComparedTracks)
    expect(new Set(paths.map((path) => path.style.strokeDasharray)).size).toBe(maximumComparedTracks)

    // The focused series draws last, so it sits over the rest.
    expect(paths.at(-1)!.classList.contains('focused')).toBe(true)
    expect(paths.at(-1)!.style.stroke).toBe(asRgbColour(trackIdentity(0).colour))

    // …and the legend names each series with its pattern.
    for (let slot = 0; slot < maximumComparedTracks; slot += 1) {
      const label = comparison[slot]!.session.callsigns[0]!
      expect(
        screen.getByRole('button', { name: new RegExp(`${label}, ${trackIdentity(slot).pattern} line`) }),
      ).toBeTruthy()
    }
  })

  it('says how many of the selection it is showing and focuses the rest on request', () => {
    const onFocusTrack = vi.fn()
    renderComparison({ onFocusTrack })
    expect(screen.getByText(/Comparing 4 of 5 selected tracks/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /CMP1, .* line\. Focus this series/ }))
    expect(onFocusTrack).toHaveBeenCalledWith(comparison[2]!.session.id)
  })

  it('stacks the series on their own start when the axis is aligned', () => {
    const { container, rerender } = renderComparison()
    const startX = () =>
      ([...container.querySelectorAll('path.profile-line.comparison')] as SVGPathElement[]).map(
        (path) => Number.parseFloat(path.getAttribute('d')!.slice(1).split(',')[0]!),
      )
    const axisLabels = () =>
      [...container.querySelectorAll('svg.profile-chart text')].map((node) => node.textContent)

    // Absolute time spreads four tracks across three hours of shared axis, and
    // labels that axis with the clock the replay slider is also on.
    expect(new Set(startX()).size).toBe(maximumComparedTracks)
    expect(axisLabels()).toEqual([
      formatTime(comparison[0]!.session.startedAt),
      formatTime(comparison[3]!.session.endedAt!),
    ])

    rerender(
      <FlightProfile
        tracks={comparison}
        focusedTrackId={comparison[0]!.session.id}
        onFocusTrack={vi.fn()}
        axisMode="aligned"
        replayTime={null}
        onReplayTime={vi.fn()}
      />,
    )
    expect(startX()).toEqual([0, 0, 0, 0])
    // The axis now reads as time since each series began, not a clock.
    expect(axisLabels()).toEqual(['+0:00', '+1:00'])
  })

  it('gives every series a data table, and labels it by what the axis shows', () => {
    const { rerender } = renderComparison()
    for (let slot = 0; slot < maximumComparedTracks; slot += 1) {
      const label = comparison[slot]!.session.callsigns[0]!
      const table = screen.getByRole('region', { name: new RegExp(`values for ${label}`) })
      expect(within(table).getByRole('columnheader', { name: 'Time' })).toBeTruthy()
    }

    rerender(
      <FlightProfile
        tracks={comparison}
        focusedTrackId={comparison[0]!.session.id}
        axisMode="aligned"
        replayTime={null}
        onReplayTime={vi.fn()}
      />,
    )
    const table = screen.getByRole('region', { name: /values for TEST1/ })
    expect(within(table).getByRole('columnheader', { name: 'Elapsed' })).toBeTruthy()
    expect(within(table).getByRole('rowheader', { name: '+1:00' })).toBeTruthy()
  })

  it('reports the focused series and scrubs replay in absolute time on either axis', () => {
    const onReplayTime = vi.fn()
    const focused = comparison[1]!
    const { container, rerender } = render(
      <FlightProfile
        tracks={comparison}
        focusedTrackId={focused.session.id}
        axisMode="aligned"
        replayTime={Date.parse(focused.session.endedAt!)}
        onReplayTime={onReplayTime}
      />,
    )
    // The crosshair sits at the focused series' end, not the axis window's.
    const chart = container.querySelector('svg.profile-chart')!
    const crosshair = chart.querySelector('line.profile-crosshair')!
    expect(Number(crosshair.getAttribute('x1'))).toBeCloseTo(900, 5)
    // jsdom lays nothing out and has no pointer capture, both of which the
    // scrub handler takes for granted.
    Object.assign(chart, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      getBoundingClientRect: () => ({ left: 0, width: 900 }) as DOMRect,
    })

    // Aligned, the axis origin is the focused series' own start — but replay
    // is still driven in absolute time, so every selected track moves with it.
    fireEvent.pointerDown(chart, { pointerId: 1, clientX: 0 })
    expect(onReplayTime).toHaveBeenCalledWith(Date.parse(focused.session.startedAt))

    rerender(
      <FlightProfile
        tracks={comparison}
        focusedTrackId={focused.session.id}
        replayTime={Date.parse(focused.session.endedAt!)}
        onReplayTime={onReplayTime}
      />,
    )
    // Absolute, the origin is the earliest of the compared series instead.
    fireEvent.pointerDown(chart, { pointerId: 1, clientX: 0 })
    expect(onReplayTime).toHaveBeenLastCalledWith(Date.parse(comparison[0]!.session.startedAt))
  })

  it('ignores a scrub on a chart that has not been laid out', () => {
    const onReplayTime = vi.fn()
    const { container } = renderComparison({ onReplayTime })
    const chart = container.querySelector('svg.profile-chart')!
    Object.assign(chart, { setPointerCapture: vi.fn(), hasPointerCapture: () => false })
    fireEvent.pointerDown(chart, { pointerId: 1, clientX: 0 })
    expect(onReplayTime).not.toHaveBeenCalled()
  })
})

function asRgbColour(hex: string) {
  const [red, green, blue] = [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  )
  return `rgb(${red}, ${green}, ${blue})`
}
