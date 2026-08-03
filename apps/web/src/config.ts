import { mapWaypointSchema } from '@flightmap/shared'
import type { MapWaypoint } from '@flightmap/shared'

type RuntimeConfig = {
  mapStyleUrl?: string
  receiverName?: string
  receiverLatitude?: number | null
  receiverLongitude?: number | null
  displayTimeZone?: string
  rangeRingsNm?: number[]
  mapWaypoints?: unknown
}

function runtimeConfig(): RuntimeConfig {
  const content = document
    .querySelector<HTMLMetaElement>('meta[name="flightmap-config"]')
    ?.getAttribute('content')
  if (!content) return {}
  try {
    const parsed = JSON.parse(decodeURIComponent(content)) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as RuntimeConfig) : {}
  } catch {
    return {}
  }
}

const runtime = runtimeConfig()

// Only used until the receiver reports its own position, and only when none is
// configured. Zero/zero would put an unconfigured install in the Atlantic.
const FALLBACK_MAP_CENTRE = { latitude: 53.61, longitude: -2.31 }

export const DEFAULT_RECEIVER = {
  latitude: runtime.receiverLatitude ?? FALLBACK_MAP_CENTRE.latitude,
  longitude: runtime.receiverLongitude ?? FALLBACK_MAP_CENTRE.longitude,
  name: runtime.receiverName ?? 'Home receiver',
}

export const MAP_STYLE_URL =
  runtime.mapStyleUrl ?? import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/dark'

export const DISPLAY_TIME_ZONE =
  runtime.displayTimeZone ?? import.meta.env.VITE_DISPLAY_TIME_ZONE ?? 'Europe/London'

export const RANGE_RINGS_NM =
  runtime.rangeRingsNm?.filter(
    (distance) => Number.isFinite(distance) && distance > 0,
  ) ?? [10, 20, 40, 80]

export const MAP_WAYPOINTS: readonly MapWaypoint[] = Array.isArray(runtime.mapWaypoints)
  ? runtime.mapWaypoints.flatMap((waypoint) => {
      const parsed = mapWaypointSchema.safeParse(waypoint)
      return parsed.success ? [parsed.data] : []
    })
  : []
