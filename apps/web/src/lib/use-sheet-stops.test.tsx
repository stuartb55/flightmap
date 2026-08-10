import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { nextStopLabel, useSheetStops, type SheetStop } from './use-sheet-stops'

/**
 * jsdom fires pointer events but has no pointer capture, so the handler the
 * hook installs would throw on the first drag without this.
 */
function stubPointerCapture() {
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
}

function Sheet({ onTap, initial }: { onTap?: () => void; initial?: SheetStop }) {
  const sheet = useSheetStops(initial)
  return (
    <div data-testid="sheet" data-stop={sheet.stop} {...sheet.gestureProps}>
      <button type="button" onClick={sheet.cycle}>{nextStopLabel(sheet.stop)}</button>
      <button type="button" onClick={onTap}>Star</button>
    </div>
  )
}

/** A drag in steps, which is what a sheet gesture has to look like to be one. */
function drag(element: HTMLElement, distance: number) {
  act(() => {
    fireEvent.pointerDown(element, { pointerId: 1, clientY: 300, button: 0 })
    for (let step = 1; step <= 4; step += 1) {
      fireEvent.pointerMove(element, { pointerId: 1, clientY: 300 + (distance * step) / 4 })
    }
    fireEvent.pointerUp(element, { pointerId: 1, clientY: 300 + distance })
  })
}

const stop = () => screen.getByTestId('sheet').dataset.stop

describe('useSheetStops', () => {
  it('walks the stops on a tap and wraps at the top', async () => {
    render(<Sheet />)
    expect(stop()).toBe('peek')

    for (const expected of ['half', 'full', 'peek']) {
      await userEvent.click(screen.getByRole('button', { name: nextStopLabel(stop() as SheetStop) }))
      expect(stop()).toBe(expected)
    }
  })

  /* A drag is absolute where the tap wraps: up is always the next stop up, and
     the sheet stays put rather than jumping to the bottom at the top. */
  it('moves one stop per drag and clamps at either end', () => {
    stubPointerCapture()
    render(<Sheet />)
    const sheet = screen.getByTestId('sheet')

    drag(sheet, -80)
    expect(stop()).toBe('half')
    drag(sheet, -80)
    expect(stop()).toBe('full')
    drag(sheet, -80)
    expect(stop()).toBe('full')

    drag(sheet, 80)
    expect(stop()).toBe('half')
    drag(sheet, 80)
    expect(stop()).toBe('peek')
    drag(sheet, 80)
    expect(stop()).toBe('peek')
  })

  it('leaves the sheet where it is when the gesture is too short to be one', () => {
    stubPointerCapture()
    render(<Sheet />)

    drag(screen.getByTestId('sheet'), -20)
    expect(stop()).toBe('peek')
  })

  /*
   * A swipe still ends in a click on whatever it started on. The sheet has
   * already answered the gesture, so that click must not also reach the button
   * under the finger — otherwise dragging from the watchlist star would toggle
   * the watchlist.
   */
  it('swallows the click a completed drag ends in', () => {
    stubPointerCapture()
    const onTap = vi.fn()
    render(<Sheet onTap={onTap} />)
    const star = screen.getByRole('button', { name: 'Star' })

    drag(star, -80)
    act(() => { fireEvent.click(star) })
    expect(onTap).not.toHaveBeenCalled()
    expect(stop()).toBe('half')
  })

  it('lets a press that never moved through to the button under it', () => {
    stubPointerCapture()
    const onTap = vi.fn()
    render(<Sheet onTap={onTap} />)
    const star = screen.getByRole('button', { name: 'Star' })

    drag(star, -20)
    act(() => { fireEvent.click(star) })
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('names what the next tap will do rather than where the sheet is', () => {
    expect(nextStopLabel('peek')).toBe('Show more of the list')
    expect(nextStopLabel('half')).toBe('Show the full list')
    expect(nextStopLabel('full')).toBe('Collapse the sheet')
  })
})
