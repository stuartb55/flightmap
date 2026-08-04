import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SavedView, SavedViewConfiguration } from '@flightmap/shared'
import { api } from './api'

/**
 * Saved views are installation-wide server state read by three consumers at
 * once: the popover that edits them, the command palette, and every surface,
 * which now asks for its default before its first fetch. One shared store keeps
 * that to a single request and keeps a pin toggled in the popover in step with
 * the chips rendered beside it.
 */

export interface SavedViewsState {
  views: SavedView[]
  loading: boolean
  /** False until the first load settles, whether it succeeded or failed. */
  loaded: boolean
  error: string | null
}

let state: SavedViewsState = { views: [], loading: false, loaded: false, error: null }
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: Partial<SavedViewsState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function savedViewsSnapshot(): SavedViewsState {
  return state
}

const snapshot = savedViewsSnapshot

/**
 * Resolves once the list has been fetched, whether it arrived or failed. A
 * failed load must not leave a surface waiting: the built-in default is the
 * right answer when the server cannot say otherwise.
 */
export function ensureSavedViews(): Promise<void> {
  if (state.loaded) return Promise.resolve()
  if (inflight) return inflight
  publish({ loading: true })
  inflight = api
    .savedViews()
    .then((views) => {
      publish({ views, loading: false, loaded: true, error: null })
    })
    .catch((reason: unknown) => {
      publish({
        views: [],
        loading: false,
        loaded: true,
        error: reason instanceof Error ? reason.message : 'Saved views unavailable',
      })
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Refetches even when the cache is warm — another tab may have edited them. */
export function refreshSavedViews(): Promise<void> {
  if (inflight) return inflight
  state = { ...state, loaded: false }
  return ensureSavedViews()
}

export function useSavedViews(): SavedViewsState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * Mirrors the server's per-surface invariants locally so the list does not have
 * to be refetched after every toggle: at most one default per surface, and a
 * pin that the server refused never reaches this function.
 */
export function storeSavedView(view: SavedView): void {
  const others = state.views.map((item) =>
    item.id === view.id || item.surface !== view.surface || !view.isDefault
      ? item
      : { ...item, isDefault: false },
  )
  const existing = others.some((item) => item.id === view.id)
  publish({
    views: existing ? others.map((item) => (item.id === view.id ? view : item)) : [view, ...others],
  })
}

export function forgetSavedView(id: string): void {
  publish({ views: state.views.filter((view) => view.id !== id) })
}

/** For tests: drop the cache so the next consumer refetches. */
export function resetSavedViews(): void {
  state = { views: [], loading: false, loaded: false, error: null }
  inflight = null
  for (const listener of listeners) listener()
}

export function viewsForSurface(
  views: SavedView[],
  surface: SavedView['surface'],
): SavedView[] {
  return views.filter((view) => view.surface === surface)
}

/** Pin order is the order they were pinned in, so chips do not reshuffle. */
export function pinnedViews(views: SavedView[], surface: SavedView['surface']): SavedView[] {
  return viewsForSurface(views, surface)
    .filter((view) => view.pinnedAt !== null)
    .sort((left, right) => Date.parse(left.pinnedAt!) - Date.parse(right.pinnedAt!))
}

export function defaultView(
  views: SavedView[],
  surface: SavedView['surface'],
): SavedView | null {
  return viewsForSurface(views, surface).find((view) => view.isDefault) ?? null
}

/**
 * Loads the list and hands back the surface's default, if any. Surfaces call
 * this before their first fetch so the default range or filters are the ones
 * queried — a default applied afterwards would show the built-in state first
 * and then replace it.
 */
export function resolveDefaultView(
  surface: SavedView['surface'],
): Promise<SavedView | null> {
  return ensureSavedViews().then(() => defaultView(state.views, surface))
}

/**
 * Holds a surface's first fetch until its default view has been applied, and
 * returns true once the surface may query. `skip` is read once, on mount: a URL
 * carrying explicit parameters is a request for a specific view and outranks
 * the default, and it must not be overwritten by a list that arrives later.
 */
export function useDefaultSavedView(
  surface: SavedView['surface'],
  skip: boolean,
  apply: (configuration: SavedViewConfiguration) => void,
): boolean {
  const applyRef = useRef(apply)
  applyRef.current = apply
  const [resolved, setResolved] = useState(skip)

  useEffect(() => {
    if (resolved) return
    let cancelled = false
    void resolveDefaultView(surface).then((view) => {
      if (cancelled) return
      /*
       * Both updates are made from one callback, so React commits them
       * together: the surface's first query already carries the default rather
       * than running once against the built-in state and again against this.
       */
      if (view) applyRef.current(view.configuration)
      setResolved(true)
    })
    return () => {
      cancelled = true
    }
  }, [surface, resolved])

  return resolved
}
