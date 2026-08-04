import { afterEach, describe, expect, it, vi } from 'vitest'
import bootstrapScript from '../../public/appearance.js?raw'
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  appearance,
  currentTheme,
  defaultAppearance,
  readAppearance,
  resolveTheme,
  setAppearance,
  subscribeAppearance,
  themeColour,
  watchSystemTheme,
} from './theme'

function storageOf(value: string | null): Pick<Storage, 'getItem'> {
  return { getItem: () => value }
}

/** Makes `matchMedia('(prefers-color-scheme: light)')` answer as given. */
function systemPrefersLight(matches: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  setAppearance(defaultAppearance)
})

describe('stored appearance', () => {
  it('defaults to the dark theme at a comfortable density', () => {
    expect(readAppearance(storageOf(null))).toEqual({ theme: 'dark', density: 'comfortable' })
  })

  it('reads a complete stored choice', () => {
    const stored = JSON.stringify({ theme: 'light', density: 'compact' })
    expect(readAppearance(storageOf(stored))).toEqual({ theme: 'light', density: 'compact' })
  })

  it('falls back field by field rather than discarding the whole preference', () => {
    const stored = JSON.stringify({ theme: 'solarised', density: 'compact' })
    expect(readAppearance(storageOf(stored))).toEqual({ theme: 'dark', density: 'compact' })
  })

  it.each(['not json at all', '"a string"', '42', 'null'])(
    'falls back to the defaults for unusable storage: %s',
    (value) => {
      expect(readAppearance(storageOf(value))).toEqual(defaultAppearance)
    },
  )

  it('survives storage that throws on read', () => {
    const hostile = {
      getItem: () => {
        throw new Error('access denied')
      },
    }
    expect(readAppearance(hostile)).toEqual(defaultAppearance)
  })
})

describe('resolving a theme', () => {
  it('takes an explicit choice at face value whatever the system prefers', () => {
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('light', false)).toBe('light')
  })

  it('follows the system only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
  })
})

describe('applying an appearance', () => {
  it('stamps the resolved theme and the density on the root element', () => {
    const root = document.documentElement
    applyAppearance({ theme: 'light', density: 'compact' }, root)
    expect(root.dataset.theme).toBe('light')
    expect(root.dataset.density).toBe('compact')
  })

  it('resolves a system choice against the media query', () => {
    systemPrefersLight(true)
    applyAppearance({ theme: 'system', density: 'comfortable' }, document.documentElement)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('moves the browser chrome colour with the theme', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.append(meta)
    applyAppearance({ theme: 'light', density: 'comfortable' }, document.documentElement)
    expect(meta.getAttribute('content')).toBe(themeColour.light)
    applyAppearance({ theme: 'dark', density: 'comfortable' }, document.documentElement)
    expect(meta.getAttribute('content')).toBe(themeColour.dark)
    meta.remove()
  })
})

describe('the appearance store', () => {
  it('persists a change, applies it, and tells subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAppearance(listener)
    setAppearance({ theme: 'light', density: 'compact' })
    expect(listener).toHaveBeenCalled()
    expect(appearance()).toEqual({ theme: 'light', density: 'compact' })
    expect(currentTheme()).toBe('light')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null')).toEqual({
      theme: 'light',
      density: 'compact',
    })
    unsubscribe()
  })

  it('keeps applying a choice this session even when storage refuses it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => setAppearance({ theme: 'light', density: 'comfortable' })).not.toThrow()
    expect(currentTheme()).toBe('light')
  })
})

describe('following the system theme', () => {
  it('repaints on a system change only while the choice is `system`', () => {
    const handlers = new Set<() => void>()
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: (_: string, handler: () => void) => handlers.add(handler),
          removeEventListener: (_: string, handler: () => void) => handlers.delete(handler),
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    )

    setAppearance({ theme: 'dark', density: 'comfortable' })
    const stop = watchSystemTheme()
    for (const handler of handlers) handler()
    expect(document.documentElement.dataset.theme).toBe('dark')

    setAppearance({ theme: 'system', density: 'comfortable' })
    for (const handler of handlers) handler()
    expect(document.documentElement.dataset.theme).toBe('light')

    stop()
    expect(handlers.size).toBe(0)
  })
})

/*
 * public/appearance.js runs before the bundle and therefore repeats what
 * theme.ts knows. These cases fail if the two ever stop agreeing, which is the
 * failure that would show up as a flash of the wrong theme rather than as an
 * error.
 */
describe('the pre-paint bootstrap script', () => {
  const script = bootstrapScript

  it('reads the same storage key', () => {
    expect(script).toContain(APPEARANCE_STORAGE_KEY)
  })

  it('knows every theme and density the store accepts', () => {
    for (const value of ['light', 'dark', 'system', 'compact', 'comfortable']) {
      expect(script).toContain(`'${value}'`)
    }
  })

  it('uses the same chrome colours', () => {
    expect(script).toContain(themeColour.light)
    expect(script).toContain(themeColour.dark)
  })

  it('stamps the defaults when nothing is stored', () => {
    const root = document.createElement('html')
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    const scope = {
      document: {
        documentElement: root,
        querySelector: () => meta,
      },
      localStorage: { getItem: () => null },
      window: { matchMedia: () => ({ matches: false }) },
    }
    new Function('document', 'localStorage', 'window', script)(
      scope.document,
      scope.localStorage,
      scope.window,
    )
    expect(root.getAttribute('data-theme')).toBe(defaultAppearance.theme)
    expect(root.getAttribute('data-density')).toBe(defaultAppearance.density)
  })
})
