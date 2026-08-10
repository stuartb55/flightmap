import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AlertTriangle,
  ChevronLeft,
  List,
  PanelLeftClose,
  Plane,
  Search,
  SlidersHorizontal,
  WifiOff,
  X,
} from 'lucide-react'
import type { MapViewport, SavedViewConfiguration } from '@flightmap/shared'
import { AircraftDetailPanel } from '../components/AircraftDetailPanel'
import { AircraftFilters } from '../components/AircraftFilters'
import { AircraftTable } from '../components/AircraftTable'
import { LiveSheetTraffic } from '../components/LiveSheetTraffic'
import { ColumnChooser } from '../components/ColumnChooser'
import { isFormTarget, isPlainKey } from '../components/KeyboardShortcuts'
import { RadarMap, type RadarMapHandle } from '../components/RadarMap'
import { api } from '../lib/api'
import {
  activeFilterCount,
  defaultAircraftFilters,
  filtersFromParams,
  nextSelectionIndex,
  writeFiltersToParams,
  type AircraftFilters as AircraftFilterState,
  type AircraftSort,
  type AircraftSortKey,
  type SelectionMove,
} from '../lib/aircraft-filter'
import { shareUrl, viewportFromParams } from '../lib/map-snapshot'
import { useOrderedAircraft } from '../lib/use-ordered-aircraft'
import { bandForRange, toggleBand, type AltitudeBand } from '../lib/altitude-bands'
import { aircraftLabel, formatAltitude, formatDateTime } from '../lib/format'
import { useUnitPreferences } from '../lib/unit-preferences'
import { useNewSightingCutoff } from '../lib/sighting-preferences'
import { useAirports } from '../lib/use-airports'
import { useSearchParams } from '../lib/router'
import { useModalFocus } from '../lib/use-modal-focus'
import { nextStopLabel, useSheetStops } from '../lib/use-sheet-stops'
import { useAppCommands } from '../lib/app-commands'
import { useDefaultSavedView } from '../lib/saved-views'
import { useAircraftColumns } from '../lib/table-columns'
import { defaultMapDisplay, useCoverageCells, useMapDisplay, useMapLayers } from '../lib/map-preferences'
import { useLiveAircraft, useLiveDispatch, useLiveStatus } from '../state/LiveContext'
import type { AlertEvent, TrackResponse } from '../types'

/*
 * The aircraft list used to be a panel summoned over the map alongside the
 * filters. It is now the sheet the page is built around and is always on
 * screen, so the filters are the only thing left that opens as a modal.
 */
type MobilePanel = 'filters' | null
const FILTER_STORAGE_KEY = 'flightmap.aircraft-filters.v1'

export function emergencyBannerAlert(alerts: AlertEvent[]): AlertEvent | undefined {
  return alerts.find((alert) => alert.type === 'emergency' && !alert.dismissedAt)
}

const sortDescriptions: Record<AircraftSortKey, readonly [ascending: string, descending: string]> = {
  identity: ['A to Z', 'Z to A'],
  altitude: ['Lowest first', 'Highest first'],
  distance: ['Nearest first', 'Farthest first'],
  speed: ['Slowest first', 'Fastest first'],
  freshness: ['Newest first', 'Oldest first'],
  verticalRate: ['Descending first', 'Climbing first'],
  track: ['Track ascending', 'Track descending'],
  squawk: ['Squawk ascending', 'Squawk descending'],
  operator: ['Operator A to Z', 'Operator Z to A'],
  typeCode: ['Type A to Z', 'Type Z to A'],
}

/**
 * What the sheet's list is currently ordered by, in the words the reader would
 * use. The sheet header carries this rather than a column of sort arrows,
 * because at this width there are no columns to put them on.
 */
export function sortDescription(sort: AircraftSort): string {
  return sortDescriptions[sort.key][sort.direction === 'asc' ? 0 : 1]
}

