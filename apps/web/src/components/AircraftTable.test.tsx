import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aircraft } from '../test/fixtures'
import { aviationUnits, metricUnits, setUnitPreferences } from '../lib/unit-preferences'
import { AircraftTable } from './AircraftTable'

function renderTable(props: Partial<Parameters<typeof AircraftTable>[0]> = {}) {
  return render(
    <AircraftTable
      aircraft={[aircraft()]}
      selectedIcao={null}
      sort={{ key: 'distance', direction: 'asc' }}
      onSort={vi.fn()}
      onSelect={vi.fn()}
      {...props}
    />,
  )
}

/**
 * jsdom has no layout, so the table cannot measure itself. Stand in for the
 * stylesheet's fixed row height and a panel tall enough to show five of them.
 */
function withLayout({ rowHeight = 70, viewportHeight = 350 } = {}) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.hasAttribute('data-aircraft-row') ? rowHeight : 0
    return { ...new DOMRect(0, 0, 320, height), height, toJSON: () => ({}) } as DOMRect
  })
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: Element,
  ) {
    return this.classList.contains('aircraft-table-wrap') ? viewportHeight : 0
  })
}

function fleet(size: number) {
  return Array.from({ length: size }, (_, index) =>
    aircraft({ icao: (0x400000 + index).toString(16), callsign: `FLT${index}` }),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  setUnitPreferences(aviationUnits)
})

describe('AircraftTable', () => {
  it('repaints memoised rows when the unit preference changes', () => {
    renderTable({ aircraft: [aircraft({ verticalRate: 1_800 })] })
    expect(screen.getByText('18,000 ft')).toBeInTheDocument()

    act(() => setUnitPreferences(metricUnits))

    expect(screen.getByText('5,490 m')).toBeInTheDocument()
    expect(screen.queryByText('18,000 ft')).not.toBeInTheDocument()
    expect(screen.getByTitle('↑ 9.1 m/s')).toHaveTextContent('Climbing')
  })

  it('announces and synchronises row selection', async () => {
    const onSelect = vi.fn()
    renderTable({ onSelect })

    await userEvent.click(screen.getByRole('button', { name: /select EZY42KD/i }))
    expect(onSelect).toHaveBeenCalledWith('406b90')
    expect(screen.getByText('18,000 ft')).toBeInTheDocument()
  })

  it('shows climb state beside the altitude without needing a column for it', () => {
    renderTable({ aircraft: [aircraft({ verticalRate: 1_800 })] })
    // The tooltip carries the rate; the spoken text carries the direction.
    expect(screen.getByTitle('↑ 1,800 ft/min')).toHaveTextContent('Climbing')
  })

  it('describes a descent and a level flight distinctly', () => {
    const { unmount } = renderTable({ aircraft: [aircraft({ verticalRate: -900 })] })
    expect(screen.getByTitle('↓ 900 ft/min')).toHaveTextContent('Descending')
    unmount()

    renderTable({ aircraft: [aircraft({ verticalRate: 0 })] })
    expect(screen.getByTitle('→ 0 ft/min')).toHaveTextContent('Level')
  })

  it('omits the trend when the receiver reports no vertical rate', () => {
    renderTable({ aircraft: [aircraft({ verticalRate: null })] })
    expect(screen.queryByText(/Climbing|Descending|Level/)).not.toBeInTheDocument()
  })

  it('renders only the requested columns', () => {
    renderTable({ columns: ['identity', 'squawk'] })
    expect(screen.getByRole('columnheader', { name: /squawk/i })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /range/i })).not.toBeInTheDocument()
  })

  it('sorts by the column that was clicked, not by its position', async () => {
    const onSort = vi.fn()
    renderTable({ columns: ['identity', 'squawk'], onSort })

    await userEvent.click(screen.getByRole('button', { name: /squawk/i }))
    expect(onSort).toHaveBeenCalledWith({ key: 'squawk', direction: 'asc' })
  })

  it('renders only the rows near the viewport', async () => {
    withLayout()
    renderTable({ aircraft: fleet(300) })

    // Five rows fit the viewport, plus six of overscan below it.
    await waitFor(() =>
      expect(document.querySelectorAll('tr[data-aircraft-row]')).toHaveLength(11),
    )
    expect(screen.getByRole('button', { name: 'Select FLT0' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select FLT200' })).not.toBeInTheDocument()
  })

  it('reports the whole list to assistive technology while windowed', async () => {
    withLayout()
    renderTable({ aircraft: fleet(300) })

    const table = screen.getByRole('table')
    await waitFor(() =>
      expect(document.querySelectorAll('tr[data-aircraft-row]').length).toBeLessThan(300),
    )
    // The header is row one, so the 300 aircraft take rows two to 301.
    expect(table).toHaveAttribute('aria-rowcount', '301')
    const rows = [...document.querySelectorAll('tr[data-aircraft-row]')]
    expect(rows.at(0)).toHaveAttribute('aria-rowindex', '2')
    expect(rows.at(-1)?.getAttribute('aria-rowindex')).toBe(String(rows.length + 1))
  })

  it('keeps the scroll height of the rows it leaves out', async () => {
    withLayout()
    renderTable({ aircraft: fleet(300) })

    await waitFor(() => expect(document.querySelector('.row-spacer')).toBeInTheDocument())
    const rendered = document.querySelectorAll('tr[data-aircraft-row]').length
    const spacer = document.querySelector<HTMLTableCellElement>('.row-spacer td')!
    expect(spacer.style.height).toBe(`${(300 - rendered) * 70}px`)
    expect(spacer.closest('tr')).toHaveAttribute('aria-hidden', 'true')
  })

  it('marks the sorted column for assistive technology', () => {
    renderTable({ sort: { key: 'altitude', direction: 'desc' } })
    expect(screen.getByRole('columnheader', { name: /altitude/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
  })
})
