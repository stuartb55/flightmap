import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useOnline } from './use-online'

afterEach(cleanup)

function Harness() {
  return <output>{useOnline() ? 'online' : 'offline'}</output>
}

function setOnLine(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value })
  act(() => {
    window.dispatchEvent(new Event(value ? 'online' : 'offline'))
  })
}

describe('useOnline', () => {
  /*
   * `navigator.onLine` read during render reports whatever was true at the last
   * render, so a notice built on it appeared and cleared on unrelated state
   * changes rather than on connectivity.
   */
  it('follows connectivity in both directions', () => {
    setOnLine(true)
    render(<Harness />)
    expect(screen.getByRole('status')).toHaveTextContent('online')

    setOnLine(false)
    expect(screen.getByRole('status')).toHaveTextContent('offline')

    setOnLine(true)
    expect(screen.getByRole('status')).toHaveTextContent('online')
  })
})
