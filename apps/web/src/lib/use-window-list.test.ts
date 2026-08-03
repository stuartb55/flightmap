import { describe, expect, it } from 'vitest'
import { windowRange } from './use-window-list'

const base = { count: 1_000, rowHeight: 70, scrollTop: 0, viewportHeight: 700 }

describe('windowRange', () => {
  it('renders a bounded slice of a long list', () => {
    const range = windowRange(base)
    expect(range.start).toBe(0)
    expect(range.end - range.start).toBeLessThanOrEqual(24)
    expect(range.paddingTop).toBe(0)
    expect(range.paddingBottom).toBe((base.count - range.end) * base.rowHeight)
  })

  it('keeps the scrollable height constant as the window moves', () => {
    const total = base.count * base.rowHeight
    for (const scrollTop of [0, 3_500, 20_000, total - base.viewportHeight]) {
      const range = windowRange({ ...base, scrollTop })
      const rendered = (range.end - range.start) * base.rowHeight
      expect(range.paddingTop + rendered + range.paddingBottom).toBe(total)
    }
  })

  it('follows the scroll position with overscan either side', () => {
    const range = windowRange({ ...base, scrollTop: 7_000, overscan: 6 })
    // Row 100 is at the top of the viewport, row 109 at the bottom.
    expect(range.start).toBe(94)
    expect(range.end).toBe(116)
  })

  it('stops at the end of the list', () => {
    const range = windowRange({ ...base, scrollTop: 69_300 })
    expect(range.end).toBe(1_000)
    expect(range.paddingBottom).toBe(0)
  })

  it('discounts a sticky header sitting above the rows', () => {
    // The header scrolls with the content even though it sticks to the top, so
    // its height offsets every row.
    const withHeader = windowRange({ ...base, scrollTop: 7_044, headerHeight: 44 })
    expect(withHeader.start).toBe(windowRange({ ...base, scrollTop: 7_000 }).start)
    expect(windowRange({ ...base, scrollTop: 20, headerHeight: 44 }).start).toBe(0)
  })

  it('renders everything when the row height is unknown', () => {
    // No measurement is possible without layout, and a partial list would be a
    // worse answer than the whole one.
    expect(windowRange({ ...base, rowHeight: 0 })).toEqual({
      start: 0,
      end: 1_000,
      paddingTop: 0,
      paddingBottom: 0,
    })
  })

  it('renders only the overscan while the container has no height', () => {
    const range = windowRange({ ...base, viewportHeight: 0, overscan: 6 })
    expect(range).toEqual({ start: 0, end: 12, paddingTop: 0, paddingBottom: 988 * 70 })
  })

  it('renders nothing for an empty list', () => {
    expect(windowRange({ ...base, count: 0 })).toEqual({
      start: 0,
      end: 0,
      paddingTop: 0,
      paddingBottom: 0,
    })
  })

  it('always renders at least one row of a non-empty list', () => {
    const range = windowRange({ count: 3, rowHeight: 70, scrollTop: 0, viewportHeight: 1 })
    expect(range.end).toBeGreaterThan(range.start)
  })
})
