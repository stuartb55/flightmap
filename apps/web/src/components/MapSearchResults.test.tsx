import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { aircraft } from '../test/fixtures'
import { MapSearchResults } from './MapSearchResults'

function renderResults(props: Partial<Parameters<typeof MapSearchResults>[0]> = {}) {
  const onSelect = vi.fn()
  render(
    <MapSearchResults
      matches={[aircraft({ icao: '400001', callsign: 'RUK2HK' })]}
      query="RUK2HK"
      activeIndex={0}
      onSelect={onSelect}
      {...props}
    />,
  )
  return { onSelect }
}

describe('MapSearchResults', () => {
  it('offers each match as an option, with the active one selected', () => {
    renderResults({
      matches: [
        aircraft({ icao: '400001', callsign: 'RUK2HK' }),
        aircraft({ icao: '400002', callsign: 'RUK21' }),
      ],
      activeIndex: 1,
    })

    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('RUK2HK'),
      expect.stringContaining('RUK21'),
    ])
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
  })

  /*
   * The field is focused while the results are open, so a tap that waited for
   * click would first blur it and take the list away under the finger.
   */
  it('selects on pointer down rather than on click', async () => {
    const { onSelect } = renderResults()

    await userEvent.pointer({ target: screen.getByRole('option'), keys: '[MouseLeft>]' })

    expect(onSelect).toHaveBeenCalledWith('400001')
  })

  // Saying nothing matched is the whole difference from the field that looked
  // broken: an empty query used to produce no visible change at all.
  it('says so when nothing matches', () => {
    renderResults({ matches: [], query: ' ZZZZZZ ' })

    expect(screen.getByRole('status')).toHaveTextContent('No aircraft match ZZZZZZ.')
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('marks an aircraft heard without a position as one the map cannot go to', () => {
    renderResults({
      matches: [aircraft({ icao: '400003', callsign: 'RUK9', latitude: null, longitude: null })],
    })

    expect(screen.getByRole('option')).toHaveTextContent('No position')
  })
})