function storedFilters(): AircraftFilterState {
  try {
    const value = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) ?? 'null') as unknown
    if (!value || typeof value !== 'object') return { ...defaultAircraftFilters }
    const candidate = value as Partial<AircraftFilterState>
    return {
      ...defaultAircraftFilters,
      ...Object.fromEntries(
        Object.keys(defaultAircraftFilters)
          .filter((key) => key in candidate)
          .map((key) => [key, candidate[key as keyof AircraftFilterState]]),
      ),
      position: ['all', 'positioned', 'unpositioned'].includes(candidate.position ?? '')
        ? candidate.position!
        : 'all',
    } as AircraftFilterState
  } catch {
    return { ...defaultAircraftFilters }
  }
}

export function LivePage() {
  const units = useUnitPreferences()
  const newSince = useNewSightingCutoff()
  const airports = useAirports()
  const { aircraftList, trails } = useLiveAircraft()
  const { receiver, connection, error, alerts, hasSnapshot } = useLiveStatus()
  // Mirrors the header's own reading of the two states, so the dot the map
  // shows in its place cannot disagree with the one the other pages show.
  const receiverState =
    connection === 'live' ? (receiver?.status ?? 'connecting') : connection === 'connecting' ? 'connecting' : connection
  const dispatch = useLiveDispatch()
  const [searchParams, setSearchParams] = useSearchParams()
  /*
   * A shared link outranks this browser's stored filters — someone opening it
   * is asking to see the sender's view, not their own — and the viewport it
   * carries is handed to the map at construction so there is no jump.
   */
  // Both read the router rather than `window.location`, and both are lazy
  // initialisers: a link is what the page opened with, not something it tracks.
  const [filters, setFilters] = useState<AircraftFilterState>(
    () => filtersFromParams(searchParams) ?? storedFilters(),
  )
  const [sharedViewport] = useState(() => viewportFromParams(searchParams))
  const [sort, setSort] = useState<AircraftSort>({ key: 'distance', direction: 'asc' })
  const [columns, setColumns] = useAircraftColumns()
  const [listCollapsed, setListCollapsed] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null)
  const [selectedTrack, setSelectedTrack] = useState<TrackResponse | null>(null)
  const [trackError, setTrackError] = useState<string | null>(null)
  const [bannerError, setBannerError] = useState<string | null>(null)
  const [dismissingBanner, setDismissingBanner] = useState(false)
  const [mapLayers, setMapLayers] = useMapLayers()
  const [mapDisplay, setMapDisplay] = useMapDisplay()
  const [mapBottomInset, setMapBottomInset] = useState(0)
  const coverage = useCoverageCells(mapLayers.coverage)
  const mapRef = useRef<RadarMapHandle>(null)
  const mapStageRef = useRef<HTMLElement>(null)
  const detailPanelRef = useRef<HTMLElement>(null)
  const liveSheetRef = useRef<HTMLElement>(null)
  const livePageRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Both search fields exist at every width; only one of them is laid out.
  const mapSearchRef = useRef<HTMLInputElement>(null)
  const filtersDialogRef = useRef<HTMLElement>(null)
  const mobileFiltersRef = useRef<HTMLElement>(null)

  /*
   * One sheet in three stops rather than two panels that take turns. The list
   * and a selected aircraft are two things the same sheet can be showing, so
   * one stop governs both and the grab handle means the same thing whichever
   * of the two is on screen.
   */
  const sheet = useSheetStops('peek')
  const { stop: sheetStop, setStop: setSheetStop } = sheet

  useModalFocus(showFilters, filtersDialogRef, () => setShowFilters(false))
  useModalFocus(mobilePanel === 'filters', mobileFiltersRef, () => setMobilePanel(null))

  useEffect(() => {
    if (mobilePanel) livePageRef.current?.scrollTo({ top: 0, left: 0 })
  }, [mobilePanel])

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters))
    } catch {
      // Private browsing or a full storage quota should not block live data.
    }
  }, [filters])

  const selectedIcao = searchParams.get('aircraft')?.toLowerCase() ?? null
  const selected = selectedIcao ? aircraftList.find((item) => item.icao === selectedIcao) ?? null : null
  const hasDetail = selected != null

  // Each aircraft opens at the peek stop: the point of the sheet is that
  // picking through traffic never buries the map.
  useEffect(() => {
    setSheetStop('peek')
  }, [selectedIcao, setSheetStop])

  /*
   * How much of the map the detail panel covers, measured rather than derived
   * from the breakpoint: beside the map it covers nothing, over it as a sheet
   * it covers whatever its current stop comes to. The map aims its camera at
   * what is left.
   *
   * The same pass publishes the map's own height, which a banner above it can
   * take a bite out of. The collapsed sheet is capped against that rather than
   * against the page, so a run of banners on a short screen cannot leave the
   * map a strip. It cannot feed back: the sheet floats over the map and so has
   * no say in its height.
   */
  useEffect(() => {
    const stage = mapStageRef.current
    // Whichever of the two the sheet is currently showing. Only one of them is
    // ever laid out, so the one that is covering the map is the one to measure.
    const panel = detailPanelRef.current ?? liveSheetRef.current
    if (!stage || !panel) {
      setMapBottomInset(0)
      return
    }
    const measure = () => {
      const stageBox = stage.getBoundingClientRect()
      const panelBox = panel.getBoundingClientRect()
      livePageRef.current?.style.setProperty('--map-stage-height', `${Math.round(stageBox.height)}px`)
      const overlapsAcross = panelBox.left < stageBox.right - 1 && panelBox.right > stageBox.left + 1
      const covered = overlapsAcross ? Math.max(0, Math.round(stageBox.bottom - panelBox.top)) : 0
      setMapBottomInset(covered)
      // The map key and the basemap attribution ride on top of the sheet's
      // current stop rather than on the bottom of the map, which the sheet
      // covers at every stop but the peek.
      livePageRef.current?.style.setProperty('--live-sheet-cover', `${covered}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [sheetStop, hasDetail])
  const filtered = useOrderedAircraft(aircraftList, filters, sort, newSince)
  const sources = useMemo(
    () =>
      [...new Set(aircraftList.map((aircraft) => aircraft.source).filter((source): source is string => Boolean(source)))].sort(),
    [aircraftList],
  )
  const categories = useMemo(
    () =>
      [...new Set(aircraftList.map((aircraft) => aircraft.category).filter((category): category is string => Boolean(category)))].sort(),
    [aircraftList],
  )
  const positionedCount = aircraftList.filter(
    (aircraft) => aircraft.latitude != null && aircraft.longitude != null,
  ).length
  const bannerAlert = emergencyBannerAlert(alerts)
  const filterCount = activeFilterCount(filters)

  useEffect(() => {
    const sessionId = selected?.sessionId
    if (!sessionId || !mapLayers.trails) {
      setSelectedTrack(null)
      return
    }
    const controller = new AbortController()
    setSelectedTrack(null)
    setTrackError(null)
    let inFlight = false
    let nextFrom: string | undefined
    const loadTrack = async (initial = false) => {
      if (inFlight) return
      inFlight = true
      try {
        const from = initial ? undefined : nextFrom
        const response = await api.track(sessionId, 'auto', controller.signal, {
          ...(from ? { from } : {}),
          tail: initial,
          limit: initial ? 1_800 : 1_200,
        })
        if (controller.signal.aborted) return
        nextFrom = response.points.at(-1)?.recordedAt ?? nextFrom
        setSelectedTrack((current) => {
          if (initial || !current || current.session.id !== sessionId) return response
          const points = new Map(current.points.map((point) => [point.recordedAt, point]))
          for (const point of response.points) points.set(point.recordedAt, point)
          return {
            ...response,
            truncated: current.truncated || response.truncated,
            points: [...points.values()]
              .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
              .slice(-3_600),
          }
        })
        setTrackError(null)
      } catch (reason) {
        if (!controller.signal.aborted) {
          setTrackError(reason instanceof Error ? reason.message : 'Live trail is unavailable')
        }
      } finally {
        inFlight = false
      }
    }
    void loadTrack(true)
    const timer = window.setInterval(() => void loadTrack(false), 10_000)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [selected?.sessionId, mapLayers.trails])

  const trail = useMemo<TrackResponse[]>(() => {
    if (selectedTrack) {
      const latest = Date.parse(selectedTrack.points.at(-1)?.recordedAt ?? selectedTrack.session.startedAt)
      const cutoff = latest - mapDisplay.trailMinutes * 60_000
      return [{ ...selectedTrack, points: selectedTrack.points.filter((point) => Date.parse(point.recordedAt) >= cutoff) }]
    }
    if (!selected?.trail?.length) return []
    return [
      {
        session: {
          id: `live-${selected.icao}`,
          icao: selected.icao,
          callsigns: selected.callsign ? [selected.callsign] : [],
          registration: selected.registration,
          typeCode: selected.typeCode,
          operator: selected.operator,
          startedAt: selected.trail[0]?.recordedAt ?? new Date().toISOString(),
          endedAt: null,
          sampleCount: selected.trail.length,
          minimumAltitudeFt: null,
          maximumAltitudeFt: null,
          maximumSpeedKt: null,
          closestDistanceNm: selected.distanceNm,
          hasDetailedTrack: true,
          alertKinds: [],
        },
        resolution: '1s',
        points: selected.trail,
        events: [],
        truncated: false,
      },
    ]
  }, [mapDisplay.trailMinutes, selected, selectedTrack])

  /*
   * Selection is not navigation: it replaces the current entry rather than
   * pushing one, so Back leaves the page instead of walking twenty aircraft
   * backwards, and it patches the query string rather than replacing it, so a
   * shared link keeps its viewport and the sender's filters.
   */
  // Stable so the memoised aircraft rows are not invalidated every render.
  const selectAircraft = useCallback(
    (icao: string) => {
      setSearchParams({ aircraft: icao }, true)
      setMobilePanel(null)
    },
    [setSearchParams],
  )

  // Stable so the keyboard listener below is not rebuilt on every render.
  const closeDetails = useCallback(() => {
    setSearchParams({ aircraft: null }, true)
  }, [setSearchParams])

  const dismissBanner = async () => {
    if (!bannerAlert) return
    setDismissingBanner(true)
    setBannerError(null)
    try {
      await api.dismissAlert(bannerAlert.id)
      dispatch({ type: 'dismiss-alert', id: bannerAlert.id })
    } catch (reason) {
      setBannerError(reason instanceof Error ? reason.message : 'Alert could not be dismissed')
    } finally {
      setDismissingBanner(false)
    }
  }

  const applySavedView = (configuration: SavedViewConfiguration) => {
    if (configuration.surface !== 'live') return
    setFilters(configuration.filters)
    setSort(configuration.sort)
    setMapLayers(configuration.mapLayers)
    setMapDisplay(configuration.display ?? defaultMapDisplay)
    if (configuration.viewport) mapRef.current?.applyViewport(configuration.viewport)
  }

  /*
   * A deep link — `?aircraft=…` from the palette, a shared selection — is an
   * explicit request, and the default view's filters could hide the aircraft it
   * names, so the URL wins.
   */
  useDefaultSavedView('live', searchParams.toString() !== '', applySavedView)

  /*
   * What a shared Live link has to reproduce: the viewport, the filters the
   * sender was looking through, and the aircraft they had selected. The link is
   * built on demand rather than written into the address bar continuously,
   * which keeps panning out of the history stack.
   */
  const liveShare = useMemo(
    () => ({
      surface: 'live',
      linkFor: (viewport: MapViewport | null) => {
        const url = new URL(shareUrl(viewport))
        for (const key of [...url.searchParams.keys()]) {
          if (key !== 'view' && key !== 'aircraft') url.searchParams.delete(key)
        }
        writeFiltersToParams(filters, url.searchParams)
        return url.toString()
      },
      caption: () => ({
        title: `${receiver?.name ?? 'Flightmap'} · Live traffic`,
        detail: [
          formatDateTime(new Date().toISOString()),
          `${filtered.length.toLocaleString('en-GB')} of ${aircraftList.length.toLocaleString('en-GB')} aircraft`,
          filterCount ? `${filterCount} filter${filterCount === 1 ? '' : 's'} applied` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    }),
    [aircraftList.length, filterCount, filtered.length, filters, receiver?.name],
  )

  // Commands raised by the command palette, which lives in the app shell and
  // can reach neither this page's state nor the map's imperative handle.
  useAppCommands((command) => {
    if (command.type === 'apply-saved-view') {
      if (command.configuration.surface !== 'live') return false
      applySavedView(command.configuration)
      return true
    }
    if (command.type === 'fit-aircraft') {
      mapRef.current?.fitAircraft()
      return true
    }
    if (command.type === 'centre-receiver') {
      mapRef.current?.centerReceiver()
      return true
    }
    setMapLayers((layers) => ({ ...layers, coverage: !layers.coverage }))
    return true
  })

  // The legend and the filter drawer are two views of one altitude filter:
  // isolating a band writes through here, and a range typed into the drawer
  // that matches a band lights that band up.
  const altitudeBand = bandForRange({
    minimum: filters.minimumAltitude,
    maximum: filters.maximumAltitude,
  })
  const isolateAltitudeBand = useCallback((band: AltitudeBand) => {
    setFilters((current) => {
      const range = toggleBand(band, {
        minimum: current.minimumAltitude,
        maximum: current.maximumAltitude,
      })
      return { ...current, minimumAltitude: range.minimum, maximumAltitude: range.maximum }
    })
  }, [])

  const moveSelection = useCallback(
    (move: SelectionMove) => {
      const index = nextSelectionIndex(
        filtered.findIndex((item) => item.icao === selectedIcao),
        filtered.length,
        move,
      )
      const next = index == null ? null : filtered[index]
      if (next) selectAircraft(next.icao)
    },
    [filtered, selectAircraft, selectedIcao],
  )

  // Every dependency is listed so the listener is installed once per change
  // rather than being torn down and rebuilt on each 1 Hz snapshot render.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // Every branch below is a single key, so a chord built on the same letter
      // belongs to the browser: ⌘A selects all, ⌘↑/⌘↓ walk the page.
      if (!isPlainKey(event) || isFormTarget(event.target)) return
      if (event.key === '/') {
        event.preventDefault()
        setListCollapsed(false)
        // The field floating over the map where the layout has one, otherwise
        // the list panel's own. `offsetParent` is null for whichever of the two
        // the breakpoint has taken out of the layout, which tells them apart
        // without this having to know the breakpoint.
        const field = mapSearchRef.current?.offsetParent ? mapSearchRef.current : searchInputRef.current
        field?.focus()
      } else if (event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setListCollapsed(false)
        document.querySelector<HTMLButtonElement>('.desktop-aircraft-panel .aircraft-identity')?.focus()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveSelection(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveSelection(-1)
      } else if (event.key === 'Home' && filtered.length) {
        event.preventDefault()
        moveSelection('first')
      } else if (event.key === 'End' && filtered.length) {
        event.preventDefault()
        moveSelection('last')
      } else if (event.key === 'Escape') {
        setShowFilters(false)
        setMobilePanel(null)
        if (selectedIcao) closeDetails()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [closeDetails, filtered.length, moveSelection, selectedIcao])

  return (
    <div
      ref={livePageRef}
      className={`live-page ${listCollapsed ? 'list-collapsed' : ''} ${selected ? 'has-detail' : ''} sheet-${sheetStop}`}
    >
      {bannerAlert ? (
        <div
          className={`alert-banner severity-${bannerAlert.severity}`}
          role={bannerAlert.severity === 'critical' ? 'alert' : 'status'}
        >
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>{bannerAlert.title}</strong>
            <span>
              {bannerAlert.callsign || bannerAlert.icao.toUpperCase()} · {bannerAlert.message}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void dismissBanner()}
            aria-label="Dismiss alert banner"
            disabled={dismissingBanner}
          >
            <X size={16} />
          </button>
        </div>
      ) : null}
      {bannerError ? <p className="live-inline-error" role="alert">{bannerError}</p> : null}

      {connection !== 'live' ? (
        <div className={`connection-banner connection-${connection}`} role="status">
          <WifiOff size={15} />
          <span>
            <strong>{connection === 'connecting' ? 'Connecting to receiver' : 'Live feed interrupted'}</strong>
            {hasSnapshot ? ' · Last snapshot remains on screen' : error ? ` · ${error}` : ''}
          </span>
        </div>
      ) : null}

      <section className="aircraft-panel desktop-aircraft-panel" aria-label="Live aircraft list">
        <div className="aircraft-panel-header">
          <div>
            <h1>
              Aircraft <span>{filtered.length}</span>
            </h1>
          </div>
          <button
            className="icon-button collapse-list"
            type="button"
            onClick={() => setListCollapsed(true)}
            aria-label="Collapse aircraft list"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        <div className="aircraft-toolbar">
          <label className="quick-search">
            <Search size={15} />
            <input
              ref={searchInputRef}
              value={filters.query}
              onChange={(event) => setFilters({ ...filters, query: event.target.value })}
              placeholder="Search aircraft"
              aria-label="Search aircraft"
            />
            {filters.query ? (
              <button
                type="button"
                onClick={() => setFilters({ ...filters, query: '' })}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            ) : null}
          </label>
          <button
            className={`filter-button ${filterCount ? 'active' : ''}`}
            type="button"
            onClick={() => setShowFilters((value) => !value)}
            aria-expanded={showFilters}
          >
            <SlidersHorizontal size={15} />
            Filters
            {filterCount ? <span>{filterCount}</span> : null}
          </button>
          <ColumnChooser columns={columns} onChange={setColumns} />
        </div>
        <AircraftTable
          aircraft={filtered}
          selectedIcao={selectedIcao}
          sort={sort}
          onSort={setSort}
          onSelect={selectAircraft}
          newSince={newSince}
          columns={columns}
          loading={!hasSnapshot}
          emptyTitle={aircraftList.length ? 'No aircraft match' : 'No aircraft reported'}
          emptyDescription={
            aircraftList.length
              ? 'Try widening the current filters.'
              : 'The latest receiver snapshot contains no current aircraft.'
          }
        />
        <footer className="aircraft-panel-footer">
          <span><i className="legend-dot live" /> {positionedCount} on map</span>
          <span>{aircraftList.length - positionedCount} no position</span>
        </footer>
      </section>

      {listCollapsed ? (
        <button
          className="expand-list-button"
          type="button"
          onClick={() => setListCollapsed(false)}
          aria-label="Open aircraft list"
        >
          <List size={17} />
          <span>{filtered.length}</span>
        </button>
      ) : null}

      {showFilters ? (
        <>
          <button
            type="button"
            className="filter-backdrop"
            onClick={() => setShowFilters(false)}
            aria-label="Close filters"
          />
          <aside
            ref={filtersDialogRef}
            className="filters-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Aircraft filters"
          >
            <AircraftFilters
              filters={filters}
              sources={sources}
              categories={categories}
              newSightingsEnabled={newSince != null}
              onChange={setFilters}
              onClose={() => setShowFilters(false)}
            />
          </aside>
        </>
      ) : null}

      <section ref={mapStageRef} className="map-stage" aria-label="Live receiver map">
        <RadarMap
          ref={mapRef}
          aircraft={aircraftList}
          receiver={receiver}
          selectedIcao={selectedIcao}
          onSelectAircraft={selectAircraft}
          onClearSelection={closeDetails}
          altitudeBand={altitudeBand?.key ?? null}
          onAltitudeBandChange={isolateAltitudeBand}
          tracks={trail}
          mapLayers={mapLayers}
          onMapLayersChange={setMapLayers}
          mapDisplay={mapDisplay}
          onMapDisplayChange={setMapDisplay}
          coverageCells={coverage.cells}
          airports={airports}
          trails={mapLayers.allTrails ? trails : undefined}
          initialViewport={sharedViewport}
          bottomInset={mapBottomInset}
          newSince={newSince}
          share={liveShare}
        />
        {trackError || coverage.error ? <p className="map-data-warning" role="status">{trackError ?? coverage.error}</p> : null}

        {/* Search led the redesign for the same reason it leads a maps app:
            the two things this page is opened for are "what is that overhead"
            and "where is this one aircraft", and only the second had no way in
            short of scrolling a list. It floats over the map on its own row,
            where the aircraft and filter buttons it replaces used to sit. */}
        <label className="map-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={mapSearchRef}
            value={filters.query}
            onChange={(event) => setFilters({ ...filters, query: event.target.value })}
            placeholder="Callsign, reg or type"
            aria-label="Search aircraft"
          />
          {filters.query ? (
            <button
              type="button"
              onClick={() => setFilters({ ...filters, query: '' })}
              aria-label="Clear search"
            >
              <X size={15} />
            </button>
          ) : null}
        </label>

        {/* The receiver state the hidden header used to carry, now saying what
            it is hearing as well as whether it is alive — the count the
            aircraft button used to hold. */}
        <div className="map-receiver-state" title={receiver?.lastSnapshotAt ?? 'Waiting for receiver'}>
          <span className={`status-dot status-${receiverState}`} aria-hidden="true" />
          <span className="map-receiver-copy">
            {receiver?.name ?? 'Receiver'} · {filtered.length} tracked
          </span>
          <span className="visually-hidden">{`Receiver ${receiverState}`}</span>
        </div>

        {selected ? (
          <div className="selected-map-card">
            <button type="button" className="back-control" onClick={closeDetails}>
              <ChevronLeft size={16} />
              Back
            </button>
            <Plane size={16} />
            <strong>{aircraftLabel(selected)}</strong>
            <span>{selected.altitudeBaro == null ? 'Altitude —' : formatAltitude(selected.altitudeBaro, units)}</span>
          </div>
        ) : null}
      </section>

      {/*
        The sheet is the page's second half rather than something summoned over
        it, and it is only ever showing one of two things: the traffic list, or
        the aircraft picked out of it. Both hang off one stop, so the grab
        handle means the same thing either way.
      */}
      {selected ? (
        <AircraftDetailPanel
          aircraft={selected}
          newSince={newSince}
          onClose={closeDetails}
          panelRef={detailPanelRef}
          sheet={sheet}
        />
      ) : (
        <aside ref={liveSheetRef} className="live-sheet" aria-label="Live aircraft">
          <button
            className="detail-sheet-handle"
            type="button"
            onClick={sheet.cycle}
            {...sheet.gestureProps}
          >
            <span className="detail-sheet-grip" aria-hidden="true" />
            <span className="visually-hidden">{nextStopLabel(sheetStop)}</span>
          </button>
          <div className="live-sheet-heading" {...sheet.gestureProps}>
            <span className="eyebrow">Overhead now</span>
            {/* The list has no column headers to hang sort arrows off at this
                width, so the ordering names itself and doubles as the way into
                the filters that decide what is being ordered. */}
            <button
              type="button"
              className={`live-sheet-order ${filterCount ? 'active' : ''}`}
              onClick={() => setMobilePanel(mobilePanel === 'filters' ? null : 'filters')}
              aria-expanded={mobilePanel === 'filters'}
              aria-label={
                filterCount
                  ? `${sortDescription(sort)}, ${filterCount} filter${filterCount === 1 ? '' : 's'} active. Open filters`
                  : `${sortDescription(sort)}. Open filters`
              }
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              <span>{sortDescription(sort)}</span>
              {filterCount ? <span className="action-count">{filterCount}</span> : null}
            </button>
          </div>
          <LiveSheetTraffic
            aircraft={filtered}
            selectedIcao={selectedIcao}
            onSelect={selectAircraft}
            newSince={newSince}
            loading={!hasSnapshot}
            emptyTitle={aircraftList.length ? 'No aircraft match' : 'No aircraft reported'}
            emptyDescription={
              aircraftList.length
                ? 'Try widening the current filters.'
                : 'The latest receiver snapshot contains no current aircraft.'
            }
          />
        </aside>
      )}

      {mobilePanel ? (
        <button
          className="mobile-sheet-backdrop"
          type="button"
          onClick={() => setMobilePanel(null)}
          aria-label="Close panel"
        />
      ) : null}
      <aside
        ref={mobileFiltersRef}
        className={`mobile-sheet mobile-filter-sheet ${mobilePanel === 'filters' ? 'open' : ''}`}
        role="dialog"
        aria-modal={mobilePanel === 'filters'}
        aria-label="Aircraft filters"
        aria-hidden={mobilePanel !== 'filters'}
        inert={mobilePanel !== 'filters'}
      >
        <div className="sheet-handle" />
        <AircraftFilters
          filters={filters}
          sources={sources}
          categories={categories}
          newSightingsEnabled={newSince != null}
          onChange={setFilters}
          onClose={() => setMobilePanel(null)}
        />
      </aside>
    </div>
  )
}
