import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedView } from '@flightmap/shared'
import { api } from './api'
import {
  defaultView,
  ensureSavedViews,
  forgetSavedView,
  pinnedViews,
  resetSavedViews,
  savedViewsSnapshot,
  storeSavedView,
} from './saved-views'
import { defaultMapLayers } from './map-preferences'

vi.mock('./api', () => ({ api: { savedViews: vi.fn() } }))

function view(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: 'a1',
    name: 'A view',
    surface: 'insights',
    configuration: {
      surface: 'insights',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      bucket: 'day',
      preset: '30d',
      sort: 'reports_desc',
      compare: false,
      mapLayers: defaultMapLayers,
      viewport: null,
    },
    isDefault: false,
    pinnedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('saved views store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSavedViews()
    vi.mocked(api.savedViews).mockResolvedValue([])
  })

  // Three consumers ask for the list at once on every page load — the popover,
  // the palette, and the surface waiting for its default.
  it('serves concurrent callers from one request', async () => {
    await Promise.all([ensureSavedViews(), ensureSavedViews(), ensureSavedViews()])
    await ensureSavedViews()
    expect(api.savedViews).toHaveBeenCalledTimes(1)
  })

  it('settles with an empty list when the request fails, so no surface waits', async () => {
    vi.mocked(api.savedViews).mockRejectedValue(new Error('Saved views unavailable'))
    await expect(ensureSavedViews()).resolves.toBeUndefined()
    expect(defaultView([], 'live')).toBeNull()
  })

  it('keeps one default per surface when a new one is stored', () => {
    storeSavedView(view({ id: 'a1', isDefault: true }))
    storeSavedView(view({ id: 'b1', surface: 'live', isDefault: true }))
    storeSavedView(view({ id: 'a2', name: 'Another', isDefault: true }))

    expect(defaultView(savedViewsSnapshot().views, 'insights')?.id).toBe('a2')
    // A live default is untouched by an insights one: the constraint is per
    // surface, exactly like the partial unique index behind it.
    expect(defaultView(savedViewsSnapshot().views, 'live')?.id).toBe('b1')

    forgetSavedView('a2')
    expect(defaultView(savedViewsSnapshot().views, 'insights')).toBeNull()
  })

  it('orders pins by when they were pinned', () => {
    const views = [
      view({ id: 'a1', name: 'Second', pinnedAt: '2026-08-02T00:00:00.000Z' }),
      view({ id: 'a2', name: 'First', pinnedAt: '2026-08-01T00:00:00.000Z' }),
      view({ id: 'a3', name: 'Unpinned' }),
      view({ id: 'a4', name: 'Live', surface: 'live', pinnedAt: '2026-08-01T00:00:00.000Z' }),
    ]
    expect(pinnedViews(views, 'insights').map((item) => item.name)).toEqual(['First', 'Second'])
  })
})
