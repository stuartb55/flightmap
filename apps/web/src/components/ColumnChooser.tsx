import { Columns3, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  columnDefinitions,
  defaultColumns,
  normaliseColumns,
  requiredColumn,
  type ColumnKey,
} from '../lib/table-columns'

interface Props {
  columns: readonly ColumnKey[]
  onChange: (columns: ColumnKey[]) => void
}

export function ColumnChooser({ columns, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      toggleRef.current?.focus()
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', keydown)
    }
  }, [open])

  const toggle = (key: ColumnKey, checked: boolean) => {
    const next = checked
      ? [...columns, key]
      : columns.filter((column) => column !== key)
    onChange(normaliseColumns(next))
  }

  // normaliseColumns emits a canonical order, so comparing position by position
  // catches a swapped column as well as an added or removed one.
  const modified =
    columns.length !== defaultColumns.length ||
    columns.some((key, index) => key !== defaultColumns[index])

  return (
    <div className="column-chooser" ref={containerRef}>
      <button
        ref={toggleRef}
        className={`filter-button ${modified ? 'active' : ''}`}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Choose table columns"
      >
        <Columns3 size={15} />
        Columns
        <span>{columns.length}</span>
      </button>
      {open ? (
        <div className="column-chooser-popover" role="dialog" aria-label="Table columns">
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">TABLE</span>
              <h2>Columns</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={() => {
                setOpen(false)
                toggleRef.current?.focus()
              }}
              aria-label="Close columns"
            >
              <X size={18} />
            </button>
          </div>
          <ul>
            {columnDefinitions.map((column) => {
              const checked = columns.includes(column.key)
              const locked = column.key === requiredColumn
              return (
                <li key={column.key}>
                  <label className={locked ? 'locked' : ''}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={(event) => toggle(column.key, event.target.checked)}
                    />
                    <span>
                      <strong>{column.label}</strong>
                      <small>{locked ? 'Always shown' : column.description}</small>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          <button
            className="secondary-button full-width"
            type="button"
            disabled={!modified}
            onClick={() => onChange([...defaultColumns])}
          >
            Reset to default columns
          </button>
        </div>
      ) : null}
    </div>
  )
}
