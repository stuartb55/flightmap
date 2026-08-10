import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
  useState,
} from 'react'

/**
 * Where the Live sheet rests. `peek` shows its header and nothing else, so the
 * map keeps most of the screen; `half` adds the body; `full` gives the sheet
 * the majority and leaves the map as context above it.
 */
export type SheetStop = 'peek' | 'half' | 'full'

const order = ['peek', 'half', 'full'] as const satisfies readonly SheetStop[]

/** Far enough that a swipe cannot be mistaken for a tap on what it started on. */
const SWIPE_THRESHOLD_PX = 40
/** Where a press stops being a press and starts being a drag. */
const DRAG_START_PX = 8

export interface SheetStopControls {
  stop: SheetStop
  setStop: (stop: SheetStop) => void
  /** Advances one stop, wrapping from the top back to the peek. */
  cycle: () => void
  /**
   * Spread onto the grab handle and onto whatever else is on screen at every
   * stop, so the gesture people already expect works from more than a 4px bar.
   */
  gestureProps: {
    onPointerDown: (event: ReactPointerEvent) => void
    onPointerMove: (event: ReactPointerEvent) => void
    onPointerUp: (event: ReactPointerEvent) => void
    onPointerCancel: () => void
    onClickCapture: (event: ReactMouseEvent) => void
  }
}

/**
 * A sheet in three stops, moved either by dragging it or by tapping its grab
 * handle. Dragging is absolute — up is always the next stop up — while the tap
 * wraps, because a handle that stopped responding at the top would read as
 * broken rather than as already there.
 */
export function useSheetStops(initial: SheetStop = 'peek'): SheetStopControls {
  const [stop, setStop] = useState<SheetStop>(initial)
  const origin = useRef<{ y: number; pointerId: number; captured?: boolean } | null>(null)
  const swiped = useRef(false)

  const cycle = useCallback(() => {
    setStop((current) => order[(order.indexOf(current) + 1) % order.length]!)
  }, [])

  const move = useCallback((direction: 1 | -1) => {
    setStop((current) => {
      const next = order.indexOf(current) + direction
      return order[Math.min(order.length - 1, Math.max(0, next))]!
    })
  }, [])

  return {
    stop,
    setStop,
    cycle,
    gestureProps: {
      onPointerDown: (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        // Text entry keeps its own drag; everything else here is draggable, so
        // a swipe beginning on the star or a link still moves the sheet.
        if ((event.target as HTMLElement).closest('input, textarea, select')) return
        origin.current = { y: event.clientY, pointerId: event.pointerId }
        swiped.current = false
      },
      onPointerMove: (event) => {
        const start = origin.current
        if (!start || start.pointerId !== event.pointerId || start.captured) return
        if (Math.abs(event.clientY - start.y) < DRAG_START_PX) return
        // An upward swipe ends over the map, so the gesture has to be followed
        // off the element it started on to be seen through to its end. Capture
        // waits for the drag to declare itself, because it also redirects the
        // click — a press that never moves has to reach the button under it.
        start.captured = true
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerUp: (event) => {
        const start = origin.current
        origin.current = null
        if (!start || start.pointerId !== event.pointerId) return
        const delta = event.clientY - start.y
        if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return
        swiped.current = true
        move(delta < 0 ? 1 : -1)
      },
      onPointerCancel: () => {
        origin.current = null
      },
      // A swipe still ends in a click on whatever it started on; the sheet has
      // already answered the gesture, so that click is not also a tap. Anything
      // stale is cleared by the next press, which always precedes its own click.
      onClickCapture: (event) => {
        if (!swiped.current) return
        swiped.current = false
        event.stopPropagation()
        event.preventDefault()
      },
    },
  }
}

/** What the handle's accessible name should say the next tap will do. */
export function nextStopLabel(stop: SheetStop): string {
  if (stop === 'peek') return 'Show more of the list'
  if (stop === 'half') return 'Show the full list'
  return 'Collapse the sheet'
}
