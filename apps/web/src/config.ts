import { mapWaypointSchema } from '@flightmap/shared'
import type { MapWaypoint } from '@flightmap/shared'
import { useSyncExternalStore } from 'react'
import { useResolvedTheme } from './lib/theme'

type RuntimeConfigInput = {
  mapStyleUrl?: string
  mapStyleUrlLight?: string
  receiverName?: string
  receiverLatitude?: number | null
  receiverLongitude?: number | null
  displayTimeZone?: string
  rangeRingsNm?: number[]
  mapWaypoints?: unknown
}

export interface RuntimeConfig {
  mapStyleUrl: string
  mapStyleUrlLight: string
  displayTimeZone: string
  rangeRingsNm: readonly number[]
  mapWaypoints: readonly MapWaypoint[]
  receiver: { latitude: number; longitude: number; name: string }
}

// Only used until the receiver reports its own position, and only when none is
// configured. Zero/zero would put an unconfigured install in the Atlantic.
const FALLBACK_MAP_CENTRE = { latitude: 53.61, longitude: -2.31 }

function injectedConfig(): RuntimeConfigInput {
  const content =
    typeof document === 'undefined'
      ? null
      : document
          .querySelector<HTMLMetaElement>('meta[name="flightmap-config"]')
          ?.getAttribute('content')
  if (!content) return {}
  try {
    const parsed = JSON.parse(decodeURIComponent(content)) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as RuntimeConfigInput) : {}
  } catch {
    return {}
  }
}

function resolve(input: RuntimeConfigInput, previous?: RuntimeConfig): RuntimeConfig {
  const rings = input.rangeRingsNm?.filter(
    (distance) => Number.isFinite(distance) && distance > 0,
  )
  return {
    mapStyleUrl:
      input.mapStyleUrl ??
      previous?.mapStyleUrl ??
      import.meta.env.VITE_MAP_STYLE_URL ??
      'https://tiles.openfreemap.org/styles/dark',
    mapStyleUrlLight:
      input.mapStyleUrlLight ??
      previous?.mapStyleUrlLight ??
      import.meta.env.VITE_MAP_STYLE_URL_LIGHT ??
      'https://tiles.openfreemap.org/styles/bright',
    displayTimeZone:
      input.displayTimeZone ??
      previous?.displayTimeZone ??
      import.meta.env.VITE_DISPLAY_TIME_ZONE ??
      'Europe/London',
    rangeRingsNm: rings?.length ? rings : previous?.rangeRingsNm ?? [10, 20, 40, 80],
    mapWaypoints: Array.isArray(input.mapWaypoints)
      ? input.mapWaypoints.flatMap((waypoint) => {
          const parsed = mapWaypointSchema.safeParse(waypoint)
          return parsed.success ? [parsed.data] : []
        })
      : previous?.mapWaypoints ?? [],
    receiver: {
      latitude:
        input.receiverLatitude ?? previous?.receiver.latitude ?? FALLBACK_MAP_CENTRE.latitude,
      longitude:
        input.receiverLongitude ?? previous?.receiver.longitude ?? FALLBACK_MAP_CENTRE.longitude,
      name: input.receiverName ?? previous?.receiver.name ?? 'Home receiver',
    },
  }
}

let current = resolve(injectedConfig())
const listeners = new Set<() => void>()

export function runtimeConfig(): RuntimeConfig {
  return current
}

/**
 * Applies settings saved in the running app, so a changed map style, time
 * zone, range ring or waypoint set takes effect without a page reload.
 */
export function applyRuntimeConfig(input: RuntimeConfigInput): void {
  current = resolve(input, current)
  for (const listener of listeners) listener()
}

export function subscribeRuntimeConfig(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useRuntimeConfig(): RuntimeConfig {
  return useSyncExternalStore(subscribeRuntimeConfig, runtimeConfig, runtimeConfig)
}

/**
 * The map style that matches the theme in force. A dark basemap under a light
 * interface — or the reverse — is the one part of a theme switch CSS cannot
 * do, because the style is fetched rather than styled.
 */
export function useMapStyleUrl(): string {
  const config = useRuntimeConfig()
  return useResolvedTheme() === 'light' ? config.mapStyleUrlLight : config.mapStyleUrl
}

export function defaultReceiver(): RuntimeConfig['receiver'] {
  return current.receiver
}

export function displayTimeZone(): string {
  return current.displayTimeZone
}

export function rangeRingsNm(): readonly number[] {
  return current.rangeRingsNm
}

export function mapWaypoints(): readonly MapWaypoint[] {
  return current.mapWaypoints
}
