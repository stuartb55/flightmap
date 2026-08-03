import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aircraft, snapshot, wireAircraft } from '../test/fixtures'

const apiMock = vi.hoisted(() => ({
  live: vi.fn(),
  alerts: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  api: apiMock,
  liveSocketUrl: (sequence: number) => `ws://localhost/api/v1/live?since=${sequence}`,
}))

import { LiveProvider, useLiveAircraft, useLiveStatus } from './LiveContext'

/** Minimal stand-in for the browser WebSocket the provider opens. */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readonly url: string
  readyState = 1
  closed: { code?: number; reason?: string } | null = null
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    this.closed = { code, reason }
    this.emit('close', { code, reason })
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  deliver(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) })
  }
}

function Probe() {
  const { aircraftList } = useLiveAircraft()
  const { connection, sequence, error } = useLiveStatus()
  return (
    <div>
      <span data-testid="connection">{connection}</span>
      <span data-testid="sequence">{sequence}</span>
      <span data-testid="error">{error ?? ''}</span>
      <ul>
        {aircraftList.map((item) => (
          <li key={item.icao} data-testid="row">
            {item.icao}:{String(item.altitudeBaro)}
          </li>
        ))}
      </ul>
    </div>
  )
}

async function mountProvider() {
  render(
    <LiveProvider>
      <Probe />
    </LiveProvider>,
  )
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
  const socket = FakeSocket.instances.at(-1)!
  act(() => socket.emit('open', {}))
  return socket
}

afterEach(cleanup)

describe('LiveProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    apiMock.live.mockResolvedValue(snapshot([aircraft({ icao: '406b90' })]))
    apiMock.alerts.mockResolvedValue([])
  })

  it('loads the REST snapshot, then applies live deltas', async () => {
    const socket = await mountProvider()
    expect(socket.url).toContain('since=10')
    expect(await screen.findByText('406b90:18000')).toBeInTheDocument()
    expect(screen.getByTestId('connection')).toHaveTextContent('live')

    act(() =>
      socket.deliver({
        type: 'delta',
        sequence: 11,
        generatedAt: '2026-07-29T12:00:01.000Z',
        upserts: [wireAircraft({ altitudeBarometricFt: 19_000 })],
        removals: [],
        alerts: [],
      }),
    )

    expect(await screen.findByText('406b90:19000')).toBeInTheDocument()
    expect(screen.getByTestId('sequence')).toHaveTextContent('11')
  })

  it('resnapshots when the server reports a sequence gap', async () => {
    const socket = await mountProvider()
    await screen.findByText('406b90:18000')

    act(() =>
      socket.deliver({
        type: 'delta',
        sequence: 20,
        generatedAt: '2026-07-29T12:00:10.000Z',
        upserts: [],
        removals: [],
        alerts: [],
      }),
    )

    expect(socket.closed?.reason).toBe('Sequence gap')
    await waitFor(() => expect(apiMock.live).toHaveBeenCalledTimes(2))
  })

  it('resnapshots when the server demands one', async () => {
    const socket = await mountProvider()
    await screen.findByText('406b90:18000')

    act(() =>
      socket.deliver({
        type: 'resync_required',
        sequence: 41,
        generatedAt: '2026-07-29T12:00:10.000Z',
      }),
    )

    expect(socket.closed?.reason).toBe('Resynchronising')
    await waitFor(() => expect(apiMock.live).toHaveBeenCalledTimes(2))
  })

  it('closes the socket on an unparseable message', async () => {
    const socket = await mountProvider()
    await screen.findByText('406b90:18000')

    act(() => socket.emit('message', { data: 'not json' }))
    expect(socket.closed?.reason).toBe('Invalid live message')
  })

  it('retries instead of opening a socket when the snapshot is unavailable', async () => {
    apiMock.live.mockRejectedValue(new Error('Receiver snapshot is unavailable'))
    render(
      <LiveProvider>
        <Probe />
      </LiveProvider>,
    )

    await waitFor(() => expect(apiMock.live).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('Live updates interrupted'),
    )
    expect(screen.getByTestId('connection')).toHaveTextContent('connecting')
    expect(FakeSocket.instances).toHaveLength(0)
  })
})
