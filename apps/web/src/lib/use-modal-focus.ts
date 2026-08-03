import { useEffect, useRef, type RefObject } from 'react'

/**
 * Focus handling shared by every overlay: move focus into the dialog, keep Tab
 * inside it, close on Escape, and return focus to whatever opened it. Lives
 * here rather than beside one caller so the aircraft detail sheet and the
 * command palette cannot drift apart.
 */
export function useModalFocus(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!active || !ref.current) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = ref.current
    const focusable = () =>
      [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
      )].filter((element) => !element.hasAttribute('inert'))
    focusable()[0]?.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]!
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      previous?.focus({ preventScroll: true })
    }
  }, [active, ref])
}
