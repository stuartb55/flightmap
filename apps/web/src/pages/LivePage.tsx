import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
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
import type { SavedViewConfiguration } from '@flightmap/shared'
import { AircraftDetailPanel } from '../components/AircraftDetailPanel'
import { AircraftFilters } from '../components/AircraftFilters'
import { AircraftTable } from '../components/AircraftTable'
import { SavedViewsControl } from '../components/SavedViewsControl'
import { isFormTarget } from '../components/KeyboardShortcuts'
import { RadarMap, type RadarMapHandle } from '../components/RadarMap'
import { api } from '../lib/api'
import {
  activeFilterCount,
  defaultAircraftFilters,
  filterAircraft,
  sortAircraft,
  type AircraftFilters as AircraftFilterState,
  type AircraftSort,
} from '../lib/aircraft-filter'
import { aircraftLabel } from '../lib/format'
import { useSearchParams } from '../lib/router'
import { defaultMapDisplay, useCoverageCells, useMapDisplay, useMapLayers } from '../lib/map-preferences'
import { useLive } from '../state/LiveContext'
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

function useModalFocus(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!active || !ref.current) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = ref.current
    const focusable = () =>
      [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
      )].filter((element) => !element.hasAttribute('inert'))
    focusable()[0]?.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]!
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      previous?.focus({ preventScroll: true })
    }
  }, [active, ref])
}

export function LivePage() {
  const {
    aircraftList,
    receiver,
    connection,
    error,
    alerts,
    dispatch,
    hasSnapshot,
  } = useLive()
  const [searchParams, setSearchParams] = useSearchParams()
  const [filters, setFilters] = useState<AircraftFilterState>(storedFilters)
  const [sort, setSort] = useState<AircraftSort>({ key: 'distance', direction: 'asc' })
  const [listCollapsed, setListCollapsed] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null)
  const [selectedTrack, setSelectedTrack] = useState<TrackResponse | null>(null)
  const [trackError, setTrackError] = useState<string | null>(null)
  const [bannerError, setBannerError] = useState<string | null>(null)
  const [dismissingBanner, setDismissingBanner] = useState(false)
  const [mapLayers, setMapLayers] = useMapLayers()
  const [mapDisplay, setMapDisplay] = useMapDisplay()
  const coverage = useCoverageCells(mapLayers.coverage)
  const mapRef = useRef<RadarMapHandle>(null)
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
  const filtered = useMemo(
    () => sortAircraft(filterAircraft(aircraftList, filters), sort),
    [aircraftList, filters, sort],
  )
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

  const selectAircraft = (icao: string) => {
    setSearchParams({ aircraft: icao })
    setMobilePanel(null)
  }

  const closeDetails = () => {
    setSearchParams({})
  }

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
      } else if (event.key === 'Escape') {
        setShowFilters(false)
        setMobilePanel(null)
        if (selectedIcao) closeDetails()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  })

  return (
    <div
      ref={livePageRef}
      className={`live-page ${listCollapsed ? 'list-collapsed' : ''} ${selected ? 'has-detail' : ''}`}
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
        </div>
        <AircraftTable
          aircraft={filtered}
          selectedIcao={selectedIcao}
          sort={sort}
          onSort={setSort}
          onSelect={selectAircraft}
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
              onChange={setFilters}
              onClose={() => setShowFilters(false)}
            />
          </aside>
        </>
      ) : null}

      <section className="map-stage" aria-label="Live receiver map">
        <RadarMap
          ref={mapRef}
          aircraft={aircraftList}
          receiver={receiver}
          selectedIcao={selectedIcao}
          onSelectAircraft={selectAircraft}
          tracks={trail}
          mapLayers={mapLayers}
          onMapLayersChange={setMapLayers}
          mapDisplay={mapDisplay}
          onMapDisplayChange={setMapDisplay}
          coverageCells={coverage.cells}
        />
        <SavedViewsControl
          surface="live"
          className="map-saved-views"
          configuration={() => ({
            surface: 'live',
            filters,
            sort,
            display: mapDisplay,
            mapLayers,
            viewport: mapRef.current?.getViewport() ?? null,
          })}
          onApply={applySavedView}
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
            <span>{selected.altitudeBaro === 'ground' ? 'GND' : selected.altitudeBaro ? `${selected.altitudeBaro.toLocaleString()} ft` : 'Altitude —'}</span>
          </div>
        ) : null}
      </section>

      {selected ? <AircraftDetailPanel aircraft={selected} onClose={closeDetails} /> : null}

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
          onChange={setFilters}
          onClose={() => setMobilePanel(null)}
        />
      </aside>
    </div>
  )
}
