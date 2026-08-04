import { describe, expect, it } from 'vitest'
import {
  copyToClipboard,
  shareUrl,
  snapshotFilename,
  viewportFromParam,
  viewportFromSearch,
  viewportToParam,
} from './map-snapshot'

const viewport = {
  longitude: -2.2751234,
  latitude: 53.6249876,
  zoom: 9.7381,
  bearing: 0,
  pitch: 0,
}

describe('shared map viewports', () => {
  it('round-trips a viewport through the parameter', () => {
    const restored = viewportFromParam(viewportToParam(viewport))
    expect(restored).toEqual({
      longitude: -2.27512,
      latitude: 53.62499,
      zoom: 9.74,
      bearing: 0,
      pitch: 0,
    })
  })

  // Five decimals is about a metre: far below what any zoom level resolves, so
  // the rounding cannot move the view someone was sent.
  it('rounds coordinates finely enough to be invisible', () => {
    expect(viewportToParam(viewport)).toBe('-2.27512,53.62499,9.74,0,0')
  })

  it('rejects a parameter that is missing, malformed, or out of range', () => {
    expect(viewportFromParam(null)).toBeNull()
    expect(viewportFromParam('')).toBeNull()
    expect(viewportFromParam('north,west')).toBeNull()
    expect(viewportFromParam('-2.27,53.62')).toBeNull()
    expect(viewportFromParam('-200,53.62,9')).toBeNull()
    expect(viewportFromParam('-2.27,120,9')).toBeNull()
    expect(viewportFromParam('-2.27,53.62,40')).toBeNull()
  })

  it('defaults a bearing and pitch that an older link did not carry', () => {
    expect(viewportFromParam('-2.27,53.62,9')).toMatchObject({ bearing: 0, pitch: 0 })
  })

  it('reads the viewport out of a query string', () => {
    expect(viewportFromSearch('?aircraft=abc123&view=-2.27,53.62,9')).toMatchObject({ zoom: 9 })
    expect(viewportFromSearch('?aircraft=abc123')).toBeNull()
  })

  it('keeps the rest of the URL and replaces any viewport already in it', () => {
    const location = { href: 'http://receiver.lan/history?session=abc&view=1,2,3' } as Location
    const url = new URL(shareUrl(viewport, location))
    expect(url.pathname).toBe('/history')
    expect(url.searchParams.get('session')).toBe('abc')
    expect(url.searchParams.get('view')).toBe('-2.27512,53.62499,9.74,0,0')
  })

  it('drops the viewport when there is no map to describe', () => {
    const location = { href: 'http://receiver.lan/?view=1,2,3' } as Location
    expect(new URL(shareUrl(null, location)).searchParams.has('view')).toBe(false)
  })
})

describe('snapshot naming and clipboard', () => {
  it('names the file after the surface and the moment', () => {
    expect(snapshotFilename('live', new Date('2026-08-04T15:12:30.000Z'))).toBe(
      'flightmap-live-2026-08-04T15-12-30.png',
    )
  })

  /*
   * A LAN deployment is http://, where `navigator.clipboard` is undefined. That
   * has to come back as a plain false so the caller can offer the link to be
   * copied by hand, rather than throwing into a promise nobody awaited.
   */
  it('reports failure rather than throwing where there is no clipboard', async () => {
    const original = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    expect(await copyToClipboard('http://receiver.lan/')).toBe(false)

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    })
    expect(await copyToClipboard('http://receiver.lan/')).toBe(false)

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    })
    expect(await copyToClipboard('http://receiver.lan/')).toBe(true)
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true })
  })
})
