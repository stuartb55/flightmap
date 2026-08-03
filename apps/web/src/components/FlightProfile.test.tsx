import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlightProfile } from './FlightProfile'
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
})
