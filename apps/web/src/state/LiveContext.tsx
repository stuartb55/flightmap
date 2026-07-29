import {
  liveWebSocketMessageSchema,
} from '@flightmap/shared'
import {
  createContext,
  type Dispatch,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react'
import { api, liveSocketUrl } from '../lib/api'
import { adaptLiveMessage } from '../lib/adapters'
import type { WireLiveMessage } from '../lib/wire'
import type { Aircraft } from '../types'
import {
  initialLiveState,
  isSequenceGap,
  liveReducer,
  type LiveAction,
  type LiveState,
} from './live-reducer'

interface LiveContextValue extends LiveState {
  aircraftList: Aircraft[]
  refresh: () => Promise<void>
  dispatch: Dispatch<LiveAction>
}

const LiveContext = createContext<LiveContextValue | null>(null)

export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState)
  const stateRef = useRef(state)
  const generationRef = useRef(0)
  const retryRef = useRef(0)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current
    dispatch({ type: 'loading' })
    try {
      const snapshot = await api.live()
      if (generation !== generationRef.current) return
      dispatch({ type: 'snapshot', snapshot })
    } catch (error) {
      if (generation !== generationRef.current) return
      dispatch({
        type: 'offline',
        error: error instanceof Error ? error.message : 'Unable to load receiver snapshot',
      })
      throw error
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let socket: WebSocket | null = null
    let connecting = false
    let reconnectTimer: number | null = null
    let fallbackTimer: number | null = null

    const clearTimers = () => {
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      if (fallbackTimer != null) window.clearInterval(fallbackTimer)
    }

    const loadSnapshot = async (): Promise<boolean> => {
      try {
        const snapshot = await api.live()
        if (cancelled) return false
        dispatch({ type: 'snapshot', snapshot })
        stateRef.current = liveReducer(stateRef.current, { type: 'snapshot', snapshot })
        void api
          .alerts(false)
          .then((alerts) => {
            if (!cancelled) dispatch({ type: 'hydrate-alerts', alerts })
          })
          .catch(() => undefined)
        return true
      } catch (error) {
        if (!cancelled) {
          dispatch({
            type: 'offline',
            error: error instanceof Error ? error.message : 'Receiver snapshot is unavailable',
          })
        }
        return false
      }
    }

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer != null) return
      retryRef.current += 1
      const delay = Math.min(15_000, 750 * 2 ** Math.min(retryRef.current, 5))
      dispatch({ type: 'reconnecting', error: 'Live updates interrupted' })
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        void connect()
      }, delay)
      if (fallbackTimer == null) {
        fallbackTimer = window.setInterval(() => {
          void loadSnapshot()
        }, 5_000)
      }
    }

    const connect = async () => {
      if (
        cancelled ||
        connecting ||
        socket?.readyState === WebSocket.OPEN ||
        socket?.readyState === WebSocket.CONNECTING
      ) {
        return
      }
      connecting = true
      if (!stateRef.current.hasSnapshot && !(await loadSnapshot())) {
        connecting = false
        scheduleReconnect()
        return
      }
      if (cancelled) {
        connecting = false
        return
      }

      const activeSocket = new WebSocket(liveSocketUrl(stateRef.current.sequence))
      socket = activeSocket
      connecting = false
      activeSocket.addEventListener('open', () => {
        retryRef.current = 0
        if (fallbackTimer != null) {
          window.clearInterval(fallbackTimer)
          fallbackTimer = null
        }
        dispatch({ type: 'connected' })
      })
      activeSocket.addEventListener('message', (event) => {
        let message
        try {
          message = adaptLiveMessage(
            liveWebSocketMessageSchema.parse(JSON.parse(String(event.data))) as WireLiveMessage,
          )
        } catch {
          activeSocket.close(1002, 'Invalid live message')
          return
        }

        if (message.type === 'resync_required') {
          activeSocket.close(1000, 'Resynchronising')
          void loadSnapshot().then(() => {
            if (!cancelled) void connect()
          })
          return
        }
        if (message.type === 'hello') {
          if (message.sequence < stateRef.current.sequence) {
            activeSocket.close(1000, 'Stale live stream')
            scheduleReconnect()
          }
          return
        }
        if (message.sequence <= stateRef.current.sequence) return
        if (isSequenceGap(stateRef.current.sequence, message.sequence)) {
          activeSocket.close(1000, 'Sequence gap')
          void loadSnapshot().then(() => {
            if (!cancelled) void connect()
          })
          return
        }

        const action: LiveAction = {
          type: 'delta',
          sequence: message.sequence,
          generatedAt: message.generatedAt,
          upserts: message.upserts,
          removals: message.removals,
          receiver: message.receiver,
          alerts: message.alerts,
        }
        stateRef.current = liveReducer(stateRef.current, action)
        dispatch(action)
      })
      activeSocket.addEventListener('close', (event) => {
        if (socket === activeSocket) socket = null
        if (!cancelled && event.reason !== 'Resynchronising' && event.reason !== 'Sequence gap') {
          scheduleReconnect()
        }
      })
      activeSocket.addEventListener('error', () => activeSocket.close())
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && socket?.readyState !== WebSocket.OPEN) {
        if (reconnectTimer != null) {
          window.clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        void loadSnapshot().then(() => connect())
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    void connect()
    return () => {
      cancelled = true
      clearTimers()
      document.removeEventListener('visibilitychange', handleVisibility)
      socket?.close(1000, 'Unmounting')
    }
  }, [])

  const aircraftList = useMemo(
    () => Object.values(state.aircraft).sort((a, b) => a.icao.localeCompare(b.icao)),
    [state.aircraft],
  )
  const value = useMemo(
    () => ({ ...state, aircraftList, refresh, dispatch }),
    [state, aircraftList, refresh],
  )

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export function useLive(): LiveContextValue {
  const context = useContext(LiveContext)
  if (!context) throw new Error('useLive must be used inside LiveProvider')
  return context
}
