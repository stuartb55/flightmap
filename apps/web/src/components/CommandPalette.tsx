import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SavedView } from '@flightmap/shared'
import { Bookmark, Plane, Search, SquareArrowOutUpRight } from 'lucide-react'
import { api } from '../lib/api'
import { nextSelectionIndex, type SelectionMove } from '../lib/aircraft-filter'
import { publishAppCommand } from '../lib/app-commands'
import { aircraftLabel } from '../lib/format'
import { useLocation } from '../lib/router'
import { useModalFocus } from '../lib/use-modal-focus'
import { useLiveAircraft } from '../state/LiveContext'
import type { Aircraft } from '../types'
import { isTextEntryTarget } from './KeyboardShortcuts'

type Group = 'Aircraft' | 'Saved views' | 'Go to' | 'Map actions'

export interface PaletteItem {
  id: string
  group: Group
  label: string
  detail: string
  /** Higher sorts first within a group; only aircraft use anything but 0. */
  score: number
  run: (openProfile: boolean) => void
}

const surfacePaths: Record<SavedView['surface'], string> = {
  live: '/',
  history: '/history',
  insights: '/insights',
}

const destinations = [
  { path: '/', label: 'Live traffic', detail: 'Map, aircraft list and filters' },
  { path: '/history', label: 'Flight history', detail: 'Search and replay past tracks' },
  { path: '/insights', label: 'Insights', detail: 'Traffic, coverage and receiver trends' },
  { path: '/alerts', label: 'Alerts', detail: 'Watchlist, rules and recent alerts' },
  { path: '/system', label: 'System', detail: 'Receiver, collector and database health' },
  { path: '/settings', label: 'Settings', detail: 'Receiver, display and retention' },
]

const groupOrder: readonly Group[] = ['Aircraft', 'Saved views', 'Go to', 'Map actions']
const AIRCRAFT_RESULT_LIMIT = 7

/**
 * How well an aircraft answers the query. An exact ICAO address or callsign is
 * what somebody typing six characters almost always meant, so it outranks a
 * substring hit on an operator name however long the live list gets.
 */
export function aircraftScore(aircraft: Aircraft, query: string): number {
  const identity = [
    aircraft.callsign?.trim().toLowerCase(),
    aircraft.registration?.toLowerCase(),
    aircraft.icao.toLowerCase(),
  ].filter((value): value is string => Boolean(value))
  const secondary = [aircraft.operator?.toLowerCase(), aircraft.typeCode?.toLowerCase()].filter(
    (value): value is string => Boolean(value),
  )
  if (identity.includes(query)) return 100
  if (identity.some((value) => value.startsWith(query))) return 70
  if (secondary.includes(query)) return 55
  if (identity.some((value) => value.includes(query))) return 40
  if (secondary.some((value) => value.startsWith(query))) return 30
  if (secondary.some((value) => value.includes(query))) return 20
  return 0
}

/** Groups keep their declared order; within one, the best match leads. */
export function rankedItems(items: PaletteItem[]): PaletteItem[] {
  return [...items].sort((left, right) => {
    if (left.group !== right.group) {
      return groupOrder.indexOf(left.group) - groupOrder.indexOf(right.group)
    }
    if (left.score !== right.score) return right.score - left.score
    return left.label.localeCompare(right.label)
  })
}

