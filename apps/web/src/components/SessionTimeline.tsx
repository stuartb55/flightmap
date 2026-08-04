import { useMemo, type PointerEvent } from 'react'
import { formatTime } from '../lib/format'
import { colourSpans, type TrackColourMode } from '../lib/track-colour'
import { useUnitPreferences } from '../lib/unit-preferences'
import type { TrackResponse } from '../types'

/**
 * One lane per selected session, drawn against the shared replay window, so
 * which tracks were in the air at the same time is a matter of looking rather
 * than of reading start and end times off eight separate cards.
 *
 * It sits directly above the replay slider and shares its axis — the lanes and
 * the slider handle mark the same instant — so the strip reads as part of the
 * replay control rather than as another panel over the map. Lanes carry the
 * same colours as the map and the flight profile, which makes them a
 * compressed profile of every selected track at once.
 */
export function SessionTimeline({
  tracks,
  bounds,
  replayTime,
  focusedTrackId,
  colourMode,
  onFocusTrack,
  onReplayTime,
}: {
  tracks: TrackResponse[]
  bounds: { start: number; end: number }
  replayTime: number | null
  focusedTrackId: string | null
  colourMode: TrackColourMode
  onFocusTrack: (id: string | null) => void
  onReplayTime: (time: number) => void
}) {
  useUnitPreferences()
  const window = Math.max(1, bounds.end - bounds.start)
  const percent = (time: number) => ((time - bounds.start) / window) * 100

  const lanes = useMemo(
    () =>
      tracks.map((track) => ({
        track,
        spans: colourSpans(track.points, colourMode),
      })),
    [tracks, colourMode],
  )

  const scrub = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
    onReplayTime(bounds.start + ratio * window)
  }

  return (
    <section className="session-timeline" aria-label="Session timeline">
      <div className="timeline-lanes">
        {lanes.map(({ track, spans }) => {
          const session = track.session
          const label = session.callsigns[0] || session.registration || session.icao.toUpperCase()
          const first = spans[0]
          const last = spans[spans.length - 1]
          const focused = focusedTrackId === session.id
          return (
            <div className={`timeline-lane ${focused ? 'focused' : ''}`} key={session.id}>
              <button
                type="button"
                className="timeline-label"
                aria-pressed={focused}
                aria-label={`${focused ? 'Close' : 'Open'} the ${label} profile. ${
                  first && last
                    ? `On air ${formatTime(new Date(first.start).toISOString())} to ${formatTime(
                        new Date(last.end).toISOString(),
                      )}`
                    : 'No positions in the replay window'
                }`}
                onClick={() => onFocusTrack(focused ? null : session.id)}
              >
                <strong>{label}</strong>
                <small>{session.registration || session.icao.toUpperCase()}</small>
              </button>
              {/* The lane is a scrub surface, not a control: replay has a
                  labelled slider for the keyboard, and the label beside this
                  carries everything a screen reader needs from the lane. */}
              <div
                className="timeline-bar"
                aria-hidden="true"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  scrub(event)
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event)
                }}
              >
                {spans.map((span) => (
                  <i
                    key={span.start}
                    style={{
                      left: `${percent(span.start)}%`,
                      // A span between two samples a second apart is narrower
                      // than a pixel; the floor keeps a short track visible.
                      width: `max(2px, ${percent(span.end) - percent(span.start)}%)`,
                      background: span.colour,
                    }}
                  />
                ))}
                {replayTime == null ? null : (
                  <span className="timeline-cursor" style={{ left: `${percent(replayTime)}%` }} />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

