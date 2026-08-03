import { useEffect, useRef } from 'react'
import type { SavedViewConfiguration } from '@flightmap/shared'

/**
 * A one-shot channel from the command palette to whichever page owns the
 * action. The palette lives in the app shell and cannot reach a page's state or
 * the map's imperative handle, and the target page is often not mounted yet
 * when the command is issued — selecting a History saved view from the Live
 * page navigates first.
 *
 * So an unclaimed command is held briefly and offered to pages as they mount.
 * A handler returns true when it has acted, which drops the command; anything
 * older than the window below is discarded rather than firing late.
 */
export type AppCommand =
  | { type: 'apply-saved-view'; configuration: SavedViewConfiguration }
  | { type: 'fit-aircraft' }
  | { type: 'centre-receiver' }
  | { type: 'toggle-coverage' }

export type AppCommandHandler = (command: AppCommand) => boolean

const PENDING_WINDOW_MS = 4_000

const handlers = new Set<AppCommandHandler>()
let pending: { command: AppCommand; at: number } | null = null

function offer(command: AppCommand, to: Iterable<AppCommandHandler>): boolean {
  for (const handler of to) {
    if (handler(command)) return true
  }
  return false
}

export function publishAppCommand(command: AppCommand): void {
  pending = offer(command, handlers) ? null : { command, at: Date.now() }
}

/** For tests: forget anything waiting for a page that never arrived. */
export function clearPendingAppCommand(): void {
  pending = null
}

export function useAppCommands(handler: AppCommandHandler): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    const stable: AppCommandHandler = (command) => handlerRef.current(command)
    handlers.add(stable)
    if (pending && Date.now() - pending.at <= PENDING_WINDOW_MS && stable(pending.command)) {
      pending = null
    }
    return () => {
      handlers.delete(stable)
    }
  }, [])
}
