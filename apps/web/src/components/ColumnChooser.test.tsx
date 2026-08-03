import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ColumnChooser } from './ColumnChooser'
import { defaultColumns } from '../lib/table-columns'

describe('ColumnChooser', () => {
  it('adds a column in canonical order rather than at the end', async () => {
    const onChange = vi.fn()
    render(<ColumnChooser columns={['identity', 'distance']} onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: /choose table columns/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /altitude/i }))

    expect(onChange).toHaveBeenCalledWith(['identity', 'altitude', 'distance'])
  })

  it('removes a column', async () => {
    const onChange = vi.fn()
    render(<ColumnChooser columns={['identity', 'altitude', 'speed']} onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: /choose table columns/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /speed/i }))

    expect(onChange).toHaveBeenCalledWith(['identity', 'altitude'])
  })

  it('does not let the identity column be removed', async () => {
    render(<ColumnChooser columns={[...defaultColumns]} onChange={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /choose table columns/i }))
    expect(screen.getByRole('checkbox', { name: /aircraft/i })).toBeDisabled()
  })

  it('offers a reset only once the layout differs from the default', async () => {
    const onChange = vi.fn()
    const { unmount } = render(
      <ColumnChooser columns={[...defaultColumns]} onChange={onChange} />,
    )
    await userEvent.click(screen.getByRole('button', { name: /choose table columns/i }))
    expect(screen.getByRole('button', { name: /reset to default columns/i })).toBeDisabled()
    unmount()

    render(<ColumnChooser columns={['identity', 'squawk']} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /choose table columns/i }))
    await userEvent.click(screen.getByRole('button', { name: /reset to default columns/i }))
    expect(onChange).toHaveBeenCalledWith([...defaultColumns])
  })

  it('closes on Escape and returns focus to the toggle', async () => {
    render(<ColumnChooser columns={[...defaultColumns]} onChange={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: /choose table columns/i })

    await userEvent.click(toggle)
    expect(screen.getByRole('dialog', { name: /table columns/i })).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(toggle).toHaveFocus()
  })
})
