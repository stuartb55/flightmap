import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('alerts API pagination', () => {
  it('propagates an opaque cursor and returns the server next cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [], nextCursor: 'next-page-token' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const page = await api.alertsPage(true, 'opaque+/=token')
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://flightmap.test')

    expect(requestUrl.pathname).toBe('/api/v1/alerts')
    expect(requestUrl.searchParams.get('cursor')).toBe('opaque+/=token')
    expect(requestUrl.searchParams.get('limit')).toBe('100')
    expect(requestUrl.searchParams.has('dismissed')).toBe(false)
    expect(page.nextCursor).toBe('next-page-token')
  })
})
