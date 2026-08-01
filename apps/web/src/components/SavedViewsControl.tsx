import { useEffect, useMemo, useState } from 'react'
import type { SavedView, SavedViewConfiguration } from '@flightmap/shared'
import { Bookmark, Check, Pencil, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { api } from '../lib/api'

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
  const [views, setViews] = useState<SavedView[]>([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const surfaceViews = useMemo(() => views.filter((view) => view.surface === surface), [views, surface])

  useEffect(() => {
    const controller = new AbortController()
    void api
      .savedViews(controller.signal)
      .then((items) => {
        setViews(items)
        setError(null)
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Saved views unavailable')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  const create = async () => {
    const cleanName = name.trim()
    if (!cleanName) return
    setBusyId('new')
    setError(null)
    try {
      const view = await api.createSavedView({ name: cleanName, configuration: configuration() })
      setViews((current) => [view, ...current])
      setName('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'View could not be saved')
    } finally {
      setBusyId(null)
    }
  }

  const rename = async (view: SavedView) => {
    const nextName = window.prompt('Rename saved view', view.name)?.trim()
    if (!nextName || nextName === view.name) return
    setBusyId(view.id)
    try {
      const updated = await api.updateSavedView(view.id, { name: nextName })
      setViews((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'View could not be renamed')
    } finally {
      setBusyId(null)
    }
  }

  const replace = async (view: SavedView) => {
    setBusyId(view.id)
    try {
      const updated = await api.updateSavedView(view.id, { configuration: configuration() })
      setViews((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'View could not be replaced')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (view: SavedView) => {
    if (!window.confirm(`Delete “${view.name}”?`)) return
    setBusyId(view.id)
    try {
      await api.deleteSavedView(view.id)
      setViews((current) => current.filter((item) => item.id !== view.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'View could not be deleted')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className={`saved-view-control ${className}`}>
      <button type="button" className="saved-view-button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <Bookmark size={16} /> Saved views
        {surfaceViews.length ? <span>{surfaceViews.length}</span> : null}
      </button>
      {open ? (
        <section className="saved-view-menu" aria-label={`${surface} saved views`}>
          <header>
            <div><span className="eyebrow">WORKFLOW</span><strong>Saved views</strong></div>
            <button className="icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close saved views"><X size={16} /></button>
          </header>
          <form onSubmit={(event) => { event.preventDefault(); void create() }}>
            <label htmlFor={`saved-view-name-${surface}`}>Save current {surface} view</label>
            <div><input id={`saved-view-name-${surface}`} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="View name" /><button type="submit" disabled={!name.trim() || busyId !== null || views.length >= 20}><Save size={14} /> Save</button></div>
            <small>{views.length} of 20 installation-wide views</small>
          </form>
          <div className="saved-view-list">
            {loading ? <p><RefreshCw size={14} className="spin" /> Loading saved views…</p> : surfaceViews.length ? surfaceViews.map((view) => (
              <article key={view.id}>
                <button type="button" className="saved-view-apply" aria-label={`Apply ${view.name} saved view`} onClick={() => { void onApply(view.configuration); setOpen(false) }} disabled={busyId !== null}><span><strong>{view.name}</strong><small>Updated {new Date(view.updatedAt).toLocaleDateString('en-GB')}</small></span><Check size={15} /></button>
                <div>
                  <button type="button" onClick={() => void rename(view)} disabled={busyId !== null} aria-label={`Rename ${view.name}`}><Pencil size={13} /></button>
                  <button type="button" onClick={() => void replace(view)} disabled={busyId !== null} aria-label={`Replace ${view.name} with current view`}><RefreshCw size={13} /></button>
                  <button type="button" onClick={() => void remove(view)} disabled={busyId !== null} aria-label={`Delete ${view.name}`}><Trash2 size={13} /></button>
                </div>
              </article>
            )) : <p>No {surface} views saved yet.</p>}
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </section>
      ) : null}
    </div>
  )
}
