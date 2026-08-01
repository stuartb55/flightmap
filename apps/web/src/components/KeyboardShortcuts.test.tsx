import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { isFormTarget, KeyboardShortcuts } from './KeyboardShortcuts'

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
})
