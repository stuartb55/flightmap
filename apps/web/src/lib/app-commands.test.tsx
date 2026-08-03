import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPendingAppCommand, publishAppCommand, useAppCommands } from './app-commands'

function Listener({ handler }: { handler: (command: { type: string }) => boolean }) {
  useAppCommands(handler as Parameters<typeof useAppCommands>[0])
  return null
}

afterEach(() => {
  clearPendingAppCommand()
})

describe('app commands', () => {
  it('delivers to a mounted handler that claims the command', () => {
    const handler = vi.fn(() => true)
    render(<Listener handler={handler} />)

    publishAppCommand({ type: 'fit-aircraft' })
    expect(handler).toHaveBeenCalledWith({ type: 'fit-aircraft' })
  })

  it('holds an unclaimed command for the page that is still mounting', () => {
    const declining = vi.fn(() => false)
    const { rerender } = render(<Listener handler={declining} />)

    publishAppCommand({ type: 'centre-receiver' })
    expect(declining).toHaveBeenCalledTimes(1)

    const accepting = vi.fn(() => true)
    rerender(<Listener handler={declining} />)
    render(<Listener handler={accepting} />)
    expect(accepting).toHaveBeenCalledWith({ type: 'centre-receiver' })
  })

  it('delivers a held command only once', () => {
    publishAppCommand({ type: 'toggle-coverage' })

    const first = vi.fn(() => true)
    const second = vi.fn(() => true)
    render(<Listener handler={first} />)
    render(<Listener handler={second} />)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('forgets a command nothing ever claimed', () => {
    publishAppCommand({ type: 'fit-aircraft' })
    clearPendingAppCommand()

    const handler = vi.fn(() => true)
    render(<Listener handler={handler} />)
    expect(handler).not.toHaveBeenCalled()
  })
})
