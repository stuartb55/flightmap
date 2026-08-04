import { useEffect, useMemo, useRef, useState } from 'react'
import type { SavedView, SavedViewConfiguration } from '@flightmap/shared'
import { savedViewPinLimit } from '@flightmap/shared'
import { Bookmark, Check, Pencil, Pin, RefreshCw, Save, Star, Trash2, X } from 'lucide-react'
import { api } from '../lib/api'
import {
  ensureSavedViews,
  forgetSavedView,
  pinnedViews,
  storeSavedView,
  useSavedViews,
  viewsForSurface,
} from '../lib/saved-views'

export function SavedViewsControl({
  surface,
  configuration,
  onApply,
  className = '',
}: {
  surface: SavedView['surface']
  configuration: () => SavedViewConfiguration
  onApply: (configuration: SavedViewConfiguration) => void | Promise<void>
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const controlRef = useRef<HTMLDivElement>(null)
  const { views, loading, loaded, error: loadError } = useSavedViews()
  const [name, setName] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const surfaceViews = useMemo(() => viewsForSurface(views, surface), [views, surface])
  const pinned = useMemo(() => pinnedViews(views, surface), [views, surface])

  useEffect(() => {
    void ensureSavedViews()
  }, [])

  /*
   * The menu floats over the map beside the layer menu, which closes the same
   * way. Dismissing on an outside press keeps at most one of the two panels
   * covering a phone-sized map.
   */
  useEffect(() => {
    if (!open) return
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!controlRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const create = async () => {
    const cleanName = name.trim()
    if (!cleanName) return
    setBusyId('new')
    setError(null)
    try {
      const view = await api.createSavedView({ name: cleanName, configuration: configuration() })
      storeSavedView(view)
      setName('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'View could not be saved')
    } finally {
      setBusyId(null)
    }
  }

  const patch = async (view: SavedView, changes: Parameters<typeof api.updateSavedView>[1], failure: string) => {
    setBusyId(view.id)
    setError(null)
    try {
      storeSavedView(await api.updateSavedView(view.id, changes))
    } catch (reason) {
      // The pin cap and the default's uniqueness are enforced in the database,
      // so the message that names the limit is the server's, not a guess here.
      setError(reason instanceof Error ? reason.message : failure)
    } finally {
      setBusyId(null)
    }
  }

  const rename = async (view: SavedView) => {
    const nextName = window.prompt('Rename saved view', view.name)?.trim()
    if (!nextName || nextName === view.name) return
    await patch(view, { name: nextName }, 'View could not be renamed')
  }

  const replace = (view: SavedView) =>
    patch(view, { configuration: configuration() }, 'View could not be replaced')

  const toggleDefault = (view: SavedView) =>
    patch(view, { isDefault: !view.isDefault }, 'Default could not be changed')

  const togglePin = (view: SavedView) =>
    patch(view, { pinned: view.pinnedAt === null }, 'Pin could not be changed')

  const remove = async (view: SavedView) => {
    if (!window.confirm(`Delete “${view.name}”?`)) return
    setBusyId(view.id)
    try {
      await api.deleteSavedView(view.id)
      forgetSavedView(view.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'View could not be deleted')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className={`saved-view-control ${className}`} ref={controlRef}>
      <button type="button" className="saved-view-button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <Bookmark size={16} /> Saved views
        {surfaceViews.length ? <span>{surfaceViews.length}</span> : null}
      </button>
      {pinned.length ? (
        <ul className="saved-view-pins" aria-label={`Pinned ${surface} views`}>
          {pinned.map((view) => (
            <li key={view.id}>
              <button
                type="button"
                className="saved-view-pin"
                aria-label={`Apply pinned view ${view.name}`}
                onClick={() => void onApply(view.configuration)}
              >
                <Pin size={13} aria-hidden="true" />
                <span>{view.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <section className="saved-view-menu" aria-label={`${surface} saved views`}>
          <header>
            <div><span className="eyebrow">WORKFLOW</span><strong>Saved views</strong></div>
            <button className="icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close saved views"><X size={16} /></button>
          </header>
          <form onSubmit={(event) => { event.preventDefault(); void create() }}>
            <label htmlFor={`saved-view-name-${surface}`}>Save current {surface} view</label>
            <div><input id={`saved-view-name-${surface}`} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="View name" /><button type="submit" disabled={!name.trim() || busyId !== null || views.length >= 20}><Save size={14} /> Save</button></div>
            <small>{views.length} of 20 installation-wide views · up to {savedViewPinLimit} pinned per surface</small>
          </form>
          <div className="saved-view-list">
            {loading && !loaded ? <p><RefreshCw size={14} className="spin" /> Loading saved views…</p> : surfaceViews.length ? surfaceViews.map((view) => (
              <article key={view.id}>
                <button type="button" className="saved-view-apply" aria-label={`Apply ${view.name} saved view`} onClick={() => { void onApply(view.configuration); setOpen(false) }} disabled={busyId !== null}><span><strong>{view.name}</strong><small>{view.isDefault ? 'Default · ' : ''}{view.pinnedAt ? 'Pinned · ' : ''}Updated {new Date(view.updatedAt).toLocaleDateString('en-GB')}</small></span><Check size={15} /></button>
                <div>
                  <button type="button" onClick={() => void toggleDefault(view)} disabled={busyId !== null} aria-pressed={view.isDefault} aria-label={`Open ${surface} with ${view.name} by default`} className={view.isDefault ? 'active' : ''}><Star size={13} /></button>
                  <button type="button" onClick={() => void togglePin(view)} disabled={busyId !== null} aria-pressed={view.pinnedAt !== null} aria-label={`Pin ${view.name} beside the saved views button`} className={view.pinnedAt ? 'active' : ''}><Pin size={13} /></button>
                  <button type="button" onClick={() => void rename(view)} disabled={busyId !== null} aria-label={`Rename ${view.name}`}><Pencil size={13} /></button>
                  <button type="button" onClick={() => void replace(view)} disabled={busyId !== null} aria-label={`Replace ${view.name} with current view`}><RefreshCw size={13} /></button>
                  <button type="button" onClick={() => void remove(view)} disabled={busyId !== null} aria-label={`Delete ${view.name}`}><Trash2 size={13} /></button>
                </div>
              </article>
            )) : <p>No {surface} views saved yet.</p>}
          </div>
          {error ?? loadError ? <p className="form-error" role="alert">{error ?? loadError}</p> : null}
        </section>
      ) : null}
    </div>
  )
}
