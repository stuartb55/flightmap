import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { isFormTarget, isPlainKey, KeyboardShortcuts } from './KeyboardShortcuts'

afterEach(cleanup)

describe('keyboard shortcuts', () => {
  it('opens the discoverable guide with ? and closes it with Escape', () => {
    render(<KeyboardShortcuts />)
    fireEvent.keyDown(document, { key: '?' })
    expect(screen.getByRole('dialog', { name: 'Shortcuts' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not treat shortcuts as active while editing a form', () => {
    const input = document.createElement('input')
    const button = document.createElement('button')
    const paragraph = document.createElement('p')
    expect(isFormTarget(input)).toBe(true)
    expect(isFormTarget(button)).toBe(true)
    expect(isFormTarget(paragraph)).toBe(false)
  })

  it('leaves browser chords to the browser, but keeps Shift for ?', () => {
    expect(isPlainKey({ metaKey: false, ctrlKey: false, altKey: false })).toBe(true)
    expect(isPlainKey({ metaKey: true, ctrlKey: false, altKey: false })).toBe(false)
    expect(isPlainKey({ metaKey: false, ctrlKey: true, altKey: false })).toBe(false)
    expect(isPlainKey({ metaKey: false, ctrlKey: false, altKey: true })).toBe(false)
  })

  it('does not open the guide when ? arrives as part of a chord', () => {
    render(<KeyboardShortcuts />)
    fireEvent.keyDown(document, { key: '?', ctrlKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: '?', shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'Shortcuts' })).toBeInTheDocument()
  })
})
