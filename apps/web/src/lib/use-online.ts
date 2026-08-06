import { useSyncExternalStore } from 'react'

/**
 * Whether the browser believes it has a network.
 *
 * `navigator.onLine` read during render is not reactive: it reports whatever
 * was true at the last render, so a notice built on it neither appears when
 * connectivity drops nor clears when it returns — it just reflects whatever
 * unrelated state change happened to re-render the page last.
 *
 * Online is the safe default where the property is missing. A browser that
 * cannot say should not be told it is offline.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

function snapshot(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true)
}
