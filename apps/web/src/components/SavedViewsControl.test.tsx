import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SavedView, SavedViewConfiguration } from '@flightmap/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SavedViewsControl } from './SavedViewsControl'
import { api } from '../lib/api'
import { defaultMapLayers } from '../lib/map-preferences'

vi.mock('../lib/api', () => ({
  api: {
    savedViews: vi.fn(),
    createSavedView: vi.fn(),
    updateSavedView: vi.fn(),
    deleteSavedView: vi.fn(),
  },
}))

const configuration: SavedViewConfiguration = {
  surface: 'insights',
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  bucket: 'day',
  preset: '30d',
  sort: 'reports_desc',
  compare: false,
  mapLayers: defaultMapLayers,
  viewport: null,
}

const view: SavedView = {
  id: '9b7dc991-58bf-4c42-b033-40c637d3f09a',
  name: 'Monthly coverage',
  surface: 'insights',
  configuration,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

afterEach(cleanup)

describe('SavedViewsControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.savedViews).mockResolvedValue([view])
  })

  it('loads and applies views for the current surface', async () => {
    const onApply = vi.fn()
    render(
      <SavedViewsControl surface="insights" configuration={() => configuration} onApply={onApply} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Saved views/ }))
    const apply = await screen.findByRole('button', { name: 'Apply Monthly coverage saved view' })
    fireEvent.click(apply)
    expect(onApply).toHaveBeenCalledWith(configuration)
  })

  it('creates a named view and enforces the shared installation count', async () => {
    vi.mocked(api.savedViews).mockResolvedValue([])
    vi.mocked(api.createSavedView).mockResolvedValue(view)
    render(
      <SavedViewsControl surface="insights" configuration={() => configuration} onApply={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Saved views/ }))
    const input = await screen.findByPlaceholderText('View name')
    fireEvent.change(input, { target: { value: 'Monthly coverage' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() =>
      expect(api.createSavedView).toHaveBeenCalledWith({
        name: 'Monthly coverage',
        configuration,
      }),
    )
    expect(await screen.findByText('Monthly coverage')).toBeInTheDocument()
  })

  it('renames, replaces, and deletes a saved view', async () => {
    const renamed = { ...view, name: 'Summer coverage' }
    vi.mocked(api.updateSavedView)
      .mockResolvedValueOnce(renamed)
      .mockResolvedValueOnce(renamed)
    vi.mocked(api.deleteSavedView).mockResolvedValue(undefined)
    vi.spyOn(window, 'prompt').mockReturnValue('Summer coverage')
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(
      <SavedViewsControl surface="insights" configuration={() => configuration} onApply={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Saved views/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Monthly coverage' }))
    await waitFor(() =>
      expect(api.updateSavedView).toHaveBeenCalledWith(view.id, { name: 'Summer coverage' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Replace Summer coverage with current view' }))
    await waitFor(() =>
      expect(api.updateSavedView).toHaveBeenLastCalledWith(view.id, { configuration }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete Summer coverage' }))
    await waitFor(() => expect(api.deleteSavedView).toHaveBeenCalledWith(view.id))
    expect(await screen.findByText('No insights views saved yet.')).toBeInTheDocument()
  })
})
