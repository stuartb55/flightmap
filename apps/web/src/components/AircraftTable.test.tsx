import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { aircraft } from '../test/fixtures'
import { AircraftTable } from './AircraftTable'

describe('AircraftTable', () => {
  it('announces and synchronises row selection', async () => {
    const onSelect = vi.fn()
    render(
      <AircraftTable
        aircraft={[aircraft()]}
        selectedIcao={null}
        sort={{ key: 'distance', direction: 'asc' }}
        onSort={vi.fn()}
        onSelect={onSelect}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /select EZY42KD/i }))
    expect(onSelect).toHaveBeenCalledWith('406b90')
    expect(screen.getByText('18,000 ft')).toBeInTheDocument()
  })
})
