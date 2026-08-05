import { afterEach, describe, expect, it } from 'vitest'
import {
  chartDataUri,
  copyToClipboard,
  rasteriseChart,
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

/*
 * A chart is drawn entirely by the stylesheet, so a clone lifted out of the
 * document has no paint at all. Everything the picture shows depends on that
 * paint being carried across before it is serialised.
 */
describe('chart snapshots', () => {
  function chart(markup: string): SVGSVGElement {
    const host = document.createElement('div')
    host.innerHTML = `<svg viewBox="0 0 100 50">${markup}</svg>`
    const svg = host.querySelector('svg') as unknown as SVGSVGElement
    document.body.append(host)
    return svg
  }

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('carries the computed paint onto the standalone document', () => {
    const style = document.createElement('style')
    style.textContent = '.bar { fill: rgb(1, 2, 3); stroke-width: 4px; }'
    document.head.append(style)
    const svg = chart('<rect class="bar" width="10" height="10" />')

    const markup = decodeURIComponent(chartDataUri(svg) ?? '')
    expect(markup).toContain('rgb(1, 2, 3)')
    expect(markup).toContain('stroke-width: 4px')
    // Standalone means standalone: without the namespace the browser refuses
    // to load it as an image at all.
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"')
    // The viewBox is the drawing size; an image needs it stated outright.
    expect(markup).toContain('width="100"')
    expect(markup).toContain('height="50"')
    style.remove()
  })

  it('percent-encodes rather than base64, so degree signs survive', () => {
    const svg = chart('<text>0–5° north</text>')
    const uri = chartDataUri(svg) ?? ''
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(uri)).toContain('0–5° north')
  })

  it('declines a chart with nothing to draw into', async () => {
    const host = document.createElement('div')
    host.innerHTML = '<svg></svg>'
    const empty = host.querySelector('svg') as unknown as SVGSVGElement
    expect(chartDataUri(empty)).toBeNull()
    await expect(rasteriseChart(empty)).resolves.toBeNull()
  })
})
