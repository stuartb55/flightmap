import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { aircraft } from '../test/fixtures'
import { LiveSheetTraffic } from './LiveSheetTraffic'

function renderTraffic(props: Partial<Parameters<typeof LiveSheetTraffic>[0]> = {}) {
  const onSelect = vi.fn()
  const { container } = render(
    <LiveSheetTraffic
      aircraft={[aircraft()]}
      selectedIcao={null}
      onSelect={onSelect}
      newSince={null}
      loading={false}
      emptyTitle="No aircraft match"
      emptyDescription="Try widening the current filters."
      {...props}
    />,
  )
  return { onSelect, rows: () => container.querySelector<HTMLElement>('.sheet-rows')! }
}

function fleet(distances: number[]) {
  return distances.map((distanceNm, index) =>
    aircraft({
      icao: (0x400000 + index).toString(16),
      callsign: `FLT${index}`,
      distanceNm,
    }),
  )
}

const nearest = () => screen.getByLabelText('Nearest aircraft')

describe('LiveSheetTraffic', () => {
  it('orders the overhead strip by distance whatever order the list arrives in', () => {
    renderTraffic({ aircraft: fleet([40, 4, 22]) })

    const cards = within(nearest()).getAllByRole('button')
    expect(cards.map((card) => card.querySelector('.sheet-nearest-identity strong')!.textContent)).toEqual([
      'FLT1',
      'FLT2',
      'FLT0',
    ])
  })

  it('holds the strip to six, because it is a glance rather than a second list', () => {
    renderTraffic({ aircraft: fleet([1, 2, 3, 4, 5, 6, 7, 8]) })

    expect(within(nearest()).getAllByRole('button')).toHaveLength(6)
  })

  /* An aircraft heard without a position has no distance, so it cannot be the
     nearest anything — but it is still traffic, and still belongs in the list. */
  it('keeps unpositioned aircraft out of the strip and in the rows', () => {
    const { rows } = renderTraffic({
      aircraft: [
        aircraft({ icao: '400001', callsign: 'FLT1', distanceNm: null }),
        aircraft({ icao: '400002', callsign: 'FLT2', distanceNm: 9 }),
      ],
    })

    expect(within(nearest()).getAllByRole('button')).toHaveLength(1)
    expect(within(rows()).getByRole('button', { name: /FLT1/ })).toBeInTheDocument()
  })

  /*
   * A receiver with no position of its own reports no distances at all, and the
   * strip is the whole of the sheet's first stop — so it falls back to the head
   * of the list rather than leaving that stop empty.
   */
  it('falls back to the head of the list when nothing has a distance', () => {
    renderTraffic({
      aircraft: [
        aircraft({ icao: '400001', callsign: 'FLT1', distanceNm: null }),
        aircraft({ icao: '400002', callsign: 'FLT2', distanceNm: null }),
      ],
    })

    const cards = within(nearest()).getAllByRole('button')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.querySelector('.sheet-nearest-identity strong')!.textContent).toBe('FLT1')
  })

  it('marks a watched aircraft, and a newly heard one when the marker is on', () => {
    renderTraffic({
      newSince: Date.now() - 60_000,
      aircraft: [
        aircraft({ icao: '400001', callsign: 'FLT1', watched: true }),
        aircraft({
          icao: '400002',
          callsign: 'FLT2',
          firstSeenAt: new Date().toISOString(),
        }),
      ],
    })

    expect(screen.getByText('WATCHED')).toBeInTheDocument()
    expect(screen.getByText('NEW')).toBeInTheDocument()
  })

  /* Watched outranks new: it is the one the reader asked to be told about. */
  it('shows only the watchlist badge on an aircraft that is both', () => {
    renderTraffic({
      newSince: Date.now() - 60_000,
      aircraft: [
        aircraft({ watched: true, firstSeenAt: new Date().toISOString() }),
      ],
    })

    expect(screen.getByText('WATCHED')).toBeInTheDocument()
    expect(screen.queryByText('NEW')).not.toBeInTheDocument()
  })

  it('selects from the strip and from the rows alike', async () => {
    const { onSelect, rows } = renderTraffic({ aircraft: fleet([5]) })

    await userEvent.click(within(nearest()).getAllByRole('button')[0]!)
    expect(onSelect).toHaveBeenCalledWith('400000')

    onSelect.mockClear()
    await userEvent.click(within(rows()).getByRole('button', { name: /FLT0/ }))
    expect(onSelect).toHaveBeenCalledWith('400000')
  })

  it('says the filters are the reason when a live feed has nothing to show', () => {
    renderTraffic({ aircraft: [] })

    expect(screen.getByText('No aircraft match')).toBeInTheDocument()
    expect(screen.getByText('Try widening the current filters.')).toBeInTheDocument()
  })

  /* Before the first snapshot there is nothing to say about filters, because
     nothing has been filtered yet. */
  it('waits rather than reporting an empty result before the first snapshot', () => {
    renderTraffic({ aircraft: [], loading: true })

    expect(screen.getByText('Waiting for the first receiver snapshot…')).toBeInTheDocument()
    expect(screen.queryByText('No aircraft match')).not.toBeInTheDocument()
  })
})
