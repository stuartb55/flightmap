import { useEffect, useRef, useState } from 'react'
import { Keyboard, X } from 'lucide-react'

export function isFormTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || Boolean(target.isContentEditable))
  )
}

const shortcuts = [
  ['/', 'Focus search'],
  ['A', 'Focus aircraft list'],
  ['Esc', 'Close the active panel'],
  ['Space', 'Play or pause history replay'],
  ['C', 'Clear selected history tracks'],
  ['?', 'Show this shortcut guide'],
] as const

export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === '?' && !isFormTarget(event.target)) {
        event.preventDefault()
        setOpen(true)
      } else if (event.key === 'Escape' && open) {
        event.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [open])
  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])
  return (
    <>
      <button type="button" className="icon-button shortcut-button" onClick={() => setOpen(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"><Keyboard size={17} /></button>
      {open ? (
        <div className="shortcut-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
          <section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
            <header><div><span className="eyebrow">KEYBOARD</span><h2 id="shortcut-title">Shortcuts</h2></div><button ref={closeRef} type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close shortcuts"><X size={17} /></button></header>
            <dl>{shortcuts.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl>
            <p>Shortcuts pause while focus is in a form control. Motion follows your reduced-motion preference.</p>
          </section>
        </div>
      ) : null}
    </>
  )
}
