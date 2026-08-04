import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChartDataTable } from './ChartDataTable'

afterEach(cleanup)

const rows = Array.from({ length: 5 }, (_, index) => ({
  key: `row-${index}`,
  header: `Row ${index}`,
  cells: [`${index * 10}`, index === 0 ? '—' : `${index}`],
}))

describe('ChartDataTable', () => {
  it('renders a table of the values behind a keyboard-reachable disclosure', () => {
    render(
      <ChartDataTable
        summary="View activity data table"
        caption="Activity chart values"
        columns={['Period', 'Reports', 'Sessions']}
        rows={rows}
      />,
    )
    const disclosure = screen.getByText('View activity data table')
    // A <summary> is focusable and operable by keyboard without any handler,
    // which is the whole reason the pattern is a <details>.
    expect(disclosure.tagName).toBe('SUMMARY')
    const table = screen.getByRole('table', { name: 'Activity chart values' })
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3)
    expect(within(table).getAllByRole('row')).toHaveLength(rows.length + 1)
    expect(within(table).getByRole('rowheader', { name: 'Row 0' })).toBeInTheDocument()
    // Unavailable values arrive already formatted and stay as an em dash.
    expect(within(table).getByText('—')).toBeInTheDocument()
  })

  it('states the cap when it shows only part of a series', () => {
    render(
      <ChartDataTable
        summary="View flight profile data table"
        caption="Flight profile values"
        columns={['Time', 'Altitude', 'Speed']}
        rows={rows}
        rowCap={2}
      />,
    )
    const table = screen.getByRole('table', { name: /Flight profile values/ })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(screen.getByText('Showing the first 2 of 5 rows.')).toBeInTheDocument()
    // The accessible name carries the cap too: a screen-reader user meets the
    // caption before the rows.
    expect(table).toHaveAccessibleName('Flight profile values. Showing the first 2 of 5 rows')
  })

  it('leaves an uncapped table unqualified', () => {
    render(
      <ChartDataTable
        summary="View data"
        caption="Values"
        columns={['Period', 'Reports', 'Sessions']}
        rows={rows}
        rowCap={10}
      />,
    )
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveAccessibleName('Values')
  })
})
