import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { aircraft } from '../test/fixtures'
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

describe('AircraftTable', () => {
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

  it('marks the sorted column for assistive technology', () => {
    renderTable({ sort: { key: 'altitude', direction: 'desc' } })
    expect(screen.getByRole('columnheader', { name: /altitude/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
  })
})
