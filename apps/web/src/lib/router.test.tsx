import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Router, useSearchParams } from './router'

afterEach(cleanup)

function Harness() {
  const [params, setParams] = useSearchParams()
  return (
    <>
      <output>{params.toString()}</output>
      <button type="button" onClick={() => setParams({ aircraft: '406b90' }, true)}>
        select
      </button>
      <button type="button" onClick={() => setParams({ aircraft: null }, true)}>
        clear
      </button>
      <button type="button" onClick={() => setParams({ aircraft: 'abc123' })}>
        select pushing
      </button>
      <button type="button" onClick={() => setParams(new URLSearchParams('only=this'))}>
        replace all
      </button>
    </>
  )
}

describe('useSearchParams', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/live?view=53.4,-2.3,8&q=EZY')
  })

  it('patches the query string rather than replacing it', () => {
    render(
      <Router>
        <Harness />
      </Router>,
    )

    fireEvent.click(screen.getByText('select'))

    // The shared link's viewport and the sender's filter both survive.
    const params = new URLSearchParams(window.location.search)
    expect(params.get('view')).toBe('53.4,-2.3,8')
    expect(params.get('q')).toBe('EZY')
    expect(params.get('aircraft')).toBe('406b90')
  })

  it('deletes a key given as null and leaves the rest alone', () => {
    render(
      <Router>
        <Harness />
      </Router>,
    )

    fireEvent.click(screen.getByText('select'))
    fireEvent.click(screen.getByText('clear'))

    const params = new URLSearchParams(window.location.search)
    expect(params.has('aircraft')).toBe(false)
    expect(params.get('view')).toBe('53.4,-2.3,8')
  })

  it('replaces the entry rather than pushing when asked', () => {
    render(
      <Router>
        <Harness />
      </Router>,
    )
    const before = window.history.length

    fireEvent.click(screen.getByText('select'))
    fireEvent.click(screen.getByText('clear'))

    // Selection is not navigation: Back should leave the page, not walk the
    // selection backwards.
    expect(window.history.length).toBe(before)
  })

  it('still pushes, and still replaces wholesale, when told to', () => {
    render(
      <Router>
        <Harness />
      </Router>,
    )

    fireEvent.click(screen.getByText('select pushing'))
    expect(new URLSearchParams(window.location.search).get('aircraft')).toBe('abc123')

    fireEvent.click(screen.getByText('replace all'))
    expect(window.location.search).toBe('?only=this')
  })
})
