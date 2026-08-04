import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SavedView, SavedViewConfiguration } from '@flightmap/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SavedViewsControl } from './SavedViewsControl'
import { ApiError, api } from '../lib/api'
import { resetSavedViews } from '../lib/saved-views'
import { defaultMapLayers } from '../lib/map-preferences'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ApiError: actual.ApiError,
    api: {
      savedViews: vi.fn(),
      createSavedView: vi.fn(),
      updateSavedView: vi.fn(),
      deleteSavedView: vi.fn(),
    },
  }
})

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
  isDefault: false,
  pinnedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

afterEach(cleanup)

describe('SavedViewsControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The list is installation state cached for every consumer at once, so each
    // test starts from an empty cache rather than the previous test's views.
    resetSavedViews()
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
    expect(
      await screen.findByRole('button', { name: 'Apply Monthly coverage saved view' }),
    ).toBeInTheDocument()
  })

  // On a phone this panel and the map layer panel are both full width, so the
  // one that is open has to close when the other button is pressed.
  it('closes when a press lands outside the control', async () => {
    render(
      <SavedViewsControl surface="insights" configuration={() => configuration} onApply={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Saved views/ }))
    expect(await screen.findByRole('region', { name: 'insights saved views' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'insights saved views' })).not.toBeInTheDocument(),
    )
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

  it('marks a view as the surface default and clears the previous one', async () => {
    const other: SavedView = {
      ...view,
      id: 'f2ac0b3e-6c0e-4a6a-9d24-3a2b0e5d7f11',
      name: 'Last week',
      isDefault: true,
    }
    vi.mocked(api.savedViews).mockResolvedValue([view, other])
    vi.mocked(api.updateSavedView).mockResolvedValue({ ...view, isDefault: true })

    render(
      <SavedViewsControl surface="insights" configuration={() => configuration} onApply={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Saved views/ }))
    const toggle = await screen.findByRole('button', {
      name: 'Open insights with Monthly coverage by default',
    })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(api.updateSavedView).toHaveBeenCalledWith(view.id, { isDefault: true }),
    )
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'))
    // One default per surface: the server clears the previous one, and the list
    // has to say so without refetching.
    expect(
      screen.getByRole('button', { name: 'Open insights with Last week by default' }),
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('pins a view as a chip and reports the cap the server enforces', async () => {
    vi.mocked(api.updateSavedView).mockResolvedValue({
      ...view,
      pinnedAt: '2026-08-02T00:00:00.000Z',
    })
    const onApply = vi.fn()
    render(
      <SavedViewsControl surface="insights" configuration={() => configuration} onApply={onApply} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Saved views/ }))
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Pin Monthly coverage beside the saved views button',
      }),
    )
    await waitFor(() => expect(api.updateSavedView).toHaveBeenCalledWith(view.id, { pinned: true }))
    const chip = await screen.findByRole('button', { name: 'Apply pinned view Monthly coverage' })
    fireEvent.click(chip)
    expect(onApply).toHaveBeenCalledWith(configuration)

    vi.mocked(api.updateSavedView).mockRejectedValueOnce(
      new ApiError(
        'Each surface supports up to 3 pinned views; unpin one first',
        'SAVED_VIEW_PIN_LIMIT',
        400,
      ),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Pin Monthly coverage beside the saved views button' }),
    )
    expect(
      await screen.findByText('Each surface supports up to 3 pinned views; unpin one first'),
    ).toBeInTheDocument()
  })
})
