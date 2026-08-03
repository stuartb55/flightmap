import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Windowing for a single fixed-height list. The live table renders every
 * filtered aircraft, so a busy receiver builds a thousand-row tree that the
 * browser then re-lays-out on each filter change. Only the rows near the
 * viewport are worth rendering; the rest are represented by spacers.
 *
 * Hand-rolled rather than a dependency: one list, one row height, no grouping.
 */

export interface WindowRange {
  /** First index to render, inclusive. */
  start: number
  /** Last index to render, exclusive. */
  end: number
  /** Height standing in for the rows before `start`. */
  paddingTop: number
  /** Height standing in for the rows after `end`. */
  paddingBottom: number
}

export interface WindowRangeInput {
  count: number
  rowHeight: number
  scrollTop: number
  viewportHeight: number
  /**
   * Height of a sticky header. It both precedes the rows inside the scroll
   * content and covers the top of the viewport, so it shifts every row offset.
   */
  headerHeight?: number
  overscan?: number
}

/** Rows kept either side of the viewport so a fast scroll does not show gaps. */
const defaultOverscan = 6

export function windowRange({
  count,
  rowHeight,
  scrollTop,
  viewportHeight,
  headerHeight = 0,
  overscan = defaultOverscan,
}: WindowRangeInput): WindowRange {
  if (count <= 0) return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 }
  // Rows of unknown height cannot be windowed at all: render the list whole, as
  // it was before windowing, rather than showing an arbitrary slice.
  if (!(rowHeight > 0)) return { start: 0, end: count, paddingTop: 0, paddingBottom: 0 }
  // A container with no height is either not laid out yet or not on screen —
  // the collapsed mobile sheet spends most of its life here. Nothing is visible
  // either way, so render the overscan and wait to be measured.
  if (!(viewportHeight > 0)) {
    const end = Math.min(count, overscan * 2)
    return { start: 0, end, paddingTop: 0, paddingBottom: (count - end) * rowHeight }
  }
  const scrolledRows = Math.max(0, scrollTop - headerHeight)
  const start = Math.min(count - 1, Math.max(0, Math.floor(scrolledRows / rowHeight) - overscan))
  const end = Math.min(
    count,
    Math.max(start + 1, Math.ceil((scrolledRows + viewportHeight) / rowHeight) + overscan),
  )
  return {
    start,
    end,
    paddingTop: start * rowHeight,
    paddingBottom: (count - end) * rowHeight,
  }
}

/**
 * Tracks the scroll position of a container and reports which slice of a
 * `count`-long list of `rowHeight`-tall rows is worth rendering.
 */
export function useWindowList<Element extends HTMLElement>({
  count,
  rowHeight,
  headerHeight = 0,
  overscan,
}: {
  count: number
  rowHeight: number
  headerHeight?: number
  overscan?: number
}) {
  const ref = useRef<Element>(null)
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewportHeight: 0 })

  useEffect(() => {
    const container = ref.current
    if (!container) return
    let frame = 0
    const measure = () => {
      frame = 0
      setMetrics((current) =>
        current.scrollTop === container.scrollTop && current.viewportHeight === container.clientHeight
          ? current
          : { scrollTop: container.scrollTop, viewportHeight: container.clientHeight },
      )
    }
    // Scrolling fires far faster than the screen repaints, so coalesce into one
    // measurement per frame instead of one state update per event.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    container.addEventListener('scroll', schedule, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(container)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      container.removeEventListener('scroll', schedule)
      observer?.disconnect()
    }
  }, [])

  /**
   * Brings a row into view by index. Rows outside the window have no element to
   * scroll to, so the position is computed rather than delegated to
   * `scrollIntoView`. Only the nearest edge moves, so a row already in view
   * stays where it is.
   */
  const scrollToIndex = useCallback(
    (index: number, behavior: ScrollBehavior = 'auto') => {
      const container = ref.current
      if (!container || !(rowHeight > 0) || index < 0) return
      const top = headerHeight + index * rowHeight
      const bottom = top + rowHeight
      let next: number | null = null
      // The top of the viewport is behind the sticky header, so a row aligned
      // with it would be covered rather than shown.
      if (top < container.scrollTop + headerHeight) next = top - headerHeight
      else if (bottom > container.scrollTop + container.clientHeight) {
        next = bottom - container.clientHeight
      }
      if (next == null) return
      container.scrollTo?.({ top: Math.max(0, next), behavior })
    },
    [headerHeight, rowHeight],
  )

  return {
    ref,
    range: windowRange({ count, rowHeight, headerHeight, overscan, ...metrics }),
    scrollToIndex,
  }
}
