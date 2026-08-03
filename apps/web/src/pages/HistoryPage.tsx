import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SavedViewConfiguration } from '@flightmap/shared'
import {
  CalendarClock,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  Database,
  FastForward,
  MapPinned,
  Pause,
  Play,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import { RadarMap } from '../components/RadarMap'
import { FlightProfile } from '../components/FlightProfile'
import type { RadarMapHandle } from '../components/RadarMap'
import { SavedViewsControl } from '../components/SavedViewsControl'
import { isFormTarget } from '../components/KeyboardShortcuts'
import { api } from '../lib/api'
import { Link, useLocation } from '../lib/router'
import { useCoverageCells, useMapLayers } from '../lib/map-preferences'
import {
  dateTimeInputToIso,
  formatAltitude,
  formatDate,
  formatDateTimeInput,
  formatDistance,
  formatDuration,
  formatTime,
} from '../lib/format'
import type {
  HistoricalSummary,
  HistoryFilters,
  SessionSummary,
  TrackResponse,
} from '../types'

const SPEEDS = [1, 5, 20, 60] as const
type Resolution = 'auto' | '1s' | '5s' | '15s' | '60s'

function defaultFilters(query = ''): HistoryFilters {
  const now = new Date()
  return {
    query,
    icao: '',
    callsign: '',
    registration: '',
    type: '',
    operator: '',
    from: formatDateTimeInput(new Date(now.getTime() - 6 * 60 * 60_000)),
    to: formatDateTimeInput(now),
    alert: '',
  }
}

function filtersFromSearch(search: string): HistoryFilters {
  const params = new URLSearchParams(search)
  const defaults = defaultFilters(params.get('aircraft') ?? '')
  const inputDate = (value: string | null, fallback: string) => {
    if (!value) return fallback
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? fallback : formatDateTimeInput(parsed)
  }
  const alert = params.get('alert')
  return {
    query: params.get('q') ?? defaults.query,
    icao: params.get('icao') ?? defaults.icao,
    callsign: params.get('callsign') ?? defaults.callsign,
    registration: params.get('registration') ?? defaults.registration,
    type: params.get('type') ?? defaults.type,
    operator: params.get('operator') ?? defaults.operator,
    from: inputDate(params.get('from'), defaults.from),
    to: inputDate(params.get('to'), defaults.to),
    alert: ['emergency_squawk', 'emergency_state', 'watchlist'].includes(alert ?? '')
      ? (alert as HistoryFilters['alert'])
      : '',
  }
}

function filtersSearch(filters: HistoryFilters): string {
  const params = new URLSearchParams()
  if (filters.query.trim()) params.set('q', filters.query.trim())
  if (filters.icao.trim()) params.set('icao', filters.icao.trim())
  if (filters.callsign.trim()) params.set('callsign', filters.callsign.trim())
  if (filters.registration.trim()) params.set('registration', filters.registration.trim())
  if (filters.type.trim()) params.set('type', filters.type.trim())
  if (filters.operator.trim()) params.set('operator', filters.operator.trim())
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.alert) params.set('alert', filters.alert)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function restoredTrackState(search: string) {
  const params = new URLSearchParams(search)
  const selectedSessionIds = [...new Set(params.getAll('session'))]
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    .slice(0, 8)
  const replay = params.get('replay')
  const replayTime = replay ? Date.parse(replay) : Number.NaN
  const candidateResolution = params.get('resolution')
  const resolution: Resolution = ['auto', '1s', '5s', '15s', '60s'].includes(candidateResolution ?? '')
    ? (candidateResolution as Resolution)
    : 'auto'
  return {
    selectedSessionIds,
    replayTime: Number.isFinite(replayTime) ? replayTime : null,
    resolution,
  }
}

export function historyUrl(
  filters: HistoryFilters,
  selectedSessionIds: string[],
  replayTime: number | null,
  resolution: Resolution,
) {
  const params = new URLSearchParams(filtersSearch(filters).replace(/^\?/, ''))
  for (const id of selectedSessionIds.slice(0, 8)) params.append('session', id)
  if (replayTime != null) params.set('replay', new Date(replayTime).toISOString())
  if (resolution !== 'auto') params.set('resolution', resolution)
  const query = params.toString()
  return `/history${query ? `?${query}` : ''}`
}

export function shouldShowSummarySection(
  visibleSummaryCount: number,
  nextCursor: string | null,
): boolean {
  return visibleSummaryCount > 0 || nextCursor !== null
}

function SessionCard({
  session,
  selected,
  loading,
  onToggle,
}: {
  session: SessionSummary
  selected: boolean
  loading: boolean
  onToggle: () => void
}) {
  const label = session.callsigns[0] || session.registration || session.icao.toUpperCase()
  return (
    <article className={`session-card ${selected ? 'selected' : ''}`}>
      <button type="button" onClick={onToggle} disabled={!session.hasDetailedTrack || loading}>
        <span className="session-select" aria-hidden="true">
          {loading ? <span className="mini-spinner" /> : selected ? <Check size={13} /> : null}
        </span>
        <span className="session-main">
          <span className="session-title">
            <strong>{label}</strong>
            <small>{session.registration || session.icao.toUpperCase()}</small>
            {session.alertKinds.length ? <span className="alert-tag">{session.alertKinds[0]?.replace('_', ' ')}</span> : null}
          </span>
          <span className="session-time">
            <span>{formatTime(session.startedAt)}</span>
            <i />
            <span>{session.endedAt ? formatTime(session.endedAt) : 'Active'}</span>
            <small>{formatDuration(session.startedAt, session.endedAt)}</small>
          </span>
          <span className="session-stats">
            <span><small>Altitude</small>{formatAltitude(session.maximumAltitudeFt)}</span>
            <span><small>Max speed</small>{session.maximumSpeedKt == null ? '—' : `${Math.round(session.maximumSpeedKt)} kt`}</span>
            <span><small>Closest</small>{formatDistance(session.closestDistanceNm)}</span>
            <span><small>Samples</small>{session.sampleCount.toLocaleString('en-GB')}</span>
          </span>
          {!session.hasDetailedTrack ? (
            <span className="expired-track">
              <Database size={13} /> Detailed track expired · summary retained
            </span>
          ) : null}
        </span>
        <ChevronRight size={16} className="session-chevron" />
      </button>
      <Link className="session-profile-link" to={`/aircraft/${session.icao}`}>Aircraft profile</Link>
    </article>
  )
}

function SummaryCard({ summary }: { summary: HistoricalSummary }) {
  return (
    <article className="summary-card">
      <div>
        <Database size={15} />
        <span>
          <strong>{summary.callsigns[0] || summary.registration || summary.icao.toUpperCase()}</strong>
          <small>{summary.registration || summary.icao.toUpperCase()} · {formatDate(summary.date)}</small>
        </span>
      </div>
      <dl>
        <div><dt>Observations</dt><dd>{summary.observationCount.toLocaleString('en-GB')}</dd></div>
        <div><dt>Sessions</dt><dd>{summary.sessionCount}</dd></div>
        <div><dt>Highest</dt><dd>{formatAltitude(summary.maximumAltitudeFt)}</dd></div>
        <div><dt>Closest</dt><dd>{formatDistance(summary.closestDistanceNm)}</dd></div>
      </dl>
      <p>
        {summary.hasDetailedTrack
          ? 'Daily summary · narrow the date range to select detailed tracks'
          : 'Summary retained · one-second track no longer available'}
      </p>
      <Link className="session-profile-link" to={`/aircraft/${summary.icao}`}>Aircraft profile</Link>
    </article>
  )
}

export function HistoryPage() {
  const { search: routeSearch, navigate } = useLocation()
  const [filters, setFilters] = useState<HistoryFilters>(() =>
    filtersFromSearch(routeSearch),
  )
  const [appliedFilters, setAppliedFilters] = useState<HistoryFilters>(filters)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [summaries, setSummaries] = useState<HistoricalSummary[]>([])
  const [sessionNextCursor, setSessionNextCursor] = useState<string | null>(null)
  const [summaryNextCursor, setSummaryNextCursor] = useState<string | null>(null)
  const [tracks, setTracks] = useState<Record<string, TrackResponse>>({})
  const [focusedTrackId, setFocusedTrackId] = useState<string | null>(null)
  const [trackLoading, setTrackLoading] = useState<Set<string>>(new Set())
  const [sessionLoading, setSessionLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingMoreSummaries, setLoadingMoreSummaries] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [trackError, setTrackError] = useState<string | null>(null)
  const [searchNotice, setSearchNotice] = useState<string | null>(null)
  const [resolution, setResolution] = useState<Resolution>('auto')
  const [replayTime, setReplayTime] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(5)
  const [follow, setFollow] = useState(false)
  const animationRef = useRef<number | null>(null)
  const historyMapRef = useRef<RadarMapHandle>(null)
  const historySearchRef = useRef<HTMLInputElement>(null)
  const [mapLayers, setMapLayers] = useMapLayers()
  const coverage = useCoverageCells(mapLayers.coverage)
  const lastFrameRef = useRef<number | null>(null)
  const searchGenerationRef = useRef(0)
  const searchAbortRef = useRef<AbortController | null>(null)
  const restoreAbortRef = useRef<AbortController | null>(null)
  const restoringUrlRef = useRef(false)
  const wideAppliedRange = useMemo(() => {
    try {
      return (
        Date.parse(dateTimeInputToIso(appliedFilters.to)) -
          Date.parse(dateTimeInputToIso(appliedFilters.from)) >
        32 * 86_400_000
      )
    } catch {
      return false
    }
  }, [appliedFilters.from, appliedFilters.to])

  const search = useCallback(async (nextFilters: HistoryFilters) => {
    const generation = ++searchGenerationRef.current
    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller
    setSessionError(null)
    setSummaryError(null)
    setTrackError(null)
    setSearchNotice(null)
    let from: string
    let to: string
    try {
      from = dateTimeInputToIso(nextFilters.from)
      to = dateTimeInputToIso(nextFilters.to)
      if (Date.parse(from) > Date.parse(to)) throw new Error('The start must be before the end.')
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Enter a valid range.'
      setSessionError(message)
      setSummaryError(message)
      setSessionLoading(false)
      setSummaryLoading(false)
      return
    }
    setTracks({})
    setReplayTime(null)
    setPlaying(false)

    const wideRange = Date.parse(to) - Date.parse(from) > 32 * 86_400_000
    if (wideRange) {
      setSessions([])
      setSessionNextCursor(null)
      setSessionLoading(false)
      setSearchNotice('Detailed sessions are limited to 32 days; retained daily summaries are shown.')
    } else {
      setSessionLoading(true)
      void api
        .sessions(nextFilters, null, controller.signal)
        .then((page) => {
          if (generation !== searchGenerationRef.current) return
          setSessions(page.sessions)
          setSessionNextCursor(page.nextCursor)
        })
        .catch((requestError) => {
          if (!controller.signal.aborted && generation === searchGenerationRef.current) {
            setSessionError(requestError instanceof Error ? requestError.message : 'Session search failed')
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && generation === searchGenerationRef.current) {
            setSessionLoading(false)
          }
        })
    }

    if (nextFilters.alert) {
      setSummaries([])
      setSummaryNextCursor(null)
      setSummaryLoading(false)
      setSearchNotice((notice) =>
        [notice, 'Daily summaries do not retain alert state, so only detailed sessions can be filtered by alert.']
          .filter(Boolean)
          .join(' '),
      )
    } else {
      setSummaryLoading(true)
      void api
        .summaries(nextFilters, null, controller.signal)
        .then((page) => {
          if (generation !== searchGenerationRef.current) return
          setSummaries(
            page.items.filter(
              (summary) => wideRange || !summary.hasDetailedTrack,
            ),
          )
          setSummaryNextCursor(page.nextCursor)
        })
        .catch((requestError) => {
          if (!controller.signal.aborted && generation === searchGenerationRef.current) {
            setSummaryError(requestError instanceof Error ? requestError.message : 'Summary search failed')
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && generation === searchGenerationRef.current) {
            setSummaryLoading(false)
          }
        })
    }
  }, [])

  const loadMoreSessions = async () => {
    if (!sessionNextCursor) return
    const generation = searchGenerationRef.current
    setLoadingMore(true)
    setSessionError(null)
    try {
      const page = await api.sessions(appliedFilters, sessionNextCursor)
      if (generation !== searchGenerationRef.current) return
      setSessions((current) => [...current, ...page.sessions])
      setSessionNextCursor(page.nextCursor)
    } catch (requestError) {
      setSessionError(requestError instanceof Error ? requestError.message : 'More sessions could not be loaded')
    } finally {
      setLoadingMore(false)
    }
  }

  const loadMoreSummaries = async () => {
    if (!summaryNextCursor) return
    const generation = searchGenerationRef.current
    setLoadingMoreSummaries(true)
    setSummaryError(null)
    try {
      const page = await api.summaries(appliedFilters, summaryNextCursor)
      if (generation !== searchGenerationRef.current) return
      const expired = page.items.filter(
        (summary) => wideAppliedRange || !summary.hasDetailedTrack,
      )
      setSummaries((current) => {
        const byId = new Map(current.map((summary) => [summary.id, summary]))
        for (const summary of expired) byId.set(summary.id, summary)
        return [...byId.values()]
      })
      setSummaryNextCursor(page.nextCursor)
    } catch (requestError) {
      setSummaryError(requestError instanceof Error ? requestError.message : 'More summaries could not be loaded')
    } finally {
      setLoadingMoreSummaries(false)
    }
  }

  useEffect(() => {
    const next = filtersFromSearch(routeSearch)
    const restored = restoredTrackState(routeSearch)
    restoringUrlRef.current = restored.selectedSessionIds.length > 0
    setFilters(next)
    setAppliedFilters(next)
    setResolution(restored.resolution)
    void search(next)
    restoreAbortRef.current?.abort()
    const controller = new AbortController()
    restoreAbortRef.current = controller
    if (restored.selectedSessionIds.length) {
      setTrackLoading(new Set(restored.selectedSessionIds))
      void Promise.allSettled(
        restored.selectedSessionIds.map((id) => api.track(id, restored.resolution, controller.signal)),
      ).then((results) => {
        if (controller.signal.aborted) return
        const restoredTracks = results.flatMap((result) =>
          result.status === 'fulfilled' ? [[result.value.session.id, result.value] as const] : [],
        )
        setTracks(Object.fromEntries(restoredTracks))
        setFocusedTrackId(restoredTracks[0]?.[0] ?? null)
        setReplayTime(restored.replayTime)
        if (restoredTracks.length !== restored.selectedSessionIds.length) {
          setTrackError('One or more shared tracks have expired or are no longer available.')
        }
        setTrackLoading(new Set())
        restoringUrlRef.current = false
      })
    } else {
      restoringUrlRef.current = false
    }
    return () => {
      searchAbortRef.current?.abort()
      controller.abort()
    }
  }, [routeSearch, search])

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    setAppliedFilters(filters)
    const nextSearch = filtersSearch(filters)
    if (routeSearch === nextSearch) void search(filters)
    else navigate(`/history${nextSearch}`)
  }

  const loadTrack = async (session: SessionSummary) => {
    if (tracks[session.id]) {
      setTracks((current) => {
        const next = { ...current }
        delete next[session.id]
        return next
      })
      if (focusedTrackId === session.id) {
        setFocusedTrackId(Object.keys(tracks).find((id) => id !== session.id) ?? null)
      }
      return
    }
    if (!session.hasDetailedTrack) return
    if (Object.keys(tracks).length >= 8) {
      setTrackError('You can compare up to eight tracks at once. Remove a selected track to add another.')
      return
    }
    setTrackLoading((current) => new Set(current).add(session.id))
    setTrackError(null)
    try {
      const track = await api.track(session.id, resolution)
      setTracks((current) => ({ ...current, [session.id]: track }))
      setFocusedTrackId(session.id)
    } catch (requestError) {
      setTrackError(requestError instanceof Error ? requestError.message : 'Track could not be loaded')
    } finally {
      setTrackLoading((current) => {
        const next = new Set(current)
        next.delete(session.id)
        return next
      })
    }
  }

  const selectedTracks = useMemo(() => Object.values(tracks), [tracks])
  const focusedTrack = focusedTrackId ? tracks[focusedTrackId] ?? null : null
  const selectedMetrics = useMemo(() => {
    const uniqueAircraft = new Set(selectedTracks.map((track) => track.session.icao)).size
    const samples = selectedTracks.reduce((total, track) => total + track.points.length, 0)
    const maximumAltitude = selectedTracks.reduce<number | null>((maximum, track) => {
      const value = track.session.maximumAltitudeFt
      return value == null ? maximum : maximum == null ? value : Math.max(maximum, value)
    }, null)
    let overlapping = false
    for (let left = 0; left < selectedTracks.length; left += 1) {
      const first = selectedTracks[left]!
      const firstStart = Date.parse(first.session.startedAt)
      const firstEnd = Date.parse(
        first.session.endedAt ?? first.points[first.points.length - 1]?.recordedAt ?? first.session.startedAt,
      )
      for (let right = left + 1; right < selectedTracks.length; right += 1) {
        const second = selectedTracks[right]!
        const secondStart = Date.parse(second.session.startedAt)
        const secondEnd = Date.parse(
          second.session.endedAt ?? second.points[second.points.length - 1]?.recordedAt ?? second.session.startedAt,
        )
        if (firstStart <= secondEnd && secondStart <= firstEnd) overlapping = true
      }
    }
    return { uniqueAircraft, samples, maximumAltitude, overlapping }
  }, [selectedTracks])
  const replayBounds = useMemo(() => {
    const times = selectedTracks.flatMap((track) =>
      track.points.length
        ? [
            new Date(track.points[0]!.recordedAt).getTime(),
            new Date(track.points[track.points.length - 1]!.recordedAt).getTime(),
          ]
        : [],
    )
    return times.length ? { start: Math.min(...times), end: Math.max(...times) } : null
  }, [selectedTracks])

  useEffect(() => {
    if (!replayBounds) {
      setReplayTime(null)
      setPlaying(false)
      return
    }
    setReplayTime((current) =>
      current == null || current < replayBounds.start || current > replayBounds.end
        ? replayBounds.start
        : current,
    )
  }, [replayBounds])

  useEffect(() => {
    if (!playing || !replayBounds) return
    const frame = (timestamp: number) => {
      const previous = lastFrameRef.current ?? timestamp
      lastFrameRef.current = timestamp
      setReplayTime((current) => {
        const next = (current ?? replayBounds.start) + (timestamp - previous) * speed
        if (next >= replayBounds.end) {
          setPlaying(false)
          return replayBounds.end
        }
        return next
      })
      animationRef.current = requestAnimationFrame(frame)
    }
    animationRef.current = requestAnimationFrame(frame)
    return () => {
      if (animationRef.current != null) cancelAnimationFrame(animationRef.current)
      lastFrameRef.current = null
    }
  }, [playing, speed, replayBounds])

  const replayTimeRef = useRef(replayTime)
  replayTimeRef.current = replayTime
  const writeUrl = useCallback(() => {
    if (restoringUrlRef.current) return
    window.history.replaceState(
      null,
      '',
      historyUrl(
        appliedFilters,
        selectedTracks.map((track) => track.session.id),
        replayTimeRef.current,
        resolution,
      ),
    )
  }, [appliedFilters, resolution, selectedTracks])
  const writeUrlRef = useRef(writeUrl)
  writeUrlRef.current = writeUrl

  // Filters, selection and resolution settle on their own debounce. Replay is
  // deliberately not a dependency: it advances every animation frame, and a
  // shared dependency would clear this timer before it could ever fire.
  useEffect(() => {
    const timer = window.setTimeout(() => writeUrlRef.current(), 300)
    return () => window.clearTimeout(timer)
  }, [appliedFilters, resolution, selectedTracks])

  // A playing replay is persisted on a fixed interval, and once more when it
  // stops, so the address bar stays close to the visible position without
  // rewriting it sixty times a second.
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => writeUrlRef.current(), 1_000)
    return () => {
      window.clearInterval(timer)
      writeUrlRef.current()
    }
  }, [playing])

  // Scrubbing while paused is a burst of changes that does settle.
  useEffect(() => {
    if (playing) return
    const timer = window.setTimeout(() => writeUrlRef.current(), 300)
    return () => window.clearTimeout(timer)
  }, [playing, replayTime])

  const clearTracks = () => {
    setTracks({})
    setFocusedTrackId(null)
    setReplayTime(null)
    setPlaying(false)
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (isFormTarget(event.target)) return
      if (event.key === '/') {
        event.preventDefault()
        historySearchRef.current?.focus()
      } else if (event.code === 'Space' && replayBounds) {
        event.preventDefault()
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setFollow(false)
        setPlaying((current) => !current)
      } else if (event.key.toLowerCase() === 'c' && selectedTracks.length) {
        event.preventDefault()
        clearTracks()
      } else if (event.key === 'Escape') {
        setPlaying(false)
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  })

  const applySavedView = (configuration: SavedViewConfiguration) => {
    if (configuration.surface !== 'history') return
    const nextFilters: HistoryFilters = {
      query: configuration.filters.query,
      icao: configuration.filters.icao,
      callsign: configuration.filters.callsign,
      registration: configuration.filters.registration,
      type: configuration.filters.type,
      operator: configuration.filters.operator,
      from: formatDateTimeInput(new Date(configuration.filters.from)),
      to: formatDateTimeInput(new Date(configuration.filters.to)),
      alert: configuration.filters.alert,
    }
    setMapLayers(configuration.mapLayers)
    navigate(
      historyUrl(nextFilters, configuration.selectedSessionIds, configuration.replayTime, configuration.resolution),
    )
    if (configuration.viewport) {
      const viewport = configuration.viewport
      window.setTimeout(() => historyMapRef.current?.applyViewport(viewport), 0)
    }
  }

  const changeResolution = async (value: Resolution) => {
    setResolution(value)
    const selectedIds = Object.keys(tracks)
    if (!selectedIds.length) return
    setTrackLoading(new Set(selectedIds))
    try {
      const refreshed = await Promise.all(
        selectedIds.map((id) => api.track(id, value).then((track) => [id, track] as const)),
      )
      setTracks(Object.fromEntries(refreshed))
    } catch (requestError) {
      setTrackError(requestError instanceof Error ? requestError.message : 'Track resolution update failed')
    } finally {
      setTrackLoading(new Set())
    }
  }

  return (
    <div className="history-page">
      <aside className="history-sidebar">
        <div className="page-heading">
          <span className="eyebrow">DETAILED ARCHIVE</span>
          <h1>Flight history</h1>
          <p>Search detailed tracks and indefinite receiver summaries.</p>
        </div>

        <form className="history-search" onSubmit={handleSubmit}>
          <label className="field search-field">
            <span>Aircraft</span>
            <span className="input-with-icon">
              <Search size={15} />
              <input
                ref={historySearchRef}
                value={filters.query}
                onChange={(event) => setFilters({ ...filters, query: event.target.value })}
                placeholder="ICAO, callsign, registration, type…"
              />
            </span>
          </label>
          <div className="field-pair">
            <label className="field">
              <span>From</span>
              <input
                type="datetime-local"
                value={filters.from}
                onChange={(event) => setFilters({ ...filters, from: event.target.value })}
              />
            </label>
            <label className="field">
              <span>To</span>
              <input
                type="datetime-local"
                value={filters.to}
                onChange={(event) => setFilters({ ...filters, to: event.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>Alert state</span>
            <select
              value={filters.alert}
              onChange={(event) =>
                setFilters({ ...filters, alert: event.target.value as HistoryFilters['alert'] })
              }
            >
              <option value="">All sessions</option>
              <option value="emergency_squawk">Emergency squawk</option>
              <option value="emergency_state">Emergency state</option>
              <option value="watchlist">Watchlist match</option>
            </select>
          </label>
          <details className="history-advanced-filters">
            <summary><SlidersHorizontal size={14} /> Exact aircraft filters</summary>
            <div className="history-filter-grid">
              <label className="field"><span>ICAO</span><input value={filters.icao} maxLength={6} onChange={(event) => setFilters({ ...filters, icao: event.target.value })} /></label>
              <label className="field"><span>Callsign</span><input value={filters.callsign} maxLength={16} onChange={(event) => setFilters({ ...filters, callsign: event.target.value })} /></label>
              <label className="field"><span>Registration</span><input value={filters.registration} maxLength={32} onChange={(event) => setFilters({ ...filters, registration: event.target.value })} /></label>
              <label className="field"><span>Type</span><input value={filters.type} maxLength={16} onChange={(event) => setFilters({ ...filters, type: event.target.value })} /></label>
              <label className="field history-filter-wide"><span>Operator</span><input value={filters.operator} maxLength={128} onChange={(event) => setFilters({ ...filters, operator: event.target.value })} /></label>
            </div>
          </details>
          <button
            className="primary-button full-width"
            type="submit"
            disabled={sessionLoading || summaryLoading}
          >
            <Search size={16} />
            {sessionLoading || summaryLoading ? 'Searching…' : 'Search history'}
          </button>
        </form>

        <div className="results-heading">
          <div>
            <h2>Track sessions</h2>
            <span>{sessions.length} results</span>
          </div>
          <label className="compact-select">
            <SlidersHorizontal size={13} />
            <select
              value={resolution}
              onChange={(event) => void changeResolution(event.target.value as Resolution)}
              aria-label="Track resolution"
            >
              <option value="auto">Adaptive</option>
              <option value="1s">Exact · 1 sec</option>
              <option value="5s">5 sec</option>
              <option value="15s">15 sec</option>
              <option value="60s">60 sec</option>
            </select>
          </label>
        </div>

        <div className="session-list" aria-live="polite">
          {sessionLoading ? (
            Array.from({ length: 4 }, (_, index) => <div className="session-skeleton" key={index} />)
          ) : sessions.length ? (
            sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                selected={Boolean(tracks[session.id])}
                loading={trackLoading.has(session.id)}
                onToggle={() => void loadTrack(session)}
              />
            ))
          ) : (
            <div className="empty-state">
              <Clock3 size={24} />
              <strong>No sessions found</strong>
              <span>Try a wider date range or fewer search terms.</span>
            </div>
          )}
          {sessionNextCursor ? (
            <button
              type="button"
              className="secondary-button full-width"
              disabled={loadingMore}
              onClick={() => void loadMoreSessions()}
            >
              {loadingMore ? 'Loading…' : 'Load more sessions'}
            </button>
          ) : null}
        </div>

        {summaryLoading ? (
          <div className="session-skeleton" aria-label="Loading retained summaries" />
        ) : shouldShowSummarySection(summaries.length, summaryNextCursor) ? (
          <section className="summary-results">
            <div className="results-heading">
              <div>
                <h2>{wideAppliedRange ? 'Daily summaries' : 'Older summaries'}</h2>
                <span>
                  {summaries.length
                    ? wideAppliedRange
                      ? 'Range overview'
                      : 'Details expired'
                    : 'More results available'}
                </span>
              </div>
            </div>
            {summaries.map((summary) => <SummaryCard key={summary.id} summary={summary} />)}
            {summaryNextCursor ? (
              <button
                type="button"
                className="secondary-button summary-load-more"
                disabled={loadingMoreSummaries}
                onClick={() => void loadMoreSummaries()}
              >
                {loadingMoreSummaries
                  ? 'Loading…'
                  : summaries.length
                    ? 'Load more summaries'
                    : 'Load older summaries'}
              </button>
            ) : null}
          </section>
        ) : null}
        {searchNotice ? <p className="history-notice" role="status">{searchNotice}</p> : null}
        {sessionError ? <div className="form-error retry-error" role="alert"><span>Sessions: {sessionError}</span><button type="button" onClick={() => void search(appliedFilters)}>Retry</button></div> : null}
        {summaryError ? <div className="form-error retry-error" role="alert"><span>Summaries: {summaryError}</span><button type="button" onClick={() => void search(appliedFilters)}>Retry</button></div> : null}
        {trackError ? <p className="form-error" role="alert">Track: {trackError}</p> : null}
      </aside>

      <section className="history-map-stage">
        <RadarMap
          ref={historyMapRef}
          tracks={selectedTracks}
          replayTime={replayTime}
          followReplay={follow}
          className="history-map"
          mapLayers={mapLayers}
          onMapLayersChange={setMapLayers}
          coverageCells={coverage.cells}
        />
        <SavedViewsControl
          surface="history"
          className="map-saved-views"
          configuration={() => ({
            surface: 'history',
            filters: {
              query: appliedFilters.query,
              icao: appliedFilters.icao,
              callsign: appliedFilters.callsign,
              registration: appliedFilters.registration,
              type: appliedFilters.type,
              operator: appliedFilters.operator,
              from: dateTimeInputToIso(appliedFilters.from),
              to: dateTimeInputToIso(appliedFilters.to),
              alert: appliedFilters.alert,
            },
            sort: 'started_desc',
            selectedSessionIds: selectedTracks.map((track) => track.session.id),
            resolution,
            replayTime,
            mapLayers,
            viewport: historyMapRef.current?.getViewport() ?? null,
          })}
          onApply={applySavedView}
        />
        {coverage.error ? <p className="map-data-warning" role="status">{coverage.error}</p> : null}
        {!selectedTracks.length ? (
          <div className="history-map-empty">
            <span><MapPinned size={22} /></span>
            <strong>Select a track to begin</strong>
            <p>Choose one or more sessions to compare their routes and replay movement.</p>
          </div>
        ) : null}
        {selectedTracks.some((track) => track.truncated) ? (
          <p className="map-data-warning" role="status">
            One or more tracks reached the 20,000-point display limit. Choose a coarser resolution
            to view the full route.
          </p>
        ) : null}

        {selectedTracks.length ? (
          <section className="selected-track-tray" aria-label="Selected tracks">
            <header>
              <div><span className="eyebrow">SELECTED</span><strong>{selectedTracks.length} track{selectedTracks.length === 1 ? '' : 's'}</strong></div>
              <button type="button" className="text-button" onClick={clearTracks}><Trash2 size={14} /> Clear all</button>
            </header>
            <div className="selected-track-chips">
              {selectedTracks.map((track) => (
                <article key={track.session.id}>
                  <button type="button" onClick={() => void loadTrack(track.session)} aria-label={`Remove ${track.session.callsigns[0] || track.session.icao} track`}>
                    <span><strong>{track.session.callsigns[0] || track.session.icao.toUpperCase()}</strong><small>{track.session.endedAt ? track.truncated ? 'Truncated' : formatDuration(track.session.startedAt, track.session.endedAt) : 'Active'}</small></span><span aria-hidden="true">×</span>
                  </button>
                  <span className="track-export-links">
                    <button type="button" aria-pressed={focusedTrackId === track.session.id} onClick={() => setFocusedTrackId((current) => current === track.session.id ? null : track.session.id)}>Profile</button>
                    <a download href={`/api/v1/exports/sessions/${encodeURIComponent(track.session.id)}?format=csv&resolution=${resolution}`} aria-label={`Export ${track.session.callsigns[0] || track.session.icao} telemetry as CSV`}>CSV</a>
                    <a download href={`/api/v1/exports/sessions/${encodeURIComponent(track.session.id)}?format=geojson&resolution=${resolution}`} aria-label={`Export ${track.session.callsigns[0] || track.session.icao} track as GeoJSON`}>GeoJSON</a>
                  </span>
                </article>
              ))}
            </div>
            <dl>
              <div><dt>Aircraft</dt><dd>{selectedMetrics.uniqueAircraft}</dd></div>
              <div><dt>Displayed points</dt><dd>{selectedMetrics.samples.toLocaleString('en-GB')}</dd></div>
              <div><dt>Highest</dt><dd>{formatAltitude(selectedMetrics.maximumAltitude)}</dd></div>
            </dl>
            {selectedMetrics.overlapping ? <p>Tracks overlap in time and can be replayed together.</p> : null}
          </section>
        ) : null}

        {focusedTrack ? (
          <FlightProfile
            track={focusedTrack}
            replayTime={replayTime}
            onReplayTime={(time) => {
              setPlaying(false)
              setReplayTime(time)
            }}
          />
        ) : null}

        {replayBounds && replayTime != null ? (
          <div className="replay-panel">
            <div className="replay-topline">
              <div>
                <span className="eyebrow">REPLAY</span>
                <strong>{formatDate(new Date(replayTime).toISOString())} · {formatTime(new Date(replayTime).toISOString())}</strong>
              </div>
              <div className="replay-track-count">
                <PlaneIcon />
                {selectedTracks.length} track{selectedTracks.length === 1 ? '' : 's'}
              </div>
            </div>
            <input
              className="time-slider"
              type="range"
              min={replayBounds.start}
              max={replayBounds.end}
              step={1000}
              value={replayTime}
              onChange={(event) => {
                setPlaying(false)
                setReplayTime(Number(event.target.value))
              }}
              aria-label="Replay position"
            />
            <div className="replay-ticks">
              <span>{formatTime(new Date(replayBounds.start).toISOString())}</span>
              <span>{formatTime(new Date(replayBounds.end).toISOString())}</span>
            </div>
            <div className="replay-controls">
              <button
                className="play-button"
                type="button"
                onClick={() => {
                  if (replayTime >= replayBounds.end) setReplayTime(replayBounds.start)
                  setPlaying((value) => !value)
                }}
                aria-label={playing ? 'Pause replay' : 'Play replay'}
              >
                {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  setPlaying(false)
                  setReplayTime(replayBounds.start)
                }}
                aria-label="Reset replay"
              >
                <CircleStop size={17} />
              </button>
              <div className="speed-control" aria-label="Replay speed">
                <FastForward size={15} />
                {SPEEDS.map((option) => (
                  <button
                    type="button"
                    key={option}
                    className={speed === option ? 'active' : ''}
                    onClick={() => setSpeed(option)}
                    aria-pressed={speed === option}
                  >
                    {option}×
                  </button>
                ))}
              </div>
              <label className="follow-toggle">
                <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
                <span>Follow aircraft</span>
              </label>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function PlaneIcon() {
  return <CalendarClock size={14} aria-hidden="true" />
}
