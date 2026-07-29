type RuntimeConfig = {
  mapStyleUrl?: string
  receiverName?: string
  displayTimeZone?: string
  rangeRingsNm?: number[]
  authRequired?: boolean
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

export const DEFAULT_RECEIVER = {
  latitude: 53.61,
  longitude: -2.31,
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

export const AUTH_REQUIRED = runtime.authRequired ?? false
