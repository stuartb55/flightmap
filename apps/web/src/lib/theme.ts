import { useSyncExternalStore } from 'react'

/**
 * Theme and density are per-browser choices, like units: the same receiver is
 * read on a phone in the sun and on a desktop in a dark room, and the person
 * doing it is not always the one who owns the server settings.
 *
 * The stored shape and key are duplicated by `public/appearance.js`, which
 * stamps the same attributes on `<html>` before the first paint so the page
 * never flashes the wrong theme. Change one and change the other; the
 * `theme.bootstrap.test.ts` suite asserts that they still agree.
 */

export type ThemeChoice = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'
export type Density = 'comfortable' | 'compact'

export interface Appearance {
  theme: ThemeChoice
  density: Density
}

export const APPEARANCE_STORAGE_KEY = 'flightmap.appearance.v1'

/** A dark radar map is what the receiver has always shown, so it stays the default. */
export const defaultAppearance: Appearance = { theme: 'dark', density: 'comfortable' }

export const themeChoices: readonly ThemeChoice[] = ['system', 'dark', 'light']
export const densities: readonly Density[] = ['comfortable', 'compact']

export const themeLabels: Record<ThemeChoice, string> = {
  system: 'Match the system',
  dark: 'Dark',
  light: 'Light',
}

export const densityLabels: Record<Density, string> = {
  comfortable: 'Comfortable',
  compact: 'Compact',
}

/** The colour the browser paints around the page, matching each theme's background. */
export const themeColour: Record<ResolvedTheme, string> = { dark: '#070b10', light: '#ffffff' }

const LIGHT_QUERY = '(prefers-color-scheme: light)'

function option<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/**
 * Corrupt or partial storage falls back field by field, so an unrecognised
 * theme added by a later version does not also cost the reader their density.
 */
export function readAppearance(storage: Pick<Storage, 'getItem'> = localStorage): Appearance {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null')
    if (parsed === null || typeof parsed !== 'object') return { ...defaultAppearance }
    const record = parsed as Record<string, unknown>
    return {
      theme: option(record.theme, themeChoices, defaultAppearance.theme),
      density: option(record.density, densities, defaultAppearance.density),
    }
  } catch {
    return { ...defaultAppearance }
  }
}

export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): ResolvedTheme {
  if (choice === 'system') return prefersLight ? 'light' : 'dark'
  return choice
}

function prefersLight(): boolean {
  return typeof matchMedia === 'function' && matchMedia(LIGHT_QUERY).matches
}

/** Writes the choice onto `<html>`, where the stylesheets and the map read it. */
export function applyAppearance(appearance: Appearance, root: HTMLElement): void {
  const resolved = resolveTheme(appearance.theme, prefersLight())
  root.dataset.theme = resolved
  root.dataset.density = appearance.density
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', themeColour[resolved])
}

let current: Appearance | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function appearance(): Appearance {
  current ??= readAppearance()
  return current
}

export function setAppearance(next: Appearance): void {
  current = { ...next }
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(current))
  } catch {
    // An appearance that cannot be stored still applies to this session.
  }
  applyAppearance(current, document.documentElement)
  notify()
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribeAppearance, appearance, appearance)
}

function resolvedTheme(): ResolvedTheme {
  return resolveTheme(appearance().theme, prefersLight())
}

/**
 * The theme actually in force, for the parts of the interface CSS cannot reach
 * — chiefly the map style, which is fetched rather than styled.
 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeAppearance, resolvedTheme, resolvedTheme)
}

/**
 * Re-applies the appearance when the system theme changes under a `system`
 * choice. The initial stamp is `public/appearance.js`'s job, not this one's.
 */
export function watchSystemTheme(): () => void {
  if (typeof matchMedia !== 'function') return () => {}
  const query = matchMedia(LIGHT_QUERY)
  const onChange = () => {
    if (appearance().theme !== 'system') return
    applyAppearance(appearance(), document.documentElement)
    notify()
  }
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
