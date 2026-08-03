import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aircraft } from '../test/fixtures'

const apiMock = vi.hoisted(() => ({ savedViews: vi.fn() }))
const liveMock = vi.hoisted(() => ({ aircraftList: [] as ReturnType<typeof aircraft>[] }))

vi.mock('../lib/api', () => ({ api: apiMock }))
vi.mock('../state/LiveContext', () => ({
  useLiveAircraft: () => ({ aircraftList: liveMock.aircraftList, trails: {} }),
}))

import { Router } from '../lib/router'
import { clearPendingAppCommand } from '../lib/app-commands'
import { CommandPalette } from './CommandPalette'

function renderPalette() {
  return render(
    <Router>
      <button type="button">Opener</button>
      <input aria-label="Somewhere to type" />
      <CommandPalette />
    </Router>,
  )
}

async function openPalette() {
  await userEvent.keyboard('{Control>}k{/Control}')
  return screen.findByRole('combobox')
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  apiMock.savedViews.mockResolvedValue([])
  liveMock.aircraftList = [
    aircraft(),
    aircraft({ icao: 'a12345', callsign: 'EZY99XX', registration: 'G-EZAB', operator: 'easyJet' }),
    aircraft({
      icao: 'c0ffee',
      callsign: 'BAW117',
      registration: 'G-STBA',
      operator: 'British Airways',
      typeCode: 'B77W',
    }),
  ]
})

afterEach(() => {
  clearPendingAppCommand()
  vi.clearAllMocks()
})

describe('CommandPalette', () => {
  it('opens from anywhere, then closes on Escape and restores focus', async () => {
    renderPalette()
    const opener = screen.getByRole('button', { name: 'Opener' })
    opener.focus()

    await openPalette()
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })

  it('leaves the shortcut alone while somebody is typing', async () => {
    renderPalette()
    screen.getByLabelText('Somewhere to type').focus()

    await userEvent.keyboard('{Control>}k{/Control}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ranks an exact callsign above an operator match and reports the count', async () => {
    renderPalette()
    const input = await openPalette()

    await userEvent.type(input, 'ezy99xx')
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent('EZY99XX')
    expect(screen.getByRole('status')).toHaveTextContent('1 result')

    await userEvent.clear(input)
    await userEvent.type(input, 'easyjet')
    // Both easyJet aircraft match on operator; neither identity field does.
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('walks results with the keyboard and opens the selected aircraft', async () => {
    renderPalette()
    const input = await openPalette()
    await userEvent.type(input, 'baw117')

    const option = screen.getByRole('option', { name: /BAW117/ })
    expect(input).toHaveAttribute('aria-activedescendant', option.id)
    expect(option).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{Enter}')
    expect(window.location.pathname + window.location.search).toBe('/?aircraft=c0ffee')
  })

  it('opens the aircraft profile when Enter is modified', async () => {
    renderPalette()
    const input = await openPalette()
    await userEvent.type(input, 'baw117')

    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(window.location.pathname).toBe('/aircraft/c0ffee')
  })

  it('moves the active option with the arrow keys and Home', async () => {
    renderPalette()
    const input = await openPalette()
    await userEvent.type(input, 'ezy')

    const first = screen.getAllByRole('option')[0]!
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(first).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{End}')
    expect(screen.getAllByRole('option').at(-1)).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{Home}')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('explains an empty result rather than showing nothing', async () => {
    renderPalette()
    const input = await openPalette()
    await userEvent.type(input, 'zzzz-nothing')

    expect(screen.getByRole('status')).toHaveTextContent('0 results')
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument()
    expect(screen.getByText(/callsign, registration, ICAO address/)).toBeInTheDocument()
  })

  it('lists pages and map actions without a query', async () => {
    renderPalette()
    await openPalette()

    expect(screen.getByRole('option', { name: /Flight history/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Fit aircraft/ })).toBeInTheDocument()
    // Aircraft need a query: the whole live list would drown everything else.
    expect(screen.queryByRole('option', { name: /EZY42KD/ })).not.toBeInTheDocument()
  })

  it('navigates to a chosen page', async () => {
    renderPalette()
    const input = await openPalette()
    await userEvent.type(input, 'insights')

    await userEvent.keyboard('{Enter}')
    expect(window.location.pathname).toBe('/insights')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
