import type { MapViewport } from '@flightmap/shared'

/**
 * Sharing what the map is showing: the link that restores this exact view, and
 * a picture of it that carries its own context.
 *
 * A screenshot of the canvas alone is useless a week later — it says nothing
 * about which receiver, when, or where the map data came from — so every
 * snapshot is composed onto a caption strip carrying the receiver name, the
 * time in the display zone, what is on the map, and the tile attribution the
 * map itself shows in the corner.
 */

export interface SnapshotCaption {
  /** Receiver name and surface, e.g. "Home receiver · Live traffic". */
  title: string
  /** Time and what is shown, e.g. "4 Aug 2026, 15:12 · 128 aircraft". */
  detail: string
  /** The tile providers, verbatim from the map's attribution control. */
  attribution: string
}

/** Matches the compact attribution the map renders (`RadarMap`'s control). */
export const mapAttribution = '© OpenFreeMap © OpenMapTiles · Data from OpenStreetMap'

const VIEWPORT_PARAM = 'view'

/**
 * Longitude and latitude to five decimals — about a metre, far finer than any
 * viewport needs — keeps the parameter short enough to survive being pasted
 * into a chat window that wraps long links.
 */
export function viewportToParam(viewport: MapViewport): string {
  return [
    viewport.longitude.toFixed(5),
    viewport.latitude.toFixed(5),
    viewport.zoom.toFixed(2),
    Math.round(viewport.bearing),
    Math.round(viewport.pitch),
  ].join(',')
}

export function viewportFromParam(value: string | null): MapViewport | null {
  if (!value) return null
  const parts = value.split(',').map(Number)
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null
  const [longitude, latitude, zoom, bearing = 0, pitch = 0] = parts as number[]
  if (Math.abs(longitude!) > 180 || Math.abs(latitude!) > 90) return null
  if (zoom! < 0 || zoom! > 24) return null
  return {
    longitude: longitude!,
    latitude: latitude!,
    zoom: zoom!,
    bearing: Math.max(-360, Math.min(360, bearing)),
    pitch: Math.max(0, Math.min(85, pitch)),
  }
}

/**
 * The viewport is written into the URL only when a link is asked for. Writing
 * it on every pan would fill the history stack with entries nobody navigated
 * to, and the back button would walk the map rather than the page.
 */
export function shareUrl(viewport: MapViewport | null, location: Location = window.location): string {
  const url = new URL(location.href)
  if (viewport) url.searchParams.set(VIEWPORT_PARAM, viewportToParam(viewport))
  else url.searchParams.delete(VIEWPORT_PARAM)
  return url.toString()
}

export function viewportFromSearch(search: string): MapViewport | null {
  return viewportFromParam(new URLSearchParams(search).get(VIEWPORT_PARAM))
}

/**
 * True when the text reached the clipboard. A LAN deployment is normally
 * http://, where `navigator.clipboard` does not exist, so a false answer is an
 * ordinary outcome the caller has to show a fallback for — not an error.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function cssValue(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

const CAPTION_FONT =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

/**
 * Draws the captured map above a caption strip and returns the result as a
 * PNG blob. Sizes are multiplied by the source's device pixel ratio so the
 * caption is as sharp as the map on a retina display and legible at the
 * exported size on any other.
 */
export function composeSnapshot(
  source: HTMLCanvasElement,
  caption: SnapshotCaption,
  scale = window.devicePixelRatio || 1,
): Promise<Blob | null> {
  const pad = Math.round(16 * scale)
  const titleSize = Math.round(15 * scale)
  const detailSize = Math.round(13 * scale)
  const attributionSize = Math.round(11 * scale)
  const strip = pad * 2 + titleSize + detailSize + attributionSize + Math.round(14 * scale)

  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height + strip
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)

  context.drawImage(source, 0, 0)
  context.fillStyle = cssValue('--surface-3', '#0d1117')
  context.fillRect(0, source.height, canvas.width, strip)
  context.fillStyle = cssValue('--line-bright', 'rgba(255,255,255,0.2)')
  context.fillRect(0, source.height, canvas.width, Math.max(1, Math.round(scale)))

  let y = source.height + pad + titleSize
  context.textBaseline = 'alphabetic'
  context.fillStyle = cssValue('--text', '#e6edf3')
  context.font = `700 ${titleSize}px ${CAPTION_FONT}`
  context.fillText(caption.title, pad, y)

  y += Math.round(7 * scale) + detailSize
  context.fillStyle = cssValue('--muted-bright', '#b8c2cc')
  context.font = `500 ${detailSize}px ${CAPTION_FONT}`
  context.fillText(caption.detail, pad, y)

  y += Math.round(7 * scale) + attributionSize
  context.fillStyle = cssValue('--muted', '#8b949e')
  context.font = `400 ${attributionSize}px ${CAPTION_FONT}`
  context.fillText(caption.attribution, pad, y)

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Revoked on the next frame: Safari has not started the download when click
  // returns, and a revoked URL cancels it.
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}

export function snapshotFilename(surface: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `flightmap-${surface}-${stamp}.png`
}