export function CommandPalette() {
  const { pathname, navigate } = useLocation()
  const { aircraftList } = useLiveAircraft()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [views, setViews] = useState<SavedView[]>([])
  const dialogRef = useRef<HTMLDivElement>(null)

  const close = () => setOpen(false)
  useModalFocus(open, dialogRef, close)

  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      // A shortcut that fires mid-sentence is worse than one that needs a click
      // out of the field first.
      if (isTextEntryTarget(event.target)) return
      event.preventDefault()
      setQuery('')
      setActiveIndex(0)
      setOpen(true)
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [])

  // Views load when the palette first opens rather than on every app load: the
  // palette is optional, and an unavailable list must not break it.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void api
      .savedViews(controller.signal)
      .then(setViews)
      .catch(() => setViews([]))
    return () => controller.abort()
  }, [open])

  if (!open) return null

  const go = (path: string) => {
    close()
    navigate(path)
  }

  const trimmed = query.trim().toLowerCase()
  const matches = (haystack: string) => !trimmed || haystack.toLowerCase().includes(trimmed)

  const aircraftItems: PaletteItem[] = trimmed
    ? aircraftList
        .map((aircraft) => ({ aircraft, score: aircraftScore(aircraft, trimmed) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, AIRCRAFT_RESULT_LIMIT)
        .map(({ aircraft, score }) => ({
          id: `aircraft:${aircraft.icao}`,
          group: 'Aircraft' as const,
          label: aircraftLabel(aircraft),
          detail: [aircraft.registration || aircraft.icao.toUpperCase(), aircraft.typeCode, aircraft.operator]
            .filter(Boolean)
            .join(' · '),
          score,
          run: (openProfile: boolean) =>
            go(openProfile ? `/aircraft/${aircraft.icao}` : `/?aircraft=${aircraft.icao}`),
        }))
    : []

  const viewItems: PaletteItem[] = views
    .filter((view) => matches(`${view.name} ${view.surface}`))
    .map((view) => ({
      id: `view:${view.id}`,
      group: 'Saved views' as const,
      label: view.name,
      detail: `${view.surface} view`,
      score: 0,
      run: () => {
        const path = surfacePaths[view.configuration.surface]
        close()
        if (pathname !== path) navigate(path)
        publishAppCommand({ type: 'apply-saved-view', configuration: view.configuration })
      },
    }))

  const destinationItems: PaletteItem[] = destinations
    .filter((destination) => matches(`${destination.label} ${destination.detail}`))
    .map((destination) => ({
      id: `page:${destination.path}`,
      group: 'Go to' as const,
      label: destination.label,
      detail: destination.detail,
      score: 0,
      run: () => go(destination.path),
    }))

  const mapAction = (
    action: 'fit-aircraft' | 'centre-receiver' | 'toggle-coverage',
    label: string,
    detail: string,
  ): PaletteItem => ({
    id: `action:${action}`,
    group: 'Map actions',
    label,
    detail,
    score: 0,
    run: () => {
      close()
      if (pathname !== '/') navigate('/')
      publishAppCommand({ type: action })
    },
  })

  const actionItems = [
    mapAction('fit-aircraft', 'Fit aircraft', 'Zoom the live map to every position'),
    mapAction('centre-receiver', 'Centre receiver', 'Return the live map to the receiver'),
    mapAction('toggle-coverage', 'Toggle coverage layer', 'Show or hide 30-day coverage'),
  ].filter((item) => matches(`${item.label} ${item.detail} map`))

  const items = rankedItems([...aircraftItems, ...viewItems, ...destinationItems, ...actionItems])
  const index = Math.min(activeIndex, Math.max(0, items.length - 1))
  const active = items[index]

  const move = (selection: SelectionMove) => {
    const next = nextSelectionIndex(index, items.length, selection)
    if (next != null) setActiveIndex(next)
  }

  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      move('first')
    } else if (event.key === 'End') {
      event.preventDefault()
      move('last')
    } else if (event.key === 'Enter') {
      event.preventDefault()
      active?.run(event.metaKey || event.ctrlKey)
    }
  }

  const groups = groupOrder.filter((group) => items.some((item) => item.group === group))

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="palette-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={dialogRef}
      >
        {/*
          The listbox exists only while it has something in it, so the combobox
          reports itself collapsed rather than pointing at an absent element.
        */}
        <div className="palette-input">
          <Search size={16} aria-hidden="true" />
          <input
            type="text"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={items.length ? 'palette-results' : undefined}
            aria-activedescendant={active ? `palette-option-${active.id}` : undefined}
            aria-autocomplete="list"
            aria-label="Search aircraft, saved views, pages and actions"
            placeholder="Search aircraft, views, pages…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={keydown}
          />
        </div>

        <p className="palette-count" role="status">
          {items.length === 1 ? '1 result' : `${items.length} results`}
        </p>

        {items.length ? (
          <ul className="palette-results" id="palette-results" role="listbox">
            {groups.map((group) => (
              <li key={group} role="group" aria-label={group}>
                <span className="palette-group" aria-hidden="true">{group}</span>
                {items
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <div
                      key={item.id}
                      id={`palette-option-${item.id}`}
                      role="option"
                      aria-selected={active?.id === item.id}
                      className={`palette-option ${active?.id === item.id ? 'active' : ''}`}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        item.run(event.metaKey || event.ctrlKey)
                      }}
                      onMouseEnter={() =>
                        setActiveIndex(items.findIndex((candidate) => candidate.id === item.id))
                      }
                    >
                      {group === 'Aircraft' ? (
                        <Plane size={15} aria-hidden="true" />
                      ) : group === 'Saved views' ? (
                        <Bookmark size={15} aria-hidden="true" />
                      ) : (
                        <SquareArrowOutUpRight size={15} aria-hidden="true" />
                      )}
                      <span>
                        <strong>{item.label}</strong>
                        {item.detail ? <small>{item.detail}</small> : null}
                      </span>
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        ) : (
          <div className="palette-empty">
            <strong>Nothing matches “{query.trim()}”</strong>
            <p>
              Aircraft match on callsign, registration, ICAO address, operator and type, and only
              while they are in the live list. Pages, saved views and map actions match on their
              names.
            </p>
          </div>
        )}

        <footer className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Move</span>
          <span><kbd>Enter</kbd> Open</span>
          <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> Aircraft profile</span>
          <span><kbd>Esc</kbd> Close</span>
        </footer>
      </div>
    </div>
  )
}
