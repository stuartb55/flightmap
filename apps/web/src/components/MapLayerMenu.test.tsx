import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { defaultMapLayers } from '../lib/map-preferences'
import { MapLayerMenu } from './MapLayerMenu'

async function openMenu(props: Partial<Parameters<typeof MapLayerMenu>[0]> = {}) {
  const onChange = vi.fn()
  render(<MapLayerMenu layers={defaultMapLayers} onChange={onChange} {...props} />)
  await userEvent.click(screen.getByRole('button', { name: 'Layers' }))
  return onChange
}

describe('MapLayerMenu', () => {
  it('toggles a layer', async () => {
    const onChange = await openMenu()
    await userEvent.click(screen.getByRole('checkbox', { name: /Coverage/ }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ coverage: true }))
  })

  /*
   * A deployment that has never run the airports build has no data for this
   * layer. Disabling it with the reason in place of the hint is better than
   * hiding it: a toggle that is simply missing reads as a bug, and a toggle
   * that turns on a layer with nothing in it reads as a broken map.
   */
  it('disables a layer this deployment has no data for, and says why', async () => {
    const onChange = await openMenu({
      unavailable: { airports: 'No airport data — run the airports build on the server' },
    })
    const toggle = screen.getByRole('checkbox', { name: /Airports/ })

    expect(toggle).toBeDisabled()
    expect(toggle.closest('label')).toHaveTextContent('run the airports build on the server')
    await userEvent.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves every other layer usable while one is unavailable', async () => {
    const onChange = await openMenu({ unavailable: { airports: 'No airport data' } })
    expect(screen.getByRole('checkbox', { name: /Range rings/ })).toBeEnabled()
    await userEvent.click(screen.getByRole('checkbox', { name: /Range rings/ }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rangeRings: false }))
  })

  it('offers the airport layer normally once there is data', async () => {
    const onChange = await openMenu()
    const toggle = screen.getByRole('checkbox', { name: /Airports/ })

    expect(toggle).toBeEnabled()
    expect(toggle.closest('label')).toHaveTextContent('runway centrelines')
    await userEvent.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ airports: true }))
  })
})
