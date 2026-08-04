import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTimeline } from './SessionTimeline'
import type { SessionSummary, TrackResponse } from '../types'

const session = (id: string, callsign: string): SessionSummary => ({
  id,
  icao: '406b90',
  callsigns: [callsign],
  registration: 'G-EZTH',
  typeCode: 'A320',
  operator: 'easyJet',
  startedAt: '2026-08-01T10:00:00.000Z',
  endedAt: '2026-08-01T10:30:00.000Z',
  sampleCount: 2,
  minimumAltitudeFt: 1_000,
  maximumAltitudeFt: 38_000,
  maximumSpeedKt: 430,
  closestDistanceNm: 4.2,
  hasDetailedTrack: true,
  alertKinds: [],
})

const track = (
  id: string,
  callsign: string,
  minutes: [number, number],
  altitudes: [number, number],
): TrackResponse => ({
  session: session(id, callsign),
  resolution: '1s',
  points: [0, 1].map((index) => ({
    recordedAt: new Date(
      Date.parse('2026-08-01T10:00:00.000Z') + minutes[index]! * 60_000,
    ).toISOString(),
    latitude: 53.4,
    longitude: -2.3,
    altitudeFt: altitudes[index]!,
    groundSpeedKt: 400,
    trackDegrees: 90,
  })),
  events: [],
  truncated: false,
})

const bounds = {
  start: Date.parse('2026-08-01T10:00:00.000Z'),
  end: Date.parse('2026-08-01T11:00:00.000Z'),
}

const first = track('11111111-1111-4111-8111-111111111111', 'EZY42KD', [0, 30], [1_000, 38_000])
const second = track('22222222-2222-4222-8222-222222222222', 'RYR18X', [20, 60], [5_000, 5_000])

afterEach(cleanup)

function renderTimeline(overrides: Partial<Parameters<typeof SessionTimeline>[0]> = {}) {
  const props = {
    tracks: [first, second],
    bounds,
    replayTime: null,
    focusedTrackId: null,
    colourMode: 'altitude' as const,
    onFocusTrack: vi.fn(),
    onReplayTime: vi.fn(),
    ...overrides,
  }
  return { ...render(<SessionTimeline {...props} />), props }
}

describe('SessionTimeline', () => {
  it('places each lane where its track sits in the replay window', () => {
    const { container } = renderTimeline()
    const lanes = [...container.querySelectorAll('.timeline-bar')]
    expect(lanes).toHaveLength(2)

    // The first track runs from the start of the window to halfway; the second
    // starts a third of the way in — the overlap is visible in the geometry.
    const spans = (lane: Element) =>
      [...lane.querySelectorAll('i')].map((span) => (span as HTMLElement).style.left)
    expect(spans(lanes[0]!)[0]).toBe('0%')
    expect(spans(lanes[1]!)[0]).toBe(`${(20 / 60) * 100}%`)
  })

  it('colours a lane by the same measure as the map', () => {
    const { container, rerender } = renderTimeline()
    const colours = () =>
      [...container.querySelectorAll('.timeline-bar i')].map(
        (span) => (span as HTMLElement).style.background,
      )
    // The climbing track crosses altitude bands; the level one does not.
    const byAltitude = colours()
    expect(new Set(byAltitude).size).toBeGreaterThan(1)

    rerender(
      <SessionTimeline
        tracks={[first, second]}
        bounds={bounds}
        replayTime={null}
        focusedTrackId={null}
        colourMode="speed"
        onFocusTrack={vi.fn()}
        onReplayTime={vi.fn()}
      />,
    )
    // Every point reports the same speed, so the strip is a single colour.
    expect(new Set(colours()).size).toBe(1)
  })

  it('shows the replay cursor only once there is a position to show', () => {
    const { container, unmount } = renderTimeline()
    expect(container.querySelector('.timeline-cursor')).toBeNull()
    unmount()

    const { container: playing } = renderTimeline({
      replayTime: bounds.start + (bounds.end - bounds.start) / 4,
    })
    expect((playing.querySelector('.timeline-cursor') as HTMLElement).style.left).toBe('25%')
  })

  it('opens and closes a track profile from its lane', () => {
    const onFocusTrack = vi.fn()
    const { unmount } = renderTimeline({ onFocusTrack })
    fireEvent.click(screen.getByRole('button', { name: /Open the EZY42KD profile/ }))
    expect(onFocusTrack).toHaveBeenCalledWith(first.session.id)
    unmount()

    renderTimeline({ onFocusTrack, focusedTrackId: first.session.id })
    fireEvent.click(screen.getByRole('button', { name: /Close the EZY42KD profile/ }))
    expect(onFocusTrack).toHaveBeenLastCalledWith(null)
  })

  it('scrubs the replay to where the lane was dragged', () => {
    const onReplayTime = vi.fn()
    const { container } = renderTimeline({ onReplayTime })
    const lane = container.querySelector('.timeline-bar') as HTMLElement
    lane.setPointerCapture = vi.fn()
    lane.hasPointerCapture = vi.fn(() => true)
    lane.getBoundingClientRect = () =>
      ({ left: 0, width: 200, top: 0, height: 16, right: 200, bottom: 16, x: 0, y: 0 }) as DOMRect

    fireEvent.pointerDown(lane, { pointerId: 1, clientX: 100 })
    expect(onReplayTime).toHaveBeenLastCalledWith(bounds.start + (bounds.end - bounds.start) / 2)

    fireEvent.pointerMove(lane, { pointerId: 1, clientX: 300 })
    // Dragging past the end clamps to the end rather than running past it.
    expect(onReplayTime).toHaveBeenLastCalledWith(bounds.end)
  })
})
