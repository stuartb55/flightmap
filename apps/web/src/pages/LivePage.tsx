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
  Filter,
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
import { ColumnChooser } from '../components/ColumnChooser'
import { isFormTarget } from '../components/KeyboardShortcuts'
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
  type SelectionMove,
} from '../lib/aircraft-filter'
import { shareUrl, viewportFromSearch } from '../lib/map-snapshot'
import { useOrderedAircraft } from '../lib/use-ordered-aircraft'
import { bandForRange, toggleBand, type AltitudeBand } from '../lib/altitude-bands'
import { aircraftLabel, formatAltitude, formatDateTime } from '../lib/format'
import { useUnitPreferences } from '../lib/unit-preferences'
import { useNewSightingCutoff } from '../lib/sighting-preferences'
import { useSearchParams } from '../lib/router'
import { useModalFocus } from '../lib/use-modal-focus'
import { useAppCommands } from '../lib/app-commands'
import { useDefaultSavedView } from '../lib/saved-views'
import { mobileColumns, useAircraftColumns } from '../lib/table-columns'
import { defaultMapDisplay, useCoverageCells, useMapDisplay, useMapLayers } from '../lib/map-preferences'
import { useLiveAircraft, useLiveDispatch, useLiveStatus } from '../state/LiveContext'
import type { AlertEvent, TrackResponse } from '../types'

type MobilePanel = 'list' | 'filters' | null
const FILTER_STORAGE_KEY = 'flightmap.aircraft-filters.v1'

export function emergencyBannerAlert(alerts: AlertEvent[]): AlertEvent | undefined {
  return alerts.find((alert) => alert.type === 'emergency' && !alert.dismissedAt)
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
  const { aircraftList, trails } = useLiveAircraft()
  const { receiver, connection, error, alerts, hasSnapshot } = useLiveStatus()
  const dispatch = useLiveDispatch()
  const [searchParams, setSearchParams] = useSearchParams()
  /*
   * A shared link outranks this browser's stored filters — someone opening it
   * is asking to see the sender's view, not their own — and the viewport it
   * carries is handed to the map at construction so there is no jump.
   */
  const [filters, setFilters] = useState<AircraftFilterState>(
    () => filtersFromParams(new URLSearchParams(window.location.search)) ?? storedFilters(),
  )
  const sharedViewport = useMemo(() => viewportFromSearch(window.location.search), [])
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
  const [detailExpanded, setDetailExpanded] = useState(false)
  const [mapBottomInset, setMapBottomInset] = useState(0)
  const coverage = useCoverageCells(mapLayers.coverage)
  const mapRef = useRef<RadarMapHandle>(null)
  const mapStageRef = useRef<HTMLElement>(null)
  const detailPanelRef = useRef<HTMLElement>(null)
  const livePageRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const filtersDialogRef = useRef<HTMLElement>(null)
  const mobileListRef = useRef<HTMLElement>(null)
  const mobileFiltersRef = useRef<HTMLElement>(null)

  useModalFocus(showFilters, filtersDialogRef, () => setShowFilters(false))
  useModalFocus(mobilePanel === 'list', mobileListRef, () => setMobilePanel(null))
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

  // Each aircraft opens at the collapsed stop: the point of the sheet is that
  // picking through traffic never buries the map.
  useEffect(() => {
    setDetailExpanded(false)
  }, [selectedIcao])

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
    const panel = detailPanelRef.current
    if (!stage || !panel) {
      setMapBottomInset(0)
      return
    }
    const measure = () => {
      const stageBox = stage.getBoundingClientRect()
      const panelBox = panel.getBoundingClientRect()
      livePageRef.current?.style.setProperty('--map-stage-height', `${Math.round(stageBox.height)}px`)
      const overlapsAcross = panelBox.left < stageBox.right - 1 && panelBox.right > stageBox.left + 1
      setMapBottomInset(
        overlapsAcross ? Math.max(0, Math.round(stageBox.bottom - panelBox.top)) : 0,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [detailExpanded, hasDetail])
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

  // Stable so the memoised aircraft rows are not invalidated every render.
  const selectAircraft = useCallback(
    (icao: string) => {
      setSearchParams({ aircraft: icao })
      setMobilePanel(null)
    },
    [setSearchParams],
  )

  // Stable so the keyboard listener below is not rebuilt on every render.
  const closeDetails = useCallback(() => {
    setSearchParams({})
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
      if (isFormTarget(event.target)) return
      if (event.key === '/') {
        event.preventDefault()
        setListCollapsed(false)
        searchInputRef.current?.focus()
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
      className={`live-page ${listCollapsed ? 'list-collapsed' : ''} ${selected ? 'has-detail' : ''} ${
        selected && detailExpanded ? 'detail-expanded' : ''
      }`}
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
          trails={mapLayers.allTrails ? trails : undefined}
          initialViewport={sharedViewport}
          bottomInset={mapBottomInset}
          newSince={newSince}
          share={liveShare}
        />
        {trackError || coverage.error ? <p className="map-data-warning" role="status">{trackError ?? coverage.error}</p> : null}
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

      {selected ? (
        <AircraftDetailPanel
          aircraft={selected}
          newSince={newSince}
          onClose={closeDetails}
          panelRef={detailPanelRef}
          expanded={detailExpanded}
          onToggleExpanded={() => setDetailExpanded((value) => !value)}
        />
      ) : null}

      <div className="mobile-map-actions">
        <button
          type="button"
          onClick={() => setMobilePanel(mobilePanel === 'list' ? null : 'list')}
          aria-expanded={mobilePanel === 'list'}
        >
          <List size={18} />
          Aircraft
          <span>{filtered.length}</span>
        </button>
        <button
          type="button"
          onClick={() => setMobilePanel(mobilePanel === 'filters' ? null : 'filters')}
          aria-expanded={mobilePanel === 'filters'}
        >
          <Filter size={18} />
          Filters
          {filterCount ? <span>{filterCount}</span> : null}
        </button>
      </div>

      {mobilePanel ? (
        <button
          className="mobile-sheet-backdrop"
          type="button"
          onClick={() => setMobilePanel(null)}
          aria-label="Close panel"
        />
      ) : null}
      <aside
        ref={mobileListRef}
        className={`mobile-sheet mobile-list-sheet ${mobilePanel === 'list' ? 'open' : ''}`}
        role="dialog"
        aria-modal={mobilePanel === 'list'}
        aria-label="Live aircraft list"
        aria-hidden={mobilePanel !== 'list'}
        inert={mobilePanel !== 'list'}
      >
        <div className="sheet-handle" />
        <div className="aircraft-panel-header">
          <div><h2>{filtered.length} aircraft</h2></div>
          <button className="icon-button" type="button" onClick={() => setMobilePanel(null)} aria-label="Close aircraft list"><X size={18} /></button>
        </div>
        <label className="quick-search mobile-search">
          <Search size={15} />
          <input
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
        <AircraftTable
          aircraft={filtered}
          selectedIcao={selectedIcao}
          sort={sort}
          onSort={setSort}
          onSelect={selectAircraft}
          newSince={newSince}
          columns={mobileColumns}
          loading={!hasSnapshot}
          emptyTitle={aircraftList.length ? 'No aircraft match' : 'No aircraft reported'}
          emptyDescription={
            aircraftList.length
              ? 'Try widening the current filters.'
              : 'The latest receiver snapshot contains no current aircraft.'
          }
        />
      </aside>
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
