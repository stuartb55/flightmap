import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapViewport } from '@flightmap/shared'

/**
 * A style change replaces every layer, so the map is rebuilt rather than
 * patched — and a theme change is a style change. This exercises what the
 * replacement is aimed at, which is the only part of that rebuild a reader can
 * see: the camera has to resume where the previous map left off, not jump back
 * to the receiver or to the viewport a shared link carried.
 *
 * MapLibre needs a WebGL context jsdom does not have, so the module is stood in
 * for by a recorder of constructor options.
 */
const constructed = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const camera = vi.hoisted(() => ({
  center: { lng: 0, lat: 0 },
  zoom: 0,
  bearing: 0,
  pitch: 0,
}))

vi.mock('maplibre-gl', () => {
  class FakeMap {
    private readonly handlers = new Map<string, Array<() => void>>()
    constructor(options: Record<string, unknown>) {
      constructed.push(options)
      // The style loads on the next tick, as the real one does.
      queueMicrotask(() => this.handlers.get('load')?.forEach((handler) => handler()))
    }
    on(event: string, ...rest: unknown[]) {
      const handler = rest[rest.length - 1]
      if (typeof handler !== 'function') return this
      const list = this.handlers.get(event) ?? []
      list.push(handler as () => void)
      this.handlers.set(event, list)
      return this
    }
    once(event: string, handler: () => void) {
      return this.on(event, handler)
    }
    off() {
      return this
    }
    getCenter() {
      return camera.center
    }
    getZoom() {
      return camera.zoom
    }
    getBearing() {
      return camera.bearing
    }
    getPitch() {
      return camera.pitch
    }
    remove() {
      this.handlers.clear()
    }
    getCanvas() {
      return { style: {} } as unknown as HTMLCanvasElement
    }
    getContainer() {
      return document.createElement('div')
    }
    addControl() {
      return this
    }
    addSource() {
      return this
    }
    addLayer() {
      return this
    }
    addImage() {
      return this
    }
    hasImage() {
      return true
    }
    getSource() {
      return undefined
    }
    getLayer() {
      return undefined
    }
    setLayoutProperty() {
      return this
    }
    setPaintProperty() {
      return this
    }
    setFilter() {
      return this
    }
    setLayerZoomRange() {
      return this
    }
    setMissingStyleImageResolver() {
      return this
    }
    queryRenderedFeatures() {
      return []
    }
    easeTo() {
      return this
    }
    jumpTo() {
      return this
    }
    fitBounds() {
      return this
    }
    resize() {
      return this
    }
    triggerRepaint() {
      return this
    }
  }
  class FakeControl {
    setUnit() {}
    onAdd() {
      return document.createElement('div')
    }
    onRemove() {}
  }
  class FakePopup {
    setDOMContent() {
      return this
    }
    setLngLat() {
      return this
    }
    addTo() {
      return this
    }
    remove() {
      return this
    }
    isOpen() {
      return false
    }
  }
  class FakeBounds {
    extend() {
      return this
    }
    isEmpty() {
      return true
    }
  }
  return {
    Map: FakeMap,
    NavigationControl: FakeControl,
    ScaleControl: FakeControl,
    AttributionControl: FakeControl,
    Popup: FakePopup,
    LngLatBounds: FakeBounds,
    setWorkerUrl: () => undefined,
  }
})

import { RadarMap } from './RadarMap'
import { setAppearance } from '../lib/theme'

const sharedViewport: MapViewport = {
  longitude: -1.5,
  latitude: 51.2,
  zoom: 11,
  bearing: 45,
  pitch: 0,
}

function setTheme(theme: 'dark' | 'light') {
  setAppearance({ theme, density: 'comfortable' })
}

afterEach(cleanup)

describe('rebuilding the map on a style change', () => {
  beforeEach(() => {
    constructed.length = 0
    localStorage.clear()
    Object.assign(camera, {
      center: { lng: 0, lat: 0 },
      zoom: 0,
      bearing: 0,
      pitch: 0,
    })
  })

  it('resumes the camera where the previous map left off', async () => {
    setTheme('dark')
    const { rerender } = render(
      <RadarMap aircraft={[]} receiver={null} initialViewport={sharedViewport} />,
    )
    await waitFor(() => expect(constructed).toHaveLength(1))

    // The first map honours the link it was opened from.
    expect(constructed[0]).toMatchObject({
      center: [sharedViewport.longitude, sharedViewport.latitude],
      zoom: sharedViewport.zoom,
    })

    // The reader pans and zooms somewhere else, then the theme changes.
    Object.assign(camera, {
      center: { lng: -2.27, lat: 53.35 },
      zoom: 9.5,
      bearing: 12,
    })
    setTheme('light')
    rerender(<RadarMap aircraft={[]} receiver={null} initialViewport={sharedViewport} />)

    await waitFor(() => expect(constructed).toHaveLength(2))
    expect(constructed[1]).toMatchObject({
      center: [-2.27, 53.35],
      zoom: 9.5,
      bearing: 12,
    })
  })
})
